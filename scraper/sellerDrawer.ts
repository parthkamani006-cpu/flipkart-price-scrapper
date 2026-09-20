/**
 * The "See other sellers" list: open it, enumerate sellers, page through
 * "show more" until the target turns up, and read its price.
 *
 * Two capture paths run here:
 *   - network: opportunistically reuse any JSON payload that already carries
 *     seller records, avoiding the click loop entirely;
 *   - dom: scrape the rendered cards, which is the reliable fallback.
 */

import type { Locator, Page, Response } from 'playwright';
import {
  DOM_EXTRACTION_SELECTORS,
  SEE_OTHER_SELLERS,
  SEE_OTHER_SELLERS_TEXT,
  SELLER_API_URL_HINTS,
  SHOW_MORE,
  SHOW_MORE_TEXT,
  anyOf,
  type DomExtractionSelectors,
} from './selectors';
import { extractSellersFromJson, findSeller, parsePrice, sellerNamesMatch } from './parser';
import type { ResolvedOptions, SellerCard } from './types';
import { ScrapeError, delay, dismissOverlays, log, waitFor, waitForPageSettled, withRetry } from './utils';
import { assertNotBlocked, type SellerListEntry } from './productPage';

/* ----------------------------------------------------------- network capture */

export interface NetworkCapture {
  payloads: unknown[];
  detach: () => void;
}

/**
 * Record JSON responses that plausibly carry seller data.
 *
 * Flipkart has no documented seller API and the saved page snapshots contain no
 * server-rendered seller JSON, so this cannot be assumed to fire. It is a pure
 * accelerator: when it yields sellers we skip the entire click loop, and when it
 * yields nothing we DOM-scrape exactly as before.
 */
export function attachNetworkCapture(page: Page): NetworkCapture {
  const payloads: unknown[] = [];

  const onResponse = (response: Response): void => {
    const url = response.url();
    if (!SELLER_API_URL_HINTS.some((hint) => url.includes(hint))) return;

    const contentType = response.headers()['content-type'] ?? '';
    if (!contentType.includes('json')) return;

    // Fire-and-forget: never let body reading block or reject the page.
    void response
      .json()
      .then((body) => payloads.push(body))
      .catch(() => undefined);
  };

  page.on('response', onResponse);
  return { payloads, detach: () => page.off('response', onResponse) };
}

/** Pull seller records out of anything the sniffer collected. */
export function sellersFromNetwork(capture: NetworkCapture): SellerCard[] {
  const merged = new Map<string, SellerCard>();
  for (const payload of capture.payloads) {
    for (const seller of extractSellersFromJson(payload)) {
      const key = seller.name.toLowerCase();
      if (!merged.has(key)) merged.set(key, seller);
    }
  }
  return [...merged.values()];
}

/* -------------------------------------------------------- openSellerDrawer */

/**
 * Open the seller list.
 *
 * The control is a real anchor (`/sellers?pid=<FSN>`), so the default path is a
 * direct navigation — no click to be intercepted by a login interstitial, no
 * animation to wait out. Clicking is kept as the fallback for layouts where the
 * list opens as an in-page drawer instead.
 */
export async function openSellerDrawer(
  page: Page,
  entry: SellerListEntry,
  options: ResolvedOptions,
): Promise<void> {
  log.step('Opening seller drawer...');

  if (!entry.link && !entry.url) {
    throw new ScrapeError('NO_SELLER_LINK', 'No "See other sellers" control and no seller URL could be derived.');
  }

  const navigateDirect = async (): Promise<boolean> => {
    if (!entry.url) return false;
    log.info(`navigating directly to ${entry.url}`);
    await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeout });
    await waitForPageSettled(page, options.navigationTimeout);
    await dismissOverlays(page);
    return (await waitForSellerList(page, options)) > 0;
  };

  const clickThrough = async (): Promise<boolean> => {
    // A Locator resolves against whatever page is loaded when it is used, not
    // against the page it was created from. If direct navigation already ran and
    // failed, we are sitting on /sellers, where the PDP's link does not exist —
    // so come home before looking for it.
    if (!page.url().includes(entry.productUrl) && entry.productUrl !== page.url()) {
      const returned = await page
        .goto(entry.productUrl, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeout })
        .then(() => true)
        .catch(() => false);
      if (!returned) return false;
      await dismissOverlays(page);
    }

    // The entry may carry no locator at all — a batch derives the seller URL
    // straight from its known FSN and never queries the PDP for a link. Look for
    // one now that we are back on the product page.
    const link = entry.link ?? (await firstSellerLinkOn(page));
    if (!link) return false;

    log.info('clicking "See other sellers"');
    await link.scrollIntoViewIfNeeded().catch(() => undefined);
    await link.click({ timeout: options.timeout });
    await waitForPageSettled(page, options.navigationTimeout);
    await dismissOverlays(page);
    return (await waitForSellerList(page, options)) > 0;
  };

  const [first, second] = options.preferDirectSellerNavigation
    ? [navigateDirect, clickThrough]
    : [clickThrough, navigateDirect];

  const opened = await withRetry(
    async () => (await first()) || (await second()),
    { attempts: 2, description: 'opening seller list' },
  );

  if (!opened) {
    // A bot wall renders no seller cards either, and it is the one explanation
    // that must not be filed as a load failure: BLOCKED pauses the whole pool,
    // SELLER_LIST_LOAD_FAILED just retries into the same wall. This used to be
    // covered by the product page having been checked on the way in; products
    // that skip that render arrive here with the question still open.
    await assertNotBlocked(page);
    throw new ScrapeError('SELLER_LIST_LOAD_FAILED', 'Seller list did not render any seller cards.');
  }
}

