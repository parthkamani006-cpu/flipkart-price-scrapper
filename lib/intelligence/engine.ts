/**
 * The per-FSN learning cycle.
 *
 * One upload of one FSN runs this sequence, and nothing else ever mutates an
 * intelligence record:
 *
 *   1. settle   — score the predictions made last time against what actually
 *                 happened, updating every predictor's accumulators. O(k).
 *   2. observe  — append the new observation to the capped history. O(1).
 *   3. refit    — regenerate formulas, but only when the champion missed or the
 *                 cadence is due. This is the expensive step and it is the one
 *                 that is deliberately skipped most of the time.
 *   4. evaluate — ask every predictor for the next winning price. O(k).
 *   5. rank     — score, sort, take the top three, and decide whether the
 *                 challenger has earned the crown. O(k log k).
 *   6. commit   — record what was predicted by whom, so step 1 has something to
 *                 score next time.
 *
 * Steps 1, 2, 4, 5 and 6 are all linear in the number of predictors, which is
 * bounded (five rules plus at most three active formulas). Step 3 is bounded by
 * the history cap. So the cost of an upload is proportional to the rows in that
 * upload, never to the size of the account's history.
 */

import { generateFormulas } from './formulas';
import { compareMetrics, deriveMetrics, emptyStats, explainRank, toleranceFor, updateStats } from './metrics';
import { evaluatePredictors, labelFor, seriesFrom, type PredictorOutput } from './predictors';
import type {
  FsnIntelligence,
  GeneratedFormula,
  IntelligenceConfig,
  Observation,
  PerformancePoint,
  RankedPredictor,
} from './types';

export interface UploadDecision {
  fsn: string;
  jobId: string;
  championId: string | null;
  championLabel: string;
  championKind: 'rule' | 'formula';
  /** The champion's prediction of the next winning price. */
  predictedWinnerPrice: number | null;
  confidence: number;
  accuracyPct: number | null;
  averageError: number | null;
  timesUsed: number;
  lastUsedAt: string | null;
  formula?: string;
  /** True when the champion has enough evidence for its price to be acted on. */
  trusted: boolean;
  ranking: RankedPredictor[];
  reason: string;
}

/* ------------------------------------------------------------- 1. settle */

/**
 * Score the previous upload's predictions against what the board actually did.
 *
 * Every predictor that had an opinion is scored, not just the one that was used
 * — that is the whole point of storing all of them. A rule can therefore build a
 * track record while sitting on the bench, and take over the moment it is
 * demonstrably better.
 */
function settlePending(
  record: FsnIntelligence,
  actual: Observation,
  config: IntelligenceConfig,
): PerformancePoint | null {
  const pending = record.pending;
  if (!pending) return null;

  // A prediction whose follow-up never arrived is dropped rather than scored
  // against a stale actual: the board has moved on and the comparison would be
  // meaningless.
  const ageDays = (Date.parse(actual.t) - Date.parse(pending.t)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays > config.maxPendingAgeDays) {
    record.pending = null;
    return null;
  }

  for (const [predictorId, predicted] of Object.entries(pending.candidates)) {
    const stats = (record.stats[predictorId] ??= emptyStats(predictorId));
    updateStats(stats, predicted, actual.winnerPrice, config);
  }

  const selectedPrediction = pending.predictedWinnerPrice;
  const absError = selectedPrediction === null ? null : Math.abs(selectedPrediction - actual.winnerPrice);

  record.pending = null;

  return {
    t: actual.t,
    jobId: actual.jobId,
    myPrice: actual.myPrice,
    actualWinnerPrice: actual.winnerPrice,
    predictedPrice: selectedPrediction,
    championId: pending.selected,
    absError,
    hit: absError === null ? null : absError <= toleranceFor(actual.winnerPrice, config),
  };
}

/* -------------------------------------------------------------- 3. refit */

