/**
 * The whole comparison, from one request, with no browser page at all.
 *
 * The /sellers page is a JavaScript shell: its served HTML carries no seller
 * markup whatsoever. Every card on it is rendered from a single POST the page
 * makes on load —
 *
 *     POST https://<n>.rome.api.flipkart.com/api/3/page/dynamic/product-sellers
 *     {"requestContext":{"productId":"<FSN>"},"locationContext":{}}
 *
 * — and that one reply carries everything a product needs:
 *
 *   - `pageContext.pricing.finalPrice.value` is the headline price, the same
 *     number the PDP's JSON-LD reports (verified equal on every product in
 *     `.validate.ts`);
 *   - `pageContext.listingId` names the listing the product page defaults to,
 *     so the row carrying it is the buy-box holder — stated outright rather
 *     than inferred from whose price happens to equal the headline;
 *   - `product_seller_detail_1.data` is the COMPLETE seller list. Not a page of
 *     it: a 38-seller product returns all 38 in one reply. "Show More" on the
 *     rendered page is pure client-side reveal of a list already downloaded,
 *     which is why paging through it in a browser bought nothing but time.
 *
 * So the rendered pipeline — open a page, load ~1.5MB of PDP, navigate to
 * /sellers, wait out its script bundle and hydration, poll until the card count
 * settles, click "Show More" until the list is exhausted, and read prices back
 * through `getComputedStyle` — is replaced by one request that returns in a few
 * hundred milliseconds. Over a link with real latency to Flipkart, which is what
 * a GitHub Actions runner has, that is the difference between ~40s per product
 * and under a second.
 *
 * This is an accelerator, never a verdict. Anything short of a complete read —
 * a non-200 after the datacentre retry, unparseable JSON, a reply with no
 * sellers in it — returns null, and the caller falls back to the rendered
 * pipeline exactly as it behaved before this file existed. So the worst a
 * failure here can cost is one wasted request, and nothing in it can change
 * what a product reports.
 */

import type { BrowserContext } from 'playwright';
import type { RateLimiter } from './rateLimiter';
import { SELLER_API_PATH, sellerApiHost } from './selectors';
import type { ResolvedOptions, SellerCard } from './types';
import { errorMessage, log } from './utils';

/**
 * What one call to the seller endpoint concluded.
 *
 * `throttled` exists so that "Flipkart is metering us" is never mistaken for
 * "this product could not be read". They demand opposite responses: the second
 * is a reason to go and render the page, the first is a reason to do LESS work,
 * not more. Rendering a page in answer to a 429 spends a PDP, a /sellers
 * navigation and two script bundles at the exact moment we have been told to
 * slow down — and, with the pool's timeouts widened for load, costs minutes per
 * product to arrive at nothing.
 */
export type SellerApiOutcome =
  | { kind: 'read'; reading: SellerApiReading }
  | { kind: 'throttled' }
  | { kind: 'inconclusive' };

/** A complete read of a product's seller list, taken without rendering it. */
export interface SellerApiReading {
  /** The product page's headline price. */
  mainPrice: number;
  /** The seller whose listing the product page defaults to. Null when unnamed. */
  buyboxSeller: string | null;
  /** Every seller, in the order Flipkart returned them — the page's own order. */
  sellers: SellerCard[];
}

/**
 * How many times to follow a "DC Change" redirect before giving up.
 *
 * Flipkart pins a session to one of its datacentres and rejects a call aimed at
 * a different one with HTTP 406 and `ERROR_MESSAGE: "DC Change"`, naming the
 * right datacentre in the reply. That is a routing correction, not a refusal —
 * it happens whenever the context has already talked to www.flipkart.com — so
 * it is followed rather than treated as a failure. Two is ample; more would
 * mean something other than routing is wrong.
 */
const MAX_DC_REDIRECTS = 2;

/* ------------------------------------------------------------------ parsing */

/** Narrow an unknown to an indexable object without asserting a shape. */
function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Walk a path of keys, returning undefined the moment one is missing. */
function at(root: unknown, ...path: string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    const record = obj(node);
    if (!record) return undefined;
    node = record[key];
  }
  return node;
}