/** The "See other sellers" control on the page as it stands now, if there is one. */
async function firstSellerLinkOn(page: Page): Promise<Locator | null> {
  const byHref = page.locator(anyOf(SEE_OTHER_SELLERS)).first();
  if ((await byHref.count()) > 0) return byHref;

  const byText = page.getByText(SEE_OTHER_SELLERS_TEXT).first();
  if ((await byText.count()) > 0) return byText;

  return null;
}

/**
 * Block until the seller list has finished rendering. Returns how many cards
 * ended up on the page, or 0 on timeout.
 *
 * Two waits, and the second one matters as much as the first:
 *
 *   1. At least one card exists. Spinners keep the count at zero until content
 *      lands, so this is a real readiness check rather than a guessed sleep.
 *
 *   2. The count has stopped climbing. Flipkart streams long seller lists in
 *      chunks, so "some cards are present" is NOT "all cards are present". A
 *      45-seller listing was observed rendering 38 cards, and a scrape that read
 *      the list at that moment reported the target seller as absent — a wrong
 *      answer, indistinguishable from a genuinely delisted seller.
 *
 * This second wait used to happen by accident: the page also had ~90 images in
 * flight, and the time they took was enough for the remaining cards to arrive.
 * Dropping those images removed the delay and exposed the missing wait, so it is
 * now explicit. It costs a few hundred milliseconds on a list that is already
 * complete, which is the correct price for never truncating one that is not.
 */
export async function waitForSellerList(page: Page, options: ResolvedOptions): Promise<number> {
  const first = await waitFor(
    async () => {
      const count = await countSellerCards(page);
      return count > 0 ? count : null;
    },
    { timeoutMs: options.timeout, description: 'seller cards' },
  );
  if (!first) return 0;

  return settleSellerCount(page, first, options);
}

/** Poll until the card count holds still, and return the highest count seen. */
async function settleSellerCount(
  page: Page,
  startingCount: number,
  options: ResolvedOptions,
): Promise<number> {
  const POLL_MS = 150;
  /**
   * Consecutive quiet polls before the list counts as done growing.
   *
   * Scaled by pool size, and this is the reason the scraper knows how many
   * workers it has at all. Every worker's context competes for the same CPU, so
   * a chunk of cards that lands within 300ms on an idle machine can stall
   * far longer than that with twenty contexts rendering at once. Every other
   * wait in this file expires into a *failure* — an honest one, retryable
   * from the dashboard. This one expires into an *answer*: a list declared complete when
   * it was merely starved reads as "the seller is not selling this product",
   * which is indistinguishable from the truth and lands in the recommendations
   * as fact. So it is the wait that gets the slack when the pool is wide.
   *
   * Three workers keeps the original 300ms exactly; ten gets 1.2s, and the
   * twenty-worker default pool gets 2.1s. The settling deadline below is three
   * quiet windows wide, so it still clears the window it is guarding.
   */
  const QUIET_POLLS = 2 * Math.max(1, Math.ceil((options.concurrency || 1) / 3));

  let best = startingCount;
  let quiet = 0;
  // Capped well under the action timeout: this is a settling window, not a wait
  // for content that may never come — the content is already on screen. The cap
  // has to clear the quiet window itself, or a wide pool would hit the deadline
  // before it could ever record a quiet stretch.
  const deadline = Date.now() + Math.min(options.timeout, Math.max(5_000, POLL_MS * QUIET_POLLS * 3));

  while (Date.now() < deadline) {
    await delay(POLL_MS, options.signal);
    if (options.signal?.aborted) break;

    const current = await countSellerCards(page).catch(() => 0);
    if (current > best) {
      best = current;
      quiet = 0;
      continue;
    }
    if (++quiet >= QUIET_POLLS) break;
  }

  if (best > startingCount) {
    log.info(`seller list grew from ${startingCount} to ${best} while settling`);
  }
  return best;
}