/**
 * Decide whether to spend the fitting budget on this FSN.
 *
 * Refitting on every upload would be pure waste — a formula that predicted well
 * last time will fit to almost the same coefficients this time. So it happens
 * when the evidence says something changed: the champion missed its tolerance,
 * there is nothing fitted yet, or enough new observations have accumulated that
 * the old fit is stale.
 */
function shouldRefit(record: FsnIntelligence, missed: boolean, config: IntelligenceConfig): boolean {
  const count = record.observations.length;
  if (count < config.minObservationsToFit) return false;
  if (record.formulas.length === 0) return true;
  if (missed) return true;
  return count - record.lastRefitAt >= config.refitEveryN;
}

/**
 * Regenerate this FSN's formulas and reconcile them with the repository.
 *
 * Existing entries are updated in place rather than replaced so their accrued
 * metrics survive a refit; a kind that drops out of the top set is marked
 * inactive rather than deleted, because the repository is an audit trail as much
 * as a working set.
 */
function refitFormulas(record: FsnIntelligence, config: IntelligenceConfig, now: string): void {
  const drafts = generateFormulas(seriesFrom(record.observations), config);
  record.lastRefitAt = record.observations.length;
  if (drafts.length === 0) return;

  const keep = drafts.slice(0, config.activeFormulas);
  const keepIds = new Set(keep.map((draft) => `fit:${draft.kind}`));

  for (const draft of keep) {
    const id = `fit:${draft.kind}`;
    const existing = record.formulas.find((formula) => formula.id === id);

    if (existing) {
      existing.params = draft.params;
      existing.expression = draft.expression;
      existing.validationMae = draft.validationMae;
      existing.validationPoints = draft.validationPoints;
      existing.status = 'active';
      existing.updatedAt = now;
      continue;
    }

    const formula: GeneratedFormula = {
      id,
      fsn: record.fsn,
      kind: draft.kind,
      params: draft.params,
      expression: draft.expression,
      createdAt: now,
      updatedAt: now,
      validationMae: draft.validationMae,
      validationPoints: draft.validationPoints,
      status: 'active',
    };
    record.formulas.push(formula);
  }

  for (const formula of record.formulas) {
    if (!keepIds.has(formula.id) && formula.status === 'active') {
      formula.status = 'inactive';
      formula.updatedAt = now;
    }
  }
}

/* --------------------------------------------------------------- 5. rank */

function rankPredictors(
  record: FsnIntelligence,
  outputs: PredictorOutput[],
  config: IntelligenceConfig,
): RankedPredictor[] {
  const byId = new Map(outputs.map((output) => [output.id, output]));

  // Everything with either a track record or a current opinion is ranked, so a
  // newly fitted formula is visible from the upload it first appears in.
  const ids = new Set([...Object.keys(record.stats), ...byId.keys()]);

  const ranked = [...ids]
    .map((id) => deriveMetrics(record.stats[id] ?? emptyStats(id), config))
    .sort(compareMetrics)
    .map((metrics, index): RankedPredictor => {
      const output = byId.get(metrics.id);
      return {
        ...metrics,
        rank: index + 1,
        label: output?.label ?? labelFor(metrics.id, record.formulas),
        kind: output?.kind ?? (metrics.id.startsWith('fit:') ? 'formula' : 'rule'),
        price: output?.price ?? null,
        formula: output?.formula,
        reason: explainRank(metrics, config),
      };
    });

  return ranked;
}

/**
 * Champion selection, with hysteresis.
 *
 * A crown that changes hands on every score wobble is worse than a slightly
 * suboptimal one: the recommended price would jitter between rules for reasons
 * no user could follow. The guard is a *streak* rather than a score threshold,
 * and that choice matters — the gap between two good predictors is a hundredth
 * or two of score, so any threshold big enough to feel safe is also big enough
 * to freeze whoever happened to be crowned first, and the engine would stop
 * improving. Requiring the challenger to lead for several uploads running is
 * scale-free: it cannot be mis-tuned into permanence.
 */
