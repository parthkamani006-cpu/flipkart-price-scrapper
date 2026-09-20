/**
 * Pure parsing / comparison logic. No Playwright, no I/O — so every edge case
 * here (currency symbols, comma grouping, paise, multiple prices in one blob)
 * is unit-testable without a browser.
 */

import {
  PRICE_PATTERN_SOURCE,
  SELLER_JSON_NAME_KEYS,
  SELLER_JSON_PRICE_KEYS,
} from './selectors';
import type { SellerCard } from './types';

const PRICE_RE = new RegExp(PRICE_PATTERN_SOURCE);
const PRICE_RE_GLOBAL = new RegExp(PRICE_PATTERN_SOURCE, 'g');
/** Bare number fallback, e.g. a price node rendered as "1,234" with the ₹ in a sibling. */
const BARE_NUMBER_RE = /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/;

/**
 * "₹1,234" -> 1234 | "Rs. 99.50" -> 99.5 | "1,234" -> 1234 | "86% off" -> null
 *
 * Returns null rather than NaN so callers can branch on a real absence.
 */
export function parsePrice(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = raw.replace(/ /g, ' ').trim();
  if (!text) return null;

  // "86% off" and "4.1" ratings must never be mistaken for a price.
  if (/%/.test(text) && !PRICE_RE.test(text)) return null;

  const withSymbol = PRICE_RE.exec(text);
  const captured = withSymbol ? withSymbol[1] : BARE_NUMBER_RE.exec(text)?.[1];
  if (!captured) return null;

  const value = Number(captured.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/**
 * Pull the most likely *selling* price out of a seller-card text blob, used when
 * the card's price element could not be located structurally.
 *
 * Takes the FIRST currency value in document order, deliberately not the lowest.
 * Both Flipkart layouts render the card as: name, then selling price, then the
 * struck MRP, then discount, then bank offers. The desktop layout embeds offer
 * copy like "Flat ₹50 off" and "₹75 Cashback" inside the very same card — so
 * "lowest wins" reports TREVIAA at ₹50 against a true price of ₹200. Document
 * order gets ₹200 on desktop and ₹135 on compact; lowest gets one of them wrong.
 */
export function parseSellingPriceFromBlob(raw: string | null | undefined): number | null {
  if (!raw) return null;
  for (const match of raw.matchAll(PRICE_RE_GLOBAL)) {
    const value = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Normalize a seller name for comparison.
 *
 * Flipkart renders seller names inconsistently across the PDP and the seller
 * list — casing varies, and names occasionally pick up trailing whitespace or a
 * decorative suffix. We compare on a case-folded, whitespace-and-punctuation
 * stripped form so "AYANSH ENTERPRISEE" matches "AyanshEnterprisee".
 */
export function normalizeSellerName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .replace(/ /g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** True when two seller names refer to the same seller. */
export function sellerNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeSellerName(a);
  const right = normalizeSellerName(b);
  return left.length > 0 && left === right;
}

/** Find the target seller in a list of scraped cards. Exact match first. */
export function findSeller(cards: SellerCard[], targetSeller: string): SellerCard | null {
  const exact = cards.find((card) => sellerNamesMatch(card.name, targetSeller));
  return exact ?? null;
}

/**
 * The seller holding the buy box — whoever's offer the product page headlines.
 *
 * Flipkart marks this nowhere in the markup, so it is inferred: the PDP price IS
 * the buy-box seller's price, which makes the card carrying that exact amount the
 * winner. A tie (two sellers at the same price, as in the desktop snapshot where
 * SPN1 and TREVIAA both sit at ₹200) goes to whichever the page listed first,
 * because that is the one Flipkart itself picked.
 *
 * `ordered` says whether the list arrived in the page's own order. When no card
 * carries the main price we fall back to the first card only in that case —
 * Flipkart renders the default seller first. A captured network payload is merged
 * from arbitrary JSON, so its order means nothing and it gets null instead of a
 * guess: an empty cell is better than a confidently wrong seller name.
 */
export function pickBuyboxSeller(
  cards: SellerCard[],
  mainPrice: number | null,
  ordered: boolean,
): SellerCard | null {
  if (cards.length === 0) return null;

  if (mainPrice !== null) {
    const target = round2(mainPrice);
    const atMainPrice = cards.find((card) => card.price !== null && round2(card.price) === target);
    if (atMainPrice) return atMainPrice;
  }

  return ordered ? cards[0] : null;
}

/* -------------------------------------------------------------- comparison */

export interface PriceComparison {
  difference: number | null;
  isPriceDifferent: boolean;
}

/**
 * difference = sellerPrice - mainPrice.
 *
 * Positive means the seller is dearer than the price headlined on the PDP.
 * Compared on paise-rounded integers so float noise never fakes a difference.
 */
export function comparePrice(mainPrice: number | null, sellerPrice: number | null): PriceComparison {
  if (mainPrice === null || sellerPrice === null) {
    return { difference: null, isPriceDifferent: false };
  }
  const difference = round2(sellerPrice - mainPrice);
  return { difference, isPriceDifferent: difference !== 0 };
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------- network payload scanning */

/**
 * Walk an arbitrary JSON payload looking for objects that carry both a
 * seller-name-ish key and a price-ish key.
 *
 * This is deliberately shape-agnostic: Flipkart's widget payloads are deeply
 * nested and undocumented, so rather than hardcode a path we scan for the
 * signature of a seller record. Returns [] when nothing convincing is found,
 * which is the signal for the caller to fall back to DOM scraping.
 */
export function extractSellersFromJson(payload: unknown, maxDepth = 12): SellerCard[] {
  const found = new Map<string, SellerCard>();

  const visit = (node: unknown, depth: number): void => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }

    const record = node as Record<string, unknown>;
    const name = firstStringValue(record, SELLER_JSON_NAME_KEYS);
    const price = firstNumericValue(record, SELLER_JSON_PRICE_KEYS);

    // Require a seller id alongside name+price, otherwise generic {name, price}
    // objects (offers, variants, banners) produce a river of false positives.
    const looksLikeSeller =
      name !== null &&
      price !== null &&
      ('sellerId' in record || 'sellerName' in record || 'listingId' in record);

    if (looksLikeSeller) {
      const key = normalizeSellerName(name);
      if (key && !found.has(key)) found.set(key, { name: name!.trim(), price });
    }

    for (const value of Object.values(record)) visit(value, depth + 1);
  };

  visit(payload, 0);
  return [...found.values()];
}

function firstStringValue(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function firstNumericValue(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = parsePrice(value);
      if (parsed !== null) return parsed;
    }
    // Flipkart wraps money as { value: 135, currency: "INR" } in places.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = (value as Record<string, unknown>)['value'];
      if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
    }
  }
  return null;
}

/* --------------------------------------------------------------- JSON-LD */

export interface ProductJsonLd {
  name?: string;
  sku?: string;
  price?: number | null;
  availability?: string;
}

/**
 * Read schema.org Product data out of a `<script type="application/ld+json">`
 * body. This is our primary main-price source: it survives every CSS change,
 * and on the captured PDP it yields offers.price = 236 exactly.
 */
export function parseProductJsonLd(rawJson: string): ProductJsonLd | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }

  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    if (record['@type'] !== 'Product' && !('offers' in record)) continue;

    const offers = record['offers'];
    const offer = (Array.isArray(offers) ? offers[0] : offers) as Record<string, unknown> | undefined;

    return {
      name: typeof record['name'] === 'string' ? record['name'] : undefined,
      sku: typeof record['sku'] === 'string' ? record['sku'] : undefined,
      price: offer ? parsePrice(String(offer['price'] ?? '')) : null,
      availability: typeof offer?.['availability'] === 'string' ? (offer['availability'] as string) : undefined,
    };
  }
  return null;
}
