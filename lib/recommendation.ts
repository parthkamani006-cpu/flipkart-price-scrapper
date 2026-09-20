/** The only recommendation calculation used by the application. */

import { computeSettlement } from '@/lib/settlement';
import type { JobRow } from '@/types/dashboard';

export type RecommendationStatus =
  | 'Safe'
  | 'Not Safe'
  | 'Safe but more than 20%'
  /** No Minimum Bank Settlement for this SKU, so the row cannot be judged either way. */
  | 'Threshold Missing'
  /** Anything that could not be evaluated — never a blank cell. */
  | 'Need Review';

export interface Recommendation {
  key: string;
  /**
   * The row's position in the uploaded file, 0-based — `JobRow.index`, carried
   * through unchanged.
   *
   * Recommendations are built by mapping over the job's rows, which are built by
   * mapping over the inputs, so this is always the upload's own ordering. It is
   * surfaced because the scrape no longer finishes products in that order: with
   * a worker pool the journal is written in completion order, and results are
   * joined back to rows by key rather than by position. Carrying the index makes
   * that mapping visible in the table and the export instead of something a
   * reader has to take on trust.
   */
  index: number;
  /** The row's Seller SKU ID. Pairs with `index` to identify a row on sight. */
  sku: string;
  fsn: string;
  diffAmount: number | null;
  status: RecommendationStatus;
  /**
   * The bank settlement the row would end on once the recommendation is acted
   * upon. Only a Safe row actually moves: it lands on the settlement view's
   * currentBankSettlement + diff, capped to a 20% move of our own price when the
   * diff is wider than that band. Every other status stays put on the current
   * bank settlement, because nothing is being recommended.
   */
  finalBankSettlement: number | null;
  /** The specific "why" behind Need Review / Threshold Missing. Null once a row is actually scored. */
  reason: string | null;
}

/**
 * A current bank settlement that already sits under the SKU's Minimum Bank
 * Settlement is a broken starting point, not a verdict: scoring from it would
 * judge the row against a base the business would never leave standing. So the
 * floor is applied first — the current settlement is lifted to the minimum —
 * and the row is then scored by the existing rules, unchanged, on top of that
 * lifted base. A row already at or above its minimum comes back untouched, and
 * so does one missing either value, so nothing that used to be scored is scored
 * differently.
 */
function withMinimumFloor(row: JobRow): JobRow {
  const current = row.currentBankSettlement;
  const minimum = row.bankSettlementThreshold;
  if (
    current === undefined ||
    minimum === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(minimum) ||
    current >= minimum
  ) {
    return row;
  }
  return { ...row, currentBankSettlement: minimum };
}

/** Every row is scored, so a status is never absent — see RecommendationStatus. */
function unevaluated(row: JobRow, status: RecommendationStatus, reason: string): Recommendation {
  return {
    key: row.key,
    index: row.index,
    sku: row.sku,
    fsn: row.fsn,
    diffAmount: null,
    status,
    finalBankSettlement: row.currentBankSettlement ?? null,
    reason,
  };
}

/**
 * Diff Amount is the change our price must absorb to match the winning offer:
 * mainPrice − sellerPrice, the same direction the settlement view and the queue
 * use. Negative means we are dearer than the buy box and must come down, which
 * is why it is *added* to the current bank settlement rather than subtracted —
 * the scraper's own `difference` is stored the other way round and must not be
 * used here.
 */
export function buildRecommendation(input: JobRow): Recommendation {
  // Everything below — `unevaluated` included — reads the floored row, so the
  // lift happens exactly once and no later step can see the sub-minimum value.
  const row = withMinimumFloor(input);
  const settlement = computeSettlement(row);
  const result = row.result;

  if (!result) {
    return unevaluated(row, 'Need Review', settlement.reason ?? 'Not yet scraped');
  }
  if (result.status !== 'OK') {
    return unevaluated(row, 'Need Review', settlement.reason ?? `Scrape failed (${result.status})`);
  }
  // We already hold the main listing, so there is no competing price to move to.
  if (result.mainListingIsAccountSeller) {
    return unevaluated(row, 'Need Review', 'Account already holds the main listing');
  }
  if (settlement.sellerPrice === null || settlement.difference === null) {
    return unevaluated(row, 'Need Review', 'Missing price data');
  }

  const diffAmount = settlement.difference;

  // A missing minimum is not a pass: it is an unanswerable question, and gets
  // its own status so it can never be mistaken for a cleared row.
  if (settlement.bankSettlementThreshold === null || !Number.isFinite(settlement.bankSettlementThreshold)) {
    return {
      key: row.key,
      index: row.index,
      sku: row.sku,
      fsn: row.fsn,
      diffAmount,
      status: 'Threshold Missing',
      finalBankSettlement: settlement.currentBankSettlement,
      reason: 'No Minimum Bank Settlement for this SKU',
    };
  }
  if (settlement.currentBankSettlement === null || settlement.finalBankSettlement === null) {
    return unevaluated(row, 'Need Review', 'Missing current bank settlement');
  }

  // Strictly greater, everywhere: a settlement that only equals the minimum has
  // no headroom and is not safe.
  if (!(settlement.finalBankSettlement > settlement.bankSettlementThreshold)) {
    return {
      key: row.key,
      index: row.index,
      sku: row.sku,
      fsn: row.fsn,
      diffAmount,
      status: 'Not Safe',
      finalBankSettlement: settlement.currentBankSettlement,
      reason: null,
    };
  }
  if (Math.abs(diffAmount) > settlement.sellerPrice * 0.2) {
    // The move is capped at the 20% band, kept in the diff's own direction:
    // cheaper than the buy box lifts the settlement, dearer pulls it down.
    const cappedMove = Math.sign(diffAmount) * settlement.sellerPrice * 0.2;
    return {
      key: row.key,
      index: row.index,
      sku: row.sku,
      fsn: row.fsn,
      diffAmount,
      status: 'Safe but more than 20%',
      finalBankSettlement: settlement.currentBankSettlement + cappedMove,
      reason: null,
    };
  }
  return {
    key: row.key,
    index: row.index,
    sku: row.sku,
    fsn: row.fsn,
    diffAmount,
    status: 'Safe',
    finalBankSettlement: settlement.finalBankSettlement,
    reason: null,
  };
}
