/**
 * Error accounting and rule ranking.
 *
 * Two decisions carry most of the weight here.
 *
 * 1. Every metric is an O(1) update on a running sum. Scoring an upload never
 *    walks history, so cost is proportional to what changed, not to what is
 *    stored.
 *
 * 2. Ranking is driven by the *Wilson lower bound* of the hit rate rather than
 *    the raw hit rate. A rule that was right once out of one attempt has a raw
 *    hit rate of 100%; ranking on that would hand the crown to whichever rule
 *    happened to go first, and then thrash. The Wilson bound is the standard
 *    closed-form answer to "how good can I honestly claim this is, given how
 *    little I have seen?" — it shrinks hard towards zero at small n and relaxes
 *    as evidence accumulates. No sampling, no priors to tune, fully
 *    deterministic.
 */

import type {
  IntelligenceConfig,
  PredictorMetrics,
  PredictorStats,
} from './types';

export function emptyStats(id: string): PredictorStats {
  return {
    id,
    n: 0,
    sumAbsErr: 0,
    sumSqErr: 0,
    sumSignedErr: 0,
    sumAbsPctErr: 0,
    pctErrN: 0,
    sumActual: 0,
    hits: 0,
    ewmaAbsErr: null,
    lastErr: null,
    timesSelected: 0,
    lastUsedAt: null,
  };
}

/** The band inside which a prediction counts as correct, for one actual value. */
export function toleranceFor(actual: number, config: IntelligenceConfig): number {
  // Both floors matter: a percentage alone is unusable on a ₹20 product, an
  // absolute alone is unusable on a ₹20,000 one.
  return Math.max(config.toleranceAbs, Math.abs(actual) * config.tolerancePct);
}

/** Fold one scored outcome into a predictor's accumulators. O(1). */
export function updateStats(
  stats: PredictorStats,
  predicted: number,
  actual: number,
  config: IntelligenceConfig,
): void {
  const error = predicted - actual;
  const absolute = Math.abs(error);

  stats.n += 1;
  stats.sumAbsErr += absolute;
  stats.sumSqErr += error * error;
  stats.sumSignedErr += error;
  stats.sumActual += actual;
  stats.lastErr = error;

  // MAPE is undefined at an actual of zero, so those observations are excluded
  // from that metric alone rather than poisoning it with an infinity.
  if (actual !== 0) {
    stats.sumAbsPctErr += absolute / Math.abs(actual);
    stats.pctErrN += 1;
  }

  if (absolute <= toleranceFor(actual, config)) stats.hits += 1;

  stats.ewmaAbsErr =
    stats.ewmaAbsErr === null
      ? absolute
      : config.ewmaAlpha * absolute + (1 - config.ewmaAlpha) * stats.ewmaAbsErr;
}

/**
 * Wilson score interval, lower bound.
 *
 * Closed form, no iteration, no randomness — the deterministic way to compare
 * "3 of 3" against "17 of 20" without pretending they are equally established.
 */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;

  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  return Math.max(0, (centre - margin) / denominator);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Turn accumulators into metrics.
 *
 * Errors are normalised by the mean actual price before they are scored, so a
 * ₹5 miss on a ₹2,000 product does not outrank a ₹5 miss on a ₹50 one. Ranking
 * across FSNs with wildly different price levels only works in relative terms.
 */