function selectChampion(
  record: FsnIntelligence,
  ranked: RankedPredictor[],
  config: IntelligenceConfig,
): string | null {
  const eligible = ranked.filter(
    (entry) => entry.n >= config.minObservationsToTrust && entry.price !== null,
  );
  if (eligible.length === 0) return record.champion ?? null;

  const leader = eligible[0];
  const incumbent = record.champion ? ranked.find((entry) => entry.id === record.champion) : undefined;

  // Nothing established yet, or the incumbent has lost its evidence (its formula
  // was refitted out of the active set): take the leader outright.
  if (!incumbent || incumbent.n < config.minObservationsToTrust) {
    record.challenger = null;
    return leader.id;
  }

  if (leader.id === incumbent.id) {
    record.challenger = null;
    return incumbent.id;
  }

  if (leader.score - incumbent.score <= config.promotionMargin) {
    record.challenger = null;
    return incumbent.id;
  }

  const streak = record.challenger?.id === leader.id ? record.challenger.streak + 1 : 1;
  record.challenger = { id: leader.id, streak };

  if (streak >= config.promotionStreak) {
    record.challenger = null;
    return leader.id;
  }

  return incumbent.id;
}

/* ------------------------------------------------------------ the cycle */

/**
 * Run one upload of one FSN through the engine and return what it recommends.
 *
 * Idempotency is the caller's job: ingesting the same job twice would score the
 * same outcome twice. `syncAccount` in the store guards that with a processed-job
 * list.
 */
export function processObservation(
  record: FsnIntelligence,
  observation: Observation,
  config: IntelligenceConfig,
): UploadDecision {
  const now = new Date().toISOString();

  /* 1. settle */
  const point = settlePending(record, observation, config);
  if (point) {
    record.performance.push(point);
    if (record.performance.length > config.historyLimit) record.performance.shift();
  }

  /* 2. observe */
  record.observations.push(observation);
  if (record.observations.length > config.historyLimit) record.observations.shift();

  /* 3. refit */
  if (shouldRefit(record, point?.hit === false, config)) refitFormulas(record, config, now);

  /* 4. evaluate */
  const outputs = evaluatePredictors(record.observations, record.formulas);

  /* 5. rank */
  const ranked = rankPredictors(record, outputs, config);
  record.ranking = ranked.slice(0, 3);
  record.champion = selectChampion(record, ranked, config);

  const champion =
    ranked.find((entry) => entry.id === record.champion && entry.price !== null) ??
    ranked.find((entry) => entry.price !== null) ??
    null;

  const trusted =
    champion !== null &&
    champion.n >= config.minObservationsToTrust &&
    champion.confidence >= config.minConfidenceToLead;

  /* 6. commit */
  const candidates: Record<string, number> = {};
  for (const output of outputs) {
    if (output.price !== null) candidates[output.id] = output.price;
  }

  record.pending = {
    jobId: observation.jobId,
    t: observation.t,
    candidates,
    selected: champion?.id ?? 'rule:engine',
    selectedPrice: champion?.price ?? null,
    predictedWinnerPrice: champion?.price ?? null,
    blockedBySettlement: false,
  };

  if (champion) {
    const stats = (record.stats[champion.id] ??= emptyStats(champion.id));
    stats.timesSelected += 1;
    stats.lastUsedAt = observation.t;
  }

  record.updatedAt = now;

  return {
    fsn: record.fsn,
    jobId: observation.jobId,
    championId: champion?.id ?? null,
    championLabel: champion?.label ?? 'Rule engine (rules 4/6/7)',
    championKind: champion?.kind ?? 'rule',
    predictedWinnerPrice: champion?.price ?? null,
    confidence: champion?.confidence ?? 0,
    accuracyPct: champion?.accuracyPct ?? null,
    averageError: champion?.mae ?? null,
    timesUsed: champion?.timesSelected ?? 0,
    lastUsedAt: champion?.lastUsedAt ?? null,
    formula: champion?.formula,
    trusted,
    ranking: record.ranking,
    reason: champion
      ? champion.reason
      : 'Not enough scored predictions yet — the predefined rules are still in charge.',
  };
}
