/**
 * Product detail page: open it, confirm it's purchasable, read the headline
 * price, and find the way into the seller list.
 */

import type { Locator, Page } from 'playwright';
import {
  BLOCKED_STATUSES,
  BLOCKED_TEXT,
  FULFILLED_BY_PATTERN_SOURCE,
  JSON_LD,
  MAIN_PRICE,
  PRICE_PATTERN_SOURCE,
  SEE_OTHER_SELLERS,
  SEE_OTHER_SELLERS_TEXT,
  UNAVAILABLE_TEXT,
  anyOf,
  sellersUrlForPid,
} from './selectors';
import { parsePrice, parseProductJsonLd, type ProductJsonLd } from './parser';
import {
  ScrapeError,
  dismissOverlays,
  log,
  pidFromUrl,
  waitFor,
  waitForPageSettled,
  withRetry,
} from './utils';
import type { ResolvedOptions } from './types';

/* --------------------------------------------------------------- openProduct */

/**
 * Navigate to the product URL and wait until it is actually usable — meaning
 * either the JSON-LD blob or a rendered price is present, not merely that the
 * `load` event fired. Flipkart hydrates the price widget after load.
 */
export async function openProduct(page: Page, productUrl: string, options: ResolvedOptions): Promise<void> {
  log.step('Opening product...');

  await withRetry(
    async () => {
      const response = await page.goto(productUrl, {
        waitUntil: 'domcontentloaded',
        timeout: options.navigationTimeout,
      });

      // Retrying a rate-limit immediately only digs the hole deeper, so this is
      // a ScrapeError — withRetry rethrows those untouched and the batch runner
      // backs off instead.
      const status = response?.status();
      if (status && (BLOCKED_STATUSES as readonly number[]).includes(status)) {
        throw new ScrapeError('BLOCKED', `Flipkart returned HTTP ${status}.`);
      }
    },
    { attempts: 3, description: 'product navigation' },
  );

  await waitForPageSettled(page, options.navigationTimeout);
  await dismissOverlays(page);

  // The fast path, and the one that fires for essentially every product:
  // script#jsonLD is server-rendered into the HTML, so it exists the instant
  // parsing finishes. Finding it means the page is a product page carrying a
  // price, which is the only thing the readiness check was ever asking. Reading
  // the body text to prove the same thing costs a full serialisation of a
  // ~900KB DOM, so it stays on the slow path below.
  if ((await page.locator(anyOf(JSON_LD)).count()) > 0) return;

  // No structured data. Now it matters whether this is a bot wall or a product
  // page whose markup moved, and both answers come out of the same read.
  const signals = await readPageSignals(page);
  assertNotBlockedIn(signals);

  const ready =
    signals.hasPrice ||
    (await waitFor(
      async () => {
        if ((await page.locator(anyOf(JSON_LD)).count()) > 0) return true;
        return (await readPageSignals(page)).hasPrice;
      },
      { timeoutMs: options.timeout, description: 'product content' },
    ));

  if (!ready) {
    // A bot wall renders fast and has no price, so it can arrive late enough to
    // miss the check above — look once more before blaming the selectors.
    assertNotBlockedIn(await readPageSignals(page));
    throw new ScrapeError('MAIN_PRICE_NOT_FOUND', 'Product page rendered no price or structured data.');
  }
}

/* --------------------------------------------------------------- page signals */

/** The three yes/no questions we ask of a page's visible text. */
export interface PageSignals {
  /** The BLOCKED_TEXT match within the opening screenful, if any. */
  blocked: string | null;
  /** The UNAVAILABLE_TEXT match anywhere in the body, if any. */
  unavailable: string | null;
  /** Whether any currency value is rendered at all. */
  hasPrice: boolean;
}

const NO_SIGNALS: PageSignals = { blocked: null, unavailable: null, hasPrice: false };

/**
 * Answer all three text questions about the page in one round-trip.
 *
 * This replaces what used to be up to three separate `body.innerText()` calls
 * per product — one for readiness, one for the bot wall, one for availability —
 * each of which forced a layout AND shipped the entire rendered text of a
 * ~900KB document back to Node so a regex could run over it here.
 *
 * The regexes run in the page instead, against a single `innerText`, and what
 * comes back over the wire is two short strings and a boolean. Same patterns,
 * same answers, a fraction of the cost.
 */
