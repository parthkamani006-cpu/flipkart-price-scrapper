/**
 * Per-FSN pricing intelligence — the data model.
 *
 * The whole engine rests on one reframing: every pricing rule, and every formula
 * derived from history, is answering the same question —
 *
 *     what price will win the Buy Box at the next upload?
 *
 * That question has a ground truth we already collect: the winning price
 * observed the next time the FSN is scraped. So each rule becomes a *predictor*
 * of a measurable number, its error is observable, and "which rule is best for
 * this FSN" stops being an opinion. "Match the winner price" is simply the naive
 * last-value predictor; the existing rule chain is one policy among several.
 *
 * Nothing here is learned in the machine-learning sense. Every estimator is a
 * closed-form statistic (median, least squares, exponential smoothing) selected
 * by out-of-sample error over a fixed candidate list, evaluated in a fixed
 * order. The same history always produces the same formula, byte for byte.
 */

/* ---------------------------------------------------------------- config */

export interface IntelligenceConfig {
  /** A prediction counts as a hit within max(toleranceAbs, actual × tolerancePct). */
  toleranceAbs: number;
  tolerancePct: number;
  /** Observations kept per FSN. Caps both memory and every fitting loop. */
  historyLimit: number;
  /** Below this, no formula is generated: fitting 5 parameters to 3 points is noise. */
  minObservationsToFit: number;
  /** Scored predictions a predictor needs before it may take the crown. */
  minObservationsToTrust: number;
  /** Refit cadence when the champion is behaving; a miss forces a refit anyway. */
  refitEveryN: number;
  /**
   * A challenger must beat the champion's score by this much to count as ahead.
   * Deliberately small: the gap between two decent predictors is a hundredth or
   * two, so a large margin does not add caution, it freezes whoever was crowned
   * first.
   */
  promotionMargin: number;
  /**
   * …and must stay ahead for this many consecutive uploads before it takes over.
   * This is what actually prevents flapping — a streak requirement cannot be
   * mis-scaled the way a score threshold can.
   */
  promotionStreak: number;
  /** Weight of the newest error in the recent-accuracy EWMA. */
  ewmaAlpha: number;
  /** How many generated formulas stay active (and therefore evaluated) per FSN. */
  activeFormulas: number;
  /** A prediction with no follow-up upload this old is dropped unscored. */
  maxPendingAgeDays: number;
  /** Confidence a champion needs before its price overrides the static rules. */
  minConfidenceToLead: number;
  /** Ranking weights. Must be read together with `scorePredictor`. */
  weights: { hit: number; accuracy: number; recency: number; bias: number };
}

export const DEFAULT_INTELLIGENCE_CONFIG: IntelligenceConfig = {
  toleranceAbs: 2,
  tolerancePct: 0.02,
  historyLimit: 24,
  minObservationsToFit: 5,
  minObservationsToTrust: 4,
  refitEveryN: 4,
  promotionMargin: 0.01,
  promotionStreak: 2,
  ewmaAlpha: 0.35,
  activeFormulas: 3,
  maxPendingAgeDays: 60,
  minConfidenceToLead: 0.25,
  // Hit rate and accuracy carry equal weight: the first stops a lucky one-off
  // taking the crown, the second stops an established rule keeping it purely by
  // seniority once a sharper predictor exists.
  weights: { hit: 0.35, accuracy: 0.35, recency: 0.25, bias: 0.05 },
};

/* ---------------------------------------------------------- observations */

/** One upload's facts for one FSN. The only input the engine ever learns from. */
export interface Observation {
  jobId: string;
  /** The upload's time — the series is ordered by this, never by insertion. */
  t: string;
  myPrice: number;
  /** The Buy Box price on the page. This is the series being predicted. */
  winnerPrice: number;
  hasBuybox: boolean | null;
  currentSettlement: number | null;
  minSettlement: number | null;
}

/** The columns the estimators read, extracted once per fit. */
export interface Series {
  y: number[];
  my: number[];
  won: (boolean | null)[];
}

/* -------------------------------------------------------------- formulas */

export type FormulaKind =
  | 'drift'
  | 'sma'
  | 'ses'
  | 'holt'
  | 'ratio'
  | 'ols-lag1'
  | 'ols-my'
  | 'ols-2'
  | 'theil-sen'
  | 'segmented';

/**
 * A derived formula, stored as kind + coefficients rather than as code.
 *
 * Persisting parameters instead of an expression string means evaluation is a
 * pure function of data the file already holds — nothing is ever eval'd, and a
 * formula written by an older version still evaluates identically.
 */
