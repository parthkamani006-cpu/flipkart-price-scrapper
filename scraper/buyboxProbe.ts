/**
 * The buy-box question, asked of the server's own HTML.
 *
 * A Flipkart PDP server-renders everything this scraper needs before the
 * comparison begins: the "Fulfilled by <name>" line that names the buy-box
 * holder, and a `<script type="application/ld+json">` blob carrying the headline
 * price, the FSN and the availability. None of it waits on React.
 *
 * That matters because of what the answer decides. When the buy box is already
 * the account's own listing there is nothing to compare — the current bank
 * settlement IS the final one — so the product is finished the moment the name
 * is read. Rendering a ~1.2MB page, its script bundle and its stylesheets to
 * learn that costs a browser page and a second or more; reading the same two
 * facts out of the raw HTML costs one request and no renderer at all.
 *
 * A probe is an accelerator, never a verdict. Anything unexpected — a non-200,
 * a page carrying no "Fulfilled by" line, an out-of-stock marker, a bot wall,
 * unparseable structured data — returns null, and the caller renders the page
 * exactly as it always did. So the worst a probe can cost is one wasted HTML
 * fetch, and no failure mode of this file can change what a product reports.
 */

import type { BrowserContext } from 'playwright';
import { parseProductJsonLd, type ProductJsonLd } from './parser';
import { BLOCKED_TEXT, FULFILLED_BY_PATTERN_SOURCE, UNAVAILABLE_TEXT } from './selectors';
import type { ResolvedOptions } from './types';
import { errorMessage, log, pidFromUrl } from './utils';

/** A conclusive read of the product page, taken without rendering it. */
export interface BuyboxProbe {
  /** Where the fetch actually landed — short links (dl.flipkart.com) redirect. */
  productUrl: string;
  /** The seller named by the page's "Fulfilled by" line: whoever holds the buy box. */
  buyboxSeller: string;
  /** The headline price, from structured data. */
  mainPrice: number;
  /** Flipkart's product id, for addressing the seller list directly. Null when absent. */
  pid: string | null;
}

/** What the raw markup says, before any of it is judged. */
export interface HtmlReading {
  fulfilledBy: string | null;
  jsonLd: ProductJsonLd | null;
  /** The BLOCKED_TEXT match near the top of the document, if any. */
  blocked: string | null;
  /** The UNAVAILABLE_TEXT match anywhere in the document, if any. */
  unavailable: string | null;
}

/* ------------------------------------------------------------------ parsing */

const SCRIPT_OR_STYLE = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;
const JSON_LD_SCRIPT =
  /<script\b[^>]*(?:type=["']application\/ld\+json["']|id=["']jsonLD["'])[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Decode the entities that can appear inside a seller name or a price.
 *
 * Not a general-purpose decoder — it covers the named entities Flipkart emits
 * plus the numeric forms. It matters because seller names are compared after
 * every non-alphanumeric character is stripped: left encoded, "A &amp; B" would
 * normalize to "aampb" and stop matching "A & B".
 */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    rsquo: '’',
    lsquo: '‘',
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return named[body.toLowerCase()] ?? whole;
  });
}

/**
 * The document's text, one element per line.
 *
 * Scripts and styles are dropped first: the preloaded-state blob repeats page
 * copy, and matching a seller name inside JSON would read whatever the app
 * happened to serialize rather than what the page says. Tags become newlines so
 * each text node stands alone, which is what keeps the "Fulfilled by" match
 * anchored the same way the DOM extractor's leaf-node rule anchors it.
 */
function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(SCRIPT_OR_STYLE, '\n')
      .replace(/<[^>]+>/g, '\n')
      .replace(/ /g, ' '),
  );
}

/**
 * Read the facts a probe needs out of raw HTML. Pure — no browser, so the
 * snapshot suite can hold it to the same answers as the DOM extractors.
 */