/* ------------------------------------------------------------ DOM extraction */

/**
 * How many seller cards are rendered right now.
 *
 * Counts exactly what `extractSellers` would return — same card selectors, same
 * "a card with no name is not a card" rule — and stops there. It reads no
 * prices and calls no `getComputedStyle`.
 *
 * That distinction is the whole point. The settling loop below polls this every
 * 150ms, and it only ever used the *length* of the extraction; on a 45-seller
 * list the discarded work was two `getComputedStyle` calls per card per poll,
 * up to fourteen polls per product, on every worker at once. Style resolution is
 * the most expensive thing a page can be asked for, and paying for it here made
 * the pool starve itself — which widened the very window that was doing the
 * polling. Counting cheaply breaks that loop and leaves the answer identical.
 */
export async function countSellerCards(page: Page): Promise<number> {
  return page.evaluate((selectors: DomExtractionSelectors) => {
    const queryAll = (root: ParentNode, list: string[]): Element[] => {
      for (const selector of list) {
        const found = Array.from(root.querySelectorAll(selector));
        if (found.length > 0) return found;
      }
      return [];
    };

    let count = 0;
    for (const card of queryAll(document, selectors.card)) {
      const nameEl = queryAll(card, selectors.name)[0];
      // Same guard as extractSellers: a nameless card is a skeleton, not a
      // seller, and counting one would end the settle a poll early.
      if ((nameEl?.textContent ?? '').replace(/ /g, ' ').trim()) count++;
    }
    return count;
  }, DOM_EXTRACTION_SELECTORS);
}

/**
 * Read every rendered seller card.
 *
 * Runs entirely in the page so one round-trip returns the whole list, and so we
 * can consult `getComputedStyle` — that is how the struck-through MRP gets told
 * apart from the selling price when a card shows several amounts.
 */