export interface GeneratedFormula {
  /** Predictor id, e.g. `fit:holt`. Unique per FSN, stable across refits. */
  id: string;
  fsn: string;
  kind: FormulaKind;
  params: number[];
  /** Human-readable form, for the UI and for auditing. Never parsed back. */
  expression: string;
  createdAt: string;
  updatedAt: string;
  /** Walk-forward mean absolute error measured when this formula was fitted. */
  validationMae: number;
  /** Out-of-sample predictions the validation was measured over. */
  validationPoints: number;
  /** Inactive formulas are kept for the audit trail but no longer evaluated. */
  status: 'active' | 'inactive';
}

/* --------------------------------------------------------------- metrics */

/**
 * Incrementally maintained error accumulators.
 *
 * Every field is a running sum, so scoring one new outcome is O(1) and no metric
 * ever requires a pass over history. This is what keeps a 10,000-FSN account
 * cheap to update.
 */
export interface PredictorStats {
  id: string;
  n: number;
  sumAbsErr: number;
  sumSqErr: number;
  sumSignedErr: number;
  sumAbsPctErr: number;
  /** Denominator for MAPE — excludes observations where the actual was zero. */
  pctErrN: number;
  sumActual: number;
  hits: number;
  /** Exponentially weighted |error|: recent accuracy, in rupees. */
  ewmaAbsErr: number | null;
  lastErr: number | null;
  /** How often this predictor's price was the one recommended. */
  timesSelected: number;
  lastUsedAt: string | null;
}

/** Everything the ranking and the UI need, derived from the accumulators. */
export interface PredictorMetrics {
  id: string;
  n: number;
  mae: number | null;
  rmse: number | null;
  mape: number | null;
  bias: number | null;
  hitRate: number | null;
  /** Wilson lower bound on the hit rate — the sample-size-aware confidence. */
  confidence: number;
  recentMae: number | null;
  /** Average miss as a percentage of the price — the human-readable figure. */
  accuracyPct: number | null;
  /** Average miss in tolerance-bands. Below 1 means it typically lands inside. */
  toleranceRatio: number | null;
  score: number;
  timesSelected: number;
  lastUsedAt: string | null;
}

export interface RankedPredictor extends PredictorMetrics {
  rank: number;
  label: string;
  kind: 'rule' | 'formula';
  /** Its candidate price for the next upload, when it produced one. */
  price: number | null;
  formula?: string;
  /** Why it landed at this rank, in words. */
  reason: string;
}

/* -------------------------------------------------------------- pending */

/**
 * The predictions made at the last upload, waiting for an actual to score against.
 *
 * Every predictor's output is stored, not just the selected one — that is what
 * makes it possible to ask "how would the rule we *didn't* use have done?"
 * without ever re-running history.
 */
export interface PendingPrediction {
  jobId: string;
  t: string;
  /** predictorId → predicted next winning price. */
  candidates: Record<string, number>;
  selected: string;
  /** The price actually recommended, after the settlement veto. */
  selectedPrice: number | null;
  /** The champion's raw prediction, before any business gate. */
  predictedWinnerPrice: number | null;
  blockedBySettlement: boolean;
}

/** One point of the per-FSN accuracy chart. */
export interface PerformancePoint {
  t: string;
  jobId: string;
  myPrice: number;
  actualWinnerPrice: number;
  predictedPrice: number | null;
  championId: string | null;
  absError: number | null;
  hit: boolean | null;
}

/* -------------------------------------------------------------- the file */

export interface FsnIntelligence {
  fsn: string;
  accountName: string;
  /** Oldest first. Capped at `historyLimit`. */
  observations: Observation[];
  stats: Record<string, PredictorStats>;
  formulas: GeneratedFormula[];
  pending: PendingPrediction | null;
  performance: PerformancePoint[];
  champion: string | null;
  /** Who is currently out-scoring the champion, and for how many uploads running. */
  challenger: { id: string; streak: number } | null;
  /** Top three, recomputed whenever the FSN is touched. */
  ranking: RankedPredictor[];
  /** Observation count at the last refit, so cadence is data-driven not clock-driven. */
  lastRefitAt: number;
  updatedAt: string;
}

export function emptyIntelligence(fsn: string, accountName: string): FsnIntelligence {
  return {
    fsn,
    accountName,
    observations: [],
    stats: {},
    formulas: [],
    pending: null,
    performance: [],
    champion: null,
    challenger: null,
    ranking: [],
    lastRefitAt: 0,
    updatedAt: new Date().toISOString(),
  };
}