export function readBuyboxHtml(html: string): HtmlReading {
  let jsonLd: ProductJsonLd | null = null;
  for (const match of html.matchAll(JSON_LD_SCRIPT)) {
    jsonLd = parseProductJsonLd(match[1].trim());
    if (jsonLd) break;
  }

  const text = textOf(html);

  // Same anchoring as the DOM reader: the name has to sit on the line the
  // "Fulfilled by" copy sits on, not merely somewhere after it. A page that
  // splits the two across elements reads as inconclusive and gets rendered.
  const perLine = new RegExp(FULFILLED_BY_PATTERN_SOURCE, 'i');
  let fulfilledBy: string | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    const name = perLine.exec(trimmed)?.[1]?.trim();
    if (name) {
      fulfilledBy = name;
      break;
    }
  }

  // Only the opening stretch for the bot wall, mirroring readPageSignals: the
  // word "captcha" turns up legitimately in deep page furniture, but a real wall
  // says so at the top. The window is wider here than the rendered check's 2000
  // characters because raw markup carries head metadata that innerText does not.
  const blocked = BLOCKED_TEXT.exec(text.slice(0, 6_000));
  const unavailable = UNAVAILABLE_TEXT.exec(text);

  return {
    fulfilledBy,
    jsonLd,
    blocked: blocked ? blocked[0] : null,
    unavailable: unavailable ? unavailable[0] : null,
  };
}

/* ------------------------------------------------------------------- probing */

/**
 * Fetch the product page as HTML and read the buy box off it.
 *
 * Returns null whenever the read is anything less than conclusive, which the
 * caller treats as "render the page and do it the long way". Never throws.
 *
 * The request goes through the browser context, so it carries the same user
 * agent, locale and cookie jar as the pages around it rather than looking like a
 * second, unrelated client.
 */
export async function probeBuybox(
  context: BrowserContext,
  productUrl: string,
  options: ResolvedOptions,
): Promise<BuyboxProbe | null> {
  let html: string;
  let landedOn: string;

  try {
    const response = await context.request.get(productUrl, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-IN,en;q=0.9',
      },
      timeout: options.navigationTimeout,
    });

    // Deliberately not raised as BLOCKED. A bodyless fetch is an easier thing for
    // an edge to turn away than a real navigation, so a 403 here is at least as
    // likely to be about the probe as about our IP — and calling it a block would
    // park the whole pool for a minute on that guess. The rendered path that
    // follows is the one whose verdict can be trusted.
    if (!response.ok()) {
      log.info(`buy-box probe: HTTP ${response.status()} — rendering the page instead.`);
      return null;
    }

    landedOn = response.url();
    html = await response.text();
  } catch (error) {
    log.info(`buy-box probe unavailable (${errorMessage(error)}).`);
    return null;
  }

  const reading = readBuyboxHtml(html);

  // Every one of these hands the product back to the rendered path, which judges
  // it exactly as it did before this file existed:
  //   - a wall, so the real navigation can report BLOCKED and pause the pool;
  //   - any unavailability marker, because raw HTML carries text that never
  //     renders (hidden widgets, adjacent carousels) and a false
  //     PRODUCT_UNAVAILABLE is far worse than a second look;
  //   - no seller line, or no price, which is simply not an answer.
  const inconclusive = reading.blocked
    ? `looks like a bot wall (matched "${reading.blocked}")`
    : reading.unavailable
      ? `page text says "${reading.unavailable}"`
      : reading.jsonLd?.availability && /OutOfStock|SoldOut|Discontinued/i.test(reading.jsonLd.availability)
        ? `structured data says availability=${reading.jsonLd.availability}`
        : !reading.fulfilledBy
          ? 'no "Fulfilled by" line in the served markup'
          : reading.jsonLd?.price == null
            ? 'no price in the served structured data'
            : null;

  // Logged rather than swallowed: a probe that stops paying off is invisible
  // otherwise — the batch still produces correct results, just slowly, and the
  // reason it stopped short is exactly what says whether Flipkart moved the
  // markup or the product is simply unusual.
  const { fulfilledBy, jsonLd } = reading;
  if (inconclusive || !fulfilledBy || jsonLd?.price == null) {
    log.info(`buy-box probe inconclusive — ${inconclusive ?? 'incomplete read'}; rendering the page instead.`);
    return null;
  }

  return {
    productUrl: landedOn,
    buyboxSeller: fulfilledBy,
    mainPrice: jsonLd.price,
    pid: jsonLd.sku ?? pidFromUrl(landedOn) ?? pidFromUrl(productUrl),
  };
}