export function deriveMetrics(stats: PredictorStats, config: IntelligenceConfig): PredictorMetrics {
  const { n } = stats;

  if (n === 0) {
    return {
      id: stats.id,
      n: 0,
      mae: null,
      rmse: null,
      mape: null,
      bias: null,
      hitRate: null,
      confidence: 0,
      recentMae: null,
      accuracyPct: null,
      toleranceRatio: null,
      score: 0,
      timesSelected: stats.timesSelected,
      lastUsedAt: stats.lastUsedAt,
    };
  }

  const mae = stats.sumAbsErr / n;
  const rmse = Math.sqrt(stats.sumSqErr / n);
  const mape = stats.pctErrN > 0 ? (stats.sumAbsPctErr / stats.pctErrN) * 100 : null;
  const bias = stats.sumSignedErr / n;
  const hitRate = stats.hits / n;
  const meanActual = stats.sumActual / n;
  const priceScale = Math.abs(meanActual) > 0 ? Math.abs(meanActual) : 1;

  /**
   * Errors are scored against the tolerance band, not the price level.
   *
   * Measured against the price, every predictor on a ₹180 product looks equally
   * good — a ₹0.7 average miss and a ₹1.3 one are 0.4% and 0.7%, a difference of
   * three thousandths once weighted, which the hit-rate term drowns out. So a
   * genuinely twice-as-accurate formula could never overtake an established
   * rule. The tolerance band is the scale the user actually cares about ("close
   * enough" is defined in those units), and two band-widths is a natural zero:
   * a predictor missing by twice the tolerance on average is simply wrong.
   */
  const band = 2 * toleranceFor(meanActual, config);
  const errorScale = band > 0 ? band : priceScale;

  const relativeMae = clamp01(mae / errorScale);
  const relativeRecent = clamp01((stats.ewmaAbsErr ?? mae) / errorScale);
  const relativeBias = clamp01(Math.abs(bias) / errorScale);
  const confidence = wilsonLowerBound(stats.hits, n);

  const { weights } = config;
  const score =
    weights.hit * confidence +
    weights.accuracy * (1 - relativeMae) +
    weights.recency * (1 - relativeRecent) -
    weights.bias * relativeBias;

  return {
    id: stats.id,
    n,
    mae,
    rmse,
    mape,
    bias,
    hitRate,
    confidence,
    recentMae: stats.ewmaAbsErr,
    // Reported against the price, because "average miss as a percentage of the
    // price" is the figure a human reads. The score above deliberately uses a
    // different scale; they answer different questions.
    accuracyPct: 100 * (1 - clamp01(mae / priceScale)),
    toleranceRatio: mae / Math.max(1e-9, toleranceFor(meanActual, config)),
    score,
    timesSelected: stats.timesSelected,
    lastUsedAt: stats.lastUsedAt,
  };
}

/**
 * Order predictors best-first.
 *
 * The tie-breaks are not decoration: without a total order, two predictors with
 * identical scores could swap places between runs and the "top rule" would
 * flicker for no reason. More evidence wins ties, then the id alphabetically —
 * arbitrary, but stable forever.
 */
export function compareMetrics(left: PredictorMetrics, right: PredictorMetrics): number {
  if (right.score !== left.score) return right.score - left.score;
  if (right.n !== left.n) return right.n - left.n;
  return left.id.localeCompare(right.id);
}

/** Plain-English justification for a rank, built from whichever figures are real. */
export function explainRank(metrics: PredictorMetrics, config: IntelligenceConfig): string {
  if (metrics.n === 0) return 'No scored predictions yet — ranked below anything with evidence.';

  const parts: string[] = [];

  if (metrics.hitRate !== null) {
    parts.push(
      `${Math.round(metrics.hitRate * 100)}% of ${metrics.n} prediction${metrics.n === 1 ? '' : 's'} landed inside tolerance (±₹${config.toleranceAbs} or ${Math.round(
        config.tolerancePct * 100,
      )}%)`,
    );
  }
  if (metrics.mae !== null) parts.push(`average miss ₹${metrics.mae.toFixed(2)}`);
  if (metrics.recentMae !== null) parts.push(`recent miss ₹${metrics.recentMae.toFixed(2)}`);
  if (metrics.bias !== null && Math.abs(metrics.bias) > 0.5) {
    parts.push(`runs ${metrics.bias > 0 ? 'high' : 'low'} by ₹${Math.abs(metrics.bias).toFixed(2)} on average`);
  }
  parts.push(`confidence ${(metrics.confidence * 100).toFixed(0)}%`);

  return `${parts.join(', ')}.`;
}
