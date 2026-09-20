/**
 * The old rule-engine helpers, kept only for the learning engine.
 *
 * The recommendation tabs no longer run rules — they are a sequential filter,
 * defined entirely in `lib/recommendation.ts`. The intelligence subsystem is a
 * separate thing that lives behind `/api/intelligence`: it scores predictors
 * against each FSN's past, and one of the predictors it scores is the rule chain
 * that used to price the tabs. That predictor has to keep behaving exactly as it
 * did or its historical scores stop meaning anything, so the chain is moved here
 * verbatim rather than deleted or rewritten.
 *
 * Nothing outside `lib/intelligence` should import from this file.
 */

/** One previous appearance of an FSN, in one previous upload for this account. */
export interface RecommendationHistoryEntry {
  jobId: string;
  jobName: string;
  /** The previous upload's time, so the UI can order and label it. */
  uploadTime: string;
  myPrice: number | null;
  winnerPrice: number | null;
  winningSeller: string | null;
  hasBuybox: boolean | null;
}

/** What the rules actually need to know about an FSN's past. */
export interface RecommendationHistorySummary {
  /** Previous uploads of this account that contained this FSN. */
  uploads: number;
  /** Newest first. Capped — the rules only look at the recent tail. */
  entries: RecommendationHistoryEntry[];
  buyboxWins: number;
  /** True when the most recent five uploads all explicitly failed to win the Buy Box. */
  lastFiveWithoutBuybox: boolean;
  /** The winning price seen most often, when it was seen more than once. */
  repeatedWinningPrice: number | null;
  repeatedWinningPriceCount: number;
}

export const EMPTY_HISTORY: RecommendationHistorySummary = {
  uploads: 0,
  entries: [],
  buyboxWins: 0,
  lastFiveWithoutBuybox: false,
  repeatedWinningPrice: null,
  repeatedWinningPriceCount: 0,
};

/** How many past appearances of one FSN are kept. Enough for rule 7 plus context. */
const HISTORY_LIMIT = 10;

/**
 * Fold an FSN's past appearances into the summary the rules read.
 *
 * `entries` must already be newest-upload-first — the caller sorts the job
 * folders, and "the last 5 uploads" means nothing without that order.
 */
export function summarizeHistory(entries: RecommendationHistoryEntry[]): RecommendationHistorySummary {
  if (entries.length === 0) return EMPTY_HISTORY;

  const kept = entries.slice(0, HISTORY_LIMIT);
  const buyboxWins = entries.filter((entry) => entry.hasBuybox === true).length;

  // Read strictly: five uploads of evidence, not "everything we have so far".
  const lastFive = entries.slice(0, 5);
  const lastFiveWithoutBuybox =
    lastFive.length === 5 && lastFive.every((entry) => entry.hasBuybox === false);

  // How often each winning price shows up. Ties break towards the more recent
  // price, because `entries` is newest-first.
  const frequency = new Map<number, number>();
  for (const entry of entries) {
    if (entry.winnerPrice === null) continue;
    frequency.set(entry.winnerPrice, (frequency.get(entry.winnerPrice) ?? 0) + 1);
  }

  let repeatedWinningPrice: number | null = null;
  let repeatedWinningPriceCount = 0;
  for (const [price, count] of frequency) {
    if (count >= 2 && count > repeatedWinningPriceCount) {
      repeatedWinningPrice = price;
      repeatedWinningPriceCount = count;
    }
  }

  return {
    uploads: entries.length,
    entries: kept,
    buyboxWins,
    lastFiveWithoutBuybox,
    repeatedWinningPrice,
    repeatedWinningPriceCount,
  };
}

/** A chosen price, as the old chain reported it. */
export interface TargetChoice {
  target: number;
  reason: string;
}

/** Money the way the rest of the dashboard writes it, for the reason sentences. */
function money(value: number): string {
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/**
 * The old rules 4, 6 and 7, as one policy: what price to aim at once the winner
 * is known to undercut us. Scored by the learning engine as `rule:engine`.
 */
export function staticRuleTarget(
  myPrice: number,
  winnerPrice: number,
  history: RecommendationHistorySummary,
): TargetChoice {
  let target = winnerPrice;
  let reason = `Winner is ${money(myPrice - winnerPrice)} below my price — matching ${money(
    winnerPrice,
  )} takes the Buy Box.`;

  // A price that has proved it wins, but only while it still undercuts today's
  // winner: a proven price above the current winning price wins nothing now.
  if (history.repeatedWinningPrice !== null && history.repeatedWinningPrice <= target) {
    target = history.repeatedWinningPrice;
    reason = `${money(target)} has been the winning price on ${history.repeatedWinningPriceCount} previous uploads — preferring that proven price.`;
  }

  // Five uploads without the Buy Box.
  if (history.lastFiveWithoutBuybox && winnerPrice - 1 < target) {
    target = winnerPrice - 1;
    reason = `The last ${Math.min(5, history.uploads)} uploads never won the Buy Box — undercutting the winner by ₹1 at ${money(
      target,
    )}.`;
  }

  return { target, reason };
}