export async function readPageSignals(page: Page): Promise<PageSignals> {
  return page
    .evaluate(
      ({ blockedSource, unavailableSource, priceSource }) => {
        const text = document.body?.innerText ?? '';
        if (!text) return { blocked: null, unavailable: null, hasPrice: false };

        // Only the opening screenful for the bot wall — "captcha" can appear
        // legitimately deep in page furniture, but a real wall says so at once.
        const blocked = new RegExp(blockedSource, 'i').exec(text.slice(0, 2000));
        const unavailable = new RegExp(unavailableSource, 'i').exec(text);

        return {
          blocked: blocked ? blocked[0] : null,
          unavailable: unavailable ? unavailable[0] : null,
          hasPrice: new RegExp(priceSource).test(text),
        };
      },
      {
        blockedSource: BLOCKED_TEXT.source,
        unavailableSource: UNAVAILABLE_TEXT.source,
        priceSource: PRICE_PATTERN_SOURCE,
      },
    )
    .catch(() => NO_SIGNALS);
}

/**
 * Throw BLOCKED when the page is a captcha / rate-limit wall rather than a
 * product. Best-effort: an unreadable body is not treated as a block.
 */
export async function assertNotBlocked(page: Page): Promise<void> {
  assertNotBlockedIn(await readPageSignals(page));
}

/**
 * The same verdict, against signals the caller has already read.
 *
 * Separating the decision from the read is what lets one `readPageSignals` serve
 * the block check and the availability check together.
 */
export function assertNotBlockedIn(signals: PageSignals): void {
  if (signals.blocked) {
    throw new ScrapeError('BLOCKED', `Page looks like a bot wall (matched "${signals.blocked}").`);
  }
}

/* ------------------------------------------------------------- availability */

/** Returns a reason string when the product cannot be bought, else null. */
export async function checkAvailability(
  page: Page,
  jsonLd: ProductJsonLd | null,
  signals?: PageSignals,
): Promise<string | null> {
  if (jsonLd?.availability && /OutOfStock|SoldOut|Discontinued/i.test(jsonLd.availability)) {
    return `Structured data reports availability=${jsonLd.availability}`;
  }

  // Pass `signals` when the caller has already read them; the fallback keeps the
  // signature usable from callers that have not, such as the snapshot suite.
  const resolved = signals ?? (await readPageSignals(page));
  return resolved.unavailable ? `Page shows "${resolved.unavailable}"` : null;
}

/* ------------------------------------------------------------------ JSON-LD */

/** Read and parse the product's schema.org blob. Null when absent or malformed. */
export async function readProductJsonLd(page: Page): Promise<ProductJsonLd | null> {
  const scripts = page.locator(anyOf(JSON_LD));
  const count = await scripts.count();

  for (let i = 0; i < count; i++) {
    const raw = await scripts.nth(i).textContent().catch(() => null);
    if (!raw) continue;
    const parsed = parseProductJsonLd(raw);
    if (parsed) return parsed;
  }
  return null;
}

/* ------------------------------------------------------------- getMainPrice */

/**
 * Extract the current selling price shown on the product page.
 *
 * Three tiers, cheapest and most durable first:
 *   1. JSON-LD offers.price  — immune to CSS churn, exact.
 *   2. Known price classes   — fast, but the classes are generated hashes.
 *   3. Currency-regex sweep  — scans visible text near the top of the page.
 */
export async function getMainPrice(
  page: Page,
  jsonLd: ProductJsonLd | null,
  options: ResolvedOptions,
): Promise<number | null> {
  log.step('Reading main price...');

  if (jsonLd?.price != null) {
    log.info(`main price from structured data: ₹${jsonLd.price}`);
    return jsonLd.price;
  }

  const domPrice = await waitFor(
    async () => {
      const nodes = page.locator(anyOf(MAIN_PRICE));
      const count = await nodes.count();
      for (let i = 0; i < count; i++) {
        const price = parsePrice(await nodes.nth(i).textContent());
        if (price !== null) return price;
      }
      return null;
    },
    { timeoutMs: Math.min(options.timeout, 8_000), description: 'main price element' },
  );

  if (domPrice !== null) {
    log.info(`main price from DOM: ₹${domPrice}`);
    return domPrice;
  }

  const anchored = await priceAnchoredToTitle(page);
  if (anchored !== null) {
    log.warn(`main price recovered by title anchor: ₹${anchored} (selectors may need updating)`);
    return anchored;
  }

  return null;
}

/**
 * Last-resort price recovery, anchored to the product title.
 *
 * Deliberately NOT a whole-page sweep. The PDP opens with a sponsored carousel,
 * so the first currency value in the document is an *advert's* price — on the
 * captured page that is ₹265 against a true price of ₹236. Returning that would
 * silently corrupt every comparison, which is worse than returning nothing.
 *
 * The <h1> product title reliably precedes the buy-box, so the first currency
 * value following it in document order is the headline price. Values without a
 * currency symbol (the struck-through MRP renders as a bare "499") are skipped
 * by construction, since the pattern requires ₹/Rs/INR.
 */