/** A price node's numeric value, if it is one. */
function priceValue(node: unknown): number | null {
  const value = at(node, 'value');
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read the reply into the same shape the DOM extractor produces.
 *
 * Pure, so the payload snapshots can hold it to the same answers as
 * `extractSellers` without a browser. Returns null unless the reading is
 * complete: a price and at least one seller. A reply with no sellers is not an
 * answer — it is a product whose listings have gone, which the rendered path
 * reports properly as PRODUCT_UNAVAILABLE.
 */
export function readSellerApi(body: unknown): SellerApiReading | null {
  const response = obj(at(body, 'RESPONSE'));
  if (!response) return null;

  const mainPrice = priceValue(at(response, 'pageContext', 'pricing', 'finalPrice'));
  if (mainPrice === null) return null;

  const rows = at(response, 'data', 'product_seller_detail_1', 'data');
  if (!Array.isArray(rows)) return null;

  const buyboxListingId = at(response, 'pageContext', 'listingId');
  let buyboxSeller: string | null = null;
  const sellers: SellerCard[] = [];

  for (const row of rows) {
    const value = obj(at(row, 'value'));
    if (!value) continue;

    const name = at(value, 'sellerInfo', 'value', 'name');
    if (typeof name !== 'string' || !name.trim()) continue;

    const pricing = at(value, 'pricing', 'value');
    const price = priceValue(at(pricing, 'finalPrice'));
    // `prices` lists MRP and selling price side by side; the MRP is the entry
    // Flipkart itself marks struck off, which is the same distinction the DOM
    // extractor makes with getComputedStyle — only stated rather than measured.
    const priceList = at(pricing, 'prices');
    let mrp: number | null = null;
    if (Array.isArray(priceList)) {
      for (const entry of priceList) {
        if (at(entry, 'priceType') === 'MRP') mrp = priceValue(entry);
      }
    }

    sellers.push({ name: name.trim(), price, mrp });

    // Stated, not inferred: this is the listing the product page defaults to.
    if (buyboxListingId && at(value, 'listingId') === buyboxListingId) buyboxSeller = name.trim();
  }

  if (sellers.length === 0) return null;

  // No listing id matched — fall back to `selected`, then to Flipkart's own
  // ordering, which puts the default listing first.
  if (!buyboxSeller) {
    const selected = rows.find((row) => at(row, 'value', 'selected') === true);
    const name = at(selected, 'value', 'sellerInfo', 'value', 'name');
    buyboxSeller = typeof name === 'string' && name.trim() ? name.trim() : sellers[0].name;
  }

  return { mainPrice, buyboxSeller, sellers };
}

/* ------------------------------------------------------------------ fetching */

/**
 * The `x-user-agent` the web client sends alongside the ordinary one.
 *
 * Flipkart's API reads this rather than `user-agent` to decide which client is
 * asking, and answers a request without it differently. Built from whatever UA
 * the run is using so the two never disagree.
 */
function apiUserAgent(userAgent: string): string {
  return `${userAgent} FKUA/website/42/website/Desktop`;
}

/**
 * Ask Flipkart for a product's sellers directly. Never throws.
 *
 * The request goes through the browser context, so it carries the same user
 * agent, locale and cookie jar as everything else the run does rather than
 * looking like a second, unrelated client.
 *
 * `limiter` holds the pool's request budget: a token is taken before every
 * attempt, a 429 halves the rate and parks every worker, and a clean reply
 * counts towards winning that rate back. Metering has to live outside this
 * function because the quota is per IP, not per product — one worker's 429 is
 * every worker's problem.
 */
export async function fetchSellerListings(
  context: BrowserContext,
  pid: string,
  options: ResolvedOptions,
  userAgent: string,
  limiter: RateLimiter,
): Promise<SellerApiOutcome> {
  let host = sellerApiHost();
  let throttles = 0;

  // Bounded by both counters at once: `redirect` follows datacentre corrections,
  // `throttles` re-asks after a rate-limit cooldown. Neither can spin, and a
  // product that keeps being metered gives up cheaply rather than falling
  // through to a five-minute render.
  for (let redirect = 0; redirect <= MAX_DC_REDIRECTS; ) {
    if (!(await limiter.take(options.signal))) return { kind: 'inconclusive' };
    if (options.signal?.aborted) return { kind: 'inconclusive' };

    let status: number;
    let text: string;

    try {
      const response = await context.request.post(`https://${host}${SELLER_API_PATH}`, {
        headers: {
          'content-type': 'application/json',
          'x-user-agent': apiUserAgent(userAgent),
          referer: 'https://www.flipkart.com/',
          'accept-language': 'en-IN',
        },
        data: { requestContext: { productId: pid }, locationContext: {} },
        timeout: options.navigationTimeout,
      });
      status = response.status();
      text = await response.text();
    } catch (error) {
      log.info(`seller API unavailable (${errorMessage(error)}); rendering the seller list instead.`);
      return { kind: 'inconclusive' };
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      log.info(`seller API returned HTTP ${status} with a non-JSON body; rendering the seller list instead.`);
      return { kind: 'inconclusive' };
    }

    // Metered, not refused. This is the one status that must not become a
    // fallback: it says nothing about the product and everything about how fast
    // the pool is going, so the answer is to slow the pool down and ask again,
    // not to spend a rendered page finding out the same thing more expensively.
    if (status === 429 || at(body, 'ERROR_CODE') === 429) {
      limiter.throttled();
      if (++throttles > options.sellerApiThrottleRetries) {
        log.warn(`still rate limited after ${throttles} attempt(s) — handing this product to the back-off.`);
        return { kind: 'throttled' };
      }
      continue;
    }

    // Routing correction, not a refusal — the reply names the datacentre this
    // session belongs to, so aim there and ask again.
    if (status === 406 && at(body, 'ERROR_MESSAGE') === 'DC Change') {
      const dc = at(body, 'RESPONSE', 'id');
      const next = typeof dc === 'string' || typeof dc === 'number' ? sellerApiHost(String(dc)) : null;
      if (next && next !== host && redirect < MAX_DC_REDIRECTS) {
        host = next;
        redirect++;
        continue;
      }
    }

    if (status !== 200) {
      // Deliberately not raised as BLOCKED, for the same reason the buy-box
      // probe does not: an API call is an easier thing for an edge to turn away
      // than a real navigation, so a refusal here is at least as likely to be
      // about this request as about our IP. Calling it a block would park the
      // whole pool for a minute on that guess; the rendered path that follows is
      // the one whose verdict can be trusted. A 429 is the exception, handled
      // above — that one says outright what it is.
      log.info(`seller API returned HTTP ${status}; rendering the seller list instead.`);
      return { kind: 'inconclusive' };
    }

    const reading = readSellerApi(body);
    limiter.succeeded();
    if (!reading) {
      log.info('seller API reply carried no usable seller list; rendering the seller list instead.');
      return { kind: 'inconclusive' };
    }

    log.info(`${reading.sellers.length} seller(s) from the seller API — no page rendered`);
    return { kind: 'read', reading };
  }

  return { kind: 'inconclusive' };
}