export async function extractSellers(page: Page): Promise<SellerCard[]> {
  return page.evaluate((selectors: DomExtractionSelectors) => {
    const priceRe = new RegExp(selectors.pricePattern);
    const priceReGlobal = new RegExp(selectors.pricePattern, 'g');

    const clean = (value: string | null | undefined): string =>
      (value ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

    const toNumber = (text: string): number | null => {
      const match = priceRe.exec(text);
      if (!match) return null;
      const value = Number(match[1].replace(/,/g, ''));
      return Number.isFinite(value) ? value : null;
    };

    const isStruckThrough = (element: Element): boolean => {
      const style = window.getComputedStyle(element as HTMLElement);
      const decoration = `${style.textDecorationLine} ${style.textDecoration}`;
      return decoration.includes('line-through');
    };

    const queryAll = (root: ParentNode, list: string[]): Element[] => {
      for (const selector of list) {
        const found = Array.from(root.querySelectorAll(selector));
        if (found.length > 0) return found;
      }
      return [];
    };

    /**
     * First price in document order — NOT the lowest.
     *
     * Every card renders price before MRP before bank offers, and the desktop
     * layout puts "Flat ₹50 off" copy inside the card. Lowest-wins would report
     * that ₹50 as the seller's price.
     */
    const firstPriceIn = (text: string): number | null => {
      for (const match of text.matchAll(priceReGlobal)) {
        const value = Number(match[1].replace(/,/g, ''));
        if (Number.isFinite(value)) return value;
      }
      return null;
    };

    const cards = queryAll(document, selectors.card);
    const results: Array<{ name: string; price: number | null; mrp: number | null; rawPriceText: string }> = [];

    for (const card of cards) {
      // The name node is rendered twice per card (responsive duplicate), so the
      // first match is the canonical one.
      const nameEl = queryAll(card, selectors.name)[0];
      const name = clean(nameEl?.textContent);
      if (!name) continue;

      const priceEls = queryAll(card, selectors.price);
      let price: number | null = null;
      for (const el of priceEls) {
        if (isStruckThrough(el)) continue;
        const value = toNumber(clean(el.textContent));
        if (value !== null) {
          price = value;
          break;
        }
      }

      const cardText = clean(card.textContent);
      // No structural price hit means the price classes rotated; fall back to
      // the first currency value inside this card.
      if (price === null) price = firstPriceIn(cardText);

      const mrpEl = queryAll(card, selectors.mrp)[0];
      const mrp = mrpEl ? toNumber(clean(mrpEl.textContent)) : null;

      results.push({ name, price, mrp, rawPriceText: cardText.slice(0, 200) });
    }

    return results;
  }, DOM_EXTRACTION_SELECTORS);
}

/**
 * Text-anchored lookup for one seller, used when the card classes have rotated
 * and `extractSellers` comes back empty or incomplete.
 *
 * Finds the element whose text is exactly the seller name, then walks up until
 * it reaches an ancestor that also contains a price — that ancestor is the card,
 * whatever it happens to be called this week.
 */
export async function findSellerByNameAnchored(page: Page, targetSeller: string): Promise<SellerCard | null> {
  const result = await page.evaluate(
    ({ target, pricePattern }: { target: string; pricePattern: string }) => {
      const priceReGlobal = new RegExp(pricePattern, 'g');
      const normalize = (value: string): string =>
        value.replace(/ /g, ' ').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      const wanted = normalize(target);
      if (!wanted) return null;

      const anchors = Array.from(document.querySelectorAll<HTMLElement>('div, span, p, a, li'))
        // Only leaf-ish nodes: an ancestor containing the whole page also
        // "contains" the name, and would match uselessly.
        .filter((el) => el.children.length === 0 && normalize(el.textContent ?? '') === wanted);

      for (const anchor of anchors) {
        let node: HTMLElement | null = anchor;
        for (let depth = 0; depth < 8 && node; depth++) {
          const text = (node.textContent ?? '').replace(/ /g, ' ');
          // First price in document order, NOT the lowest — the desktop card
          // carries "Flat ₹50 off" bank-offer copy beneath the real price.
          let price: number | null = null;
          for (const match of text.matchAll(priceReGlobal)) {
            const value = Number(match[1].replace(/,/g, ''));
            if (Number.isFinite(value)) {
              price = value;
              break;
            }
          }
          if (price !== null) {
            return {
              name: (anchor.textContent ?? '').trim(),
              price,
              rawPriceText: text.replace(/\s+/g, ' ').trim().slice(0, 200),
            };
          }
          node = node.parentElement;
        }
      }
      return null;
    },
    { target: targetSeller, pricePattern: DOM_EXTRACTION_SELECTORS.pricePattern },
  );

  return result ? { name: result.name, price: result.price, rawPriceText: result.rawPriceText } : null;
}

/* --------------------------------------------------------------- show more */

/** The paginator, matched by text — its class is shared with a tooltip button. */
export function showMoreButton(page: Page): Locator {
  return page.getByRole('button', { name: SHOW_MORE_TEXT }).last();
}

async function showMoreIsActionable(page: Page): Promise<boolean> {
  const byRole = showMoreButton(page);
  if ((await byRole.count()) > 0 && (await byRole.isVisible().catch(() => false))) {
    return byRole.isEnabled().catch(() => false);
  }
  const byText = page.locator(anyOf(SHOW_MORE)).filter({ hasText: SHOW_MORE_TEXT }).last();
  return (await byText.count()) > 0 && (await byText.isVisible().catch(() => false));
}

export interface SellerSearchResult {
  seller: SellerCard | null;
  /** Every card seen, in page order — the buy-box winner is inferred from these. */
  sellers: SellerCard[];
  sellersScanned: number;
  showMoreClicks: number;
}

/**
 * Page through the seller list until the target appears or there is nothing
 * left to load.
 *
 * The loop is driven by state, never by a click count: it stops when the seller
 * is found, when "show more" is gone, or when a click stops producing new rows.
 * `maxShowMoreClicks` is only a runaway guard.
 */
export async function clickShowMoreUntilSellerFound(
  page: Page,
  targetSeller: string,
  options: ResolvedOptions,
): Promise<SellerSearchResult> {
  let showMoreClicks = 0;
  let sellers = await extractSellers(page);
  let lastCount = sellers.length;

  /**
   * Text-anchored lookup, for when the card classes have rotated and structured
   * extraction silently under-reports while the name is plainly on the page.
   *
   * It walks every `div, span, p, a, li` in the document, which on a seller page
   * is tens of thousands of nodes, so it is asked only when its answer could
   * differ from the structural one: when extraction found no cards at all, and
   * once more before "not found" is recorded. Running it on every pass — which
   * is what it used to do — paid that sweep per "Show More" click to re-confirm
   * a list the structural reader was reading perfectly well.
   */
  const anchoredMatch = async (): Promise<SellerCard | null> => {
    const anchored = await findSellerByNameAnchored(page, targetSeller);
    if (!anchored || !sellerNamesMatch(anchored.name, targetSeller)) return null;
    log.step('Seller found...');
    log.warn('matched via text anchor — card selectors may need updating');
    return anchored;
  };

  for (;;) {
    const structuralMatch = findSeller(sellers, targetSeller);
    if (structuralMatch) {
      log.step('Seller found...');
      return { seller: structuralMatch, sellers, sellersScanned: sellers.length, showMoreClicks };
    }

    if (sellers.length === 0) {
      const anchored = await anchoredMatch();
      if (anchored) return { seller: anchored, sellers, sellersScanned: 1, showMoreClicks };
    }

    log.step(`Seller not found... (${sellers.length} sellers scanned)`);

    if (!(await showMoreIsActionable(page))) {
      // "Not found" is a claim about the whole list, so it may only be made
      // about a list that has stopped growing. Cards can still be streaming in
      // here — after a "Show More" the loop resumes as soon as the count ticks
      // up by one, not when that chunk has finished rendering.
      const settled = await settleSellerCount(page, sellers.length, options);
      if (settled > sellers.length) {
        sellers = await extractSellers(page);
        lastCount = sellers.length;
        continue;
      }

      // The last word before a "not found" is written down.
      const anchored = await anchoredMatch();
      if (anchored) {
        return { seller: anchored, sellers, sellersScanned: Math.max(sellers.length, 1), showMoreClicks };
      }

      log.info('no "Show More" control remains — seller list is exhausted');
      return { seller: null, sellers, sellersScanned: sellers.length, showMoreClicks };
    }

    if (showMoreClicks >= options.maxShowMoreClicks) {
      log.warn(`stopping at the ${options.maxShowMoreClicks}-click safety cap with "Show More" still present`);
      return { seller: null, sellers, sellersScanned: sellers.length, showMoreClicks };
    }

    log.step('Clicking Show More...');
    await withRetry(
      async () => {
        const button = showMoreButton(page);
        await button.scrollIntoViewIfNeeded().catch(() => undefined);
        await button.click({ timeout: options.timeout });
      },
      { attempts: 2, description: '"Show More" click' },
    );
    showMoreClicks++;

    // Wait on the list actually growing — this is the lazy-load / spinner wait.
    //
    // Counted, not extracted: the poll only ever needed the length, and running
    // the full extraction every 150ms meant two `getComputedStyle` calls per
    // card per poll, on every worker at once. Style resolution is the most
    // expensive thing a page can be asked for, and paying for it here starved
    // the very renderer we were waiting on. Same rule as the settling loop above.
    const grown = await waitFor(async () => (await countSellerCards(page)) > lastCount, {
      timeoutMs: options.timeout,
      description: 'additional sellers',
    });

    if (!grown) {
      log.info('no new sellers rendered after "Show More" — treating the list as complete');
      const finalSellers = await extractSellers(page);
      const lateMatch = findSeller(finalSellers, targetSeller);
      return { seller: lateMatch, sellers: finalSellers, sellersScanned: finalSellers.length, showMoreClicks };
    }

    sellers = await extractSellers(page);
    lastCount = sellers.length;
  }
}

/* ---------------------------------------------------------- getSellerPrice */

/**
 * Resolve the target seller's price, preferring a captured network payload and
 * falling back to the DOM click-through.
 */
export async function getSellerPrice(
  page: Page,
  targetSeller: string,
  capture: NetworkCapture | null,
  options: ResolvedOptions,
): Promise<{
  seller: SellerCard | null;
  /** Every card the winning path saw. Page-ordered for `dom`, arbitrary for `network`. */
  sellers: SellerCard[];
  source: 'network' | 'dom';
  sellersScanned: number;
  showMoreClicks: number;
}> {
  if (capture && options.useNetworkCapture) {
    const networkSellers = sellersFromNetwork(capture);
    const match = findSeller(networkSellers, targetSeller);
    if (match && match.price !== null) {
      log.info(`seller resolved from a captured network payload (${networkSellers.length} sellers)`);
      return {
        seller: match,
        sellers: networkSellers,
        source: 'network',
        sellersScanned: networkSellers.length,
        showMoreClicks: 0,
      };
    }
    if (networkSellers.length > 0) {
      log.info(`network payload had ${networkSellers.length} sellers but not the target — falling back to DOM`);
    }
  }

  const result = await clickShowMoreUntilSellerFound(page, targetSeller, options);
  return {
    seller: result.seller,
    sellers: result.sellers,
    source: 'dom',
    sellersScanned: result.sellersScanned,
    showMoreClicks: result.showMoreClicks,
  };
}

/** Re-read a price string through the shared parser. Exported for tests. */
export function normalizeSellerPrice(raw: string | null): number | null {
  return parsePrice(raw);
}