async function priceAnchoredToTitle(page: Page): Promise<number | null> {
  const raw = await page
    .evaluate((pattern: string) => {
      const title = document.querySelector('h1');
      if (!title) return null;

      const priceRe = new RegExp(pattern);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let reachedTitle = false;

      while (walker.nextNode()) {
        const el = walker.currentNode as HTMLElement;
        if (!reachedTitle) {
          if (el === title || title.contains(el)) reachedTitle = true;
          continue;
        }
        // Leaf elements only: an ancestor's textContent concatenates the whole
        // buy-box and would match the wrong number.
        if (el.children.length > 0) continue;

        const text = (el.textContent ?? '').replace(/ /g, ' ').trim();
        if (!priceRe.test(text)) continue;

        const style = window.getComputedStyle(el);
        const decoration = `${style.textDecorationLine} ${style.textDecoration}`;
        if (decoration.includes('line-through')) continue;

        return text;
      }
      return null;
    }, PRICE_PATTERN_SOURCE)
    .catch(() => null);

  return parsePrice(raw);
}

/* ------------------------------------------------------------- fulfilled by */

/**
 * Read the PDP's "Fulfilled by <name>" line — the seller whose offer the page is
 * currently showing.
 *
 * Text-anchored rather than class-anchored: the line lives under generated
 * atomic classes that churn, but the copy itself is stable. Leaf nodes only, so
 * an ancestor wrapping the whole delivery block cannot match with its
 * concatenated text. Returns null when the page carries no such line.
 */
export async function getFulfilledBy(page: Page): Promise<string | null> {
  const raw = await page
    .evaluate((pattern: string) => {
      const re = new RegExp(pattern, 'i');

      for (const el of Array.from(document.querySelectorAll<HTMLElement>('div, span, p, li'))) {
        if (el.children.length > 0) continue;
        const text = (el.textContent ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
        const match = re.exec(text);
        if (match?.[1]) return match[1];
      }
      return null;
    }, FULFILLED_BY_PATTERN_SOURCE)
    .catch(() => null);

  const name = raw?.trim();
  return name ? name : null;
}

/* --------------------------------------------------- seller list entry point */

export interface SellerListEntry {
  /** Locator for the "See other sellers" control, when one is on the page. */
  link: Locator | null;
  /** Absolute /sellers?pid=... URL, when we could derive one. */
  url: string | null;
  /**
   * The product page this entry came from.
   *
   * Needed because the direct-navigation path leaves the PDP: a Locator is
   * lazy and resolves against whatever page is loaded when it is finally used,
   * so after navigating to /sellers the `link` above would be queried against
   * the seller page and find nothing. The click fallback has to come home first.
   */
  productUrl: string;
}

/**
 * Locate the route into the seller list.
 *
 * On the captured PDP this control is a plain anchor:
 *   <a href="/sellers?pid=KMTHGNNHMYWQHJN7">See other sellers</a>
 *
 * Because it is a real link, we can skip the click entirely and navigate — that
 * is both faster and immune to overlays intercepting the click. We still return
 * the locator so the caller can click when it prefers to.
 *
 * When `knownPid` is supplied the URL needs no lookup at all. The seller list is
 * addressable as /sellers?pid=<FSN>, and a batch already knows every FSN from
 * its inputs file — across 1010 recorded products the FSN matched the pid in the
 * product URL every single time. Querying the DOM for a link to an address we
 * can already write down is a round-trip and a failure mode for nothing.
 */
export async function findSellerListEntry(
  page: Page,
  jsonLd: ProductJsonLd | null,
  productUrl: string,
  knownPid?: string,
): Promise<SellerListEntry> {
  if (knownPid) return { link: null, url: sellersUrlForPid(knownPid), productUrl };

  const byHref = page.locator(anyOf(SEE_OTHER_SELLERS)).first();
  if ((await byHref.count()) > 0) {
    const href = await byHref.getAttribute('href');
    return { link: byHref, url: href ? new URL(href, page.url()).toString() : null, productUrl };
  }

  const byText = page.getByText(SEE_OTHER_SELLERS_TEXT).first();
  if ((await byText.count()) > 0) {
    return { link: byText, url: null, productUrl };
  }

  // No control on the page — but the seller list is addressable by product id,
  // which we can get from structured data or the URL itself.
  const pid = jsonLd?.sku ?? pidFromUrl(productUrl) ?? pidFromUrl(page.url());
  return { link: null, url: pid ? sellersUrlForPid(pid) : null, productUrl };
}
