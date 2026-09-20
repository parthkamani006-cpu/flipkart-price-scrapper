/**
 * The predictor set: the predefined rules and the generated formulas, evaluated
 * through one interface.
 *
 * The unification that makes the whole engine work is that a pricing rule and a
 * fitted formula are the same kind of object — a function from an FSN's history
 * to a predicted next winning price. Once "match the winner price" is understood
 * as the naive last-value forecast, it can be scored against a Holt trend on
 * equal terms, and "which rule is best for this FSN" becomes arithmetic.
 */

import {
  summarizeHistory,
  staticRuleTarget,
  type RecommendationHistorySummary,
} from './legacyRules';
import { evaluateFormula } from './formulas';
import type { GeneratedFormula, Observation, Series } from './types';

export interface PredictorOutput {
  id: string;
  label: string;
  kind: 'rule' | 'formula';
  /** Predicted winning price at the next upload. Null when it cannot answer. */
  price: number | null;
  formula?: string;
}

export const PREDICTOR_LABELS: Record<string, string> = {
  'rule:hold': 'Hold current price',
  'rule:match-winner': 'Match winner price',
  'rule:undercut-1': 'Undercut winner by ₹1',
  'rule:proven-price': 'Historically proven winning price',
  'rule:engine': 'Rule engine (rules 4/6/7)',
};

export function seriesFrom(observations: Observation[]): Series {
  return {
    y: observations.map((observation) => observation.winnerPrice),
    my: observations.map((observation) => observation.myPrice),
    won: observations.map((observation) => observation.hasBuybox),
  };
}

/**
 * Rebuild the rule engine's own history summary from stored observations.
 *
 * The observations already *are* the account-wise per-FSN history, so this needs
 * no second scan of the job folders — and it guarantees the rule engine is
 * scored on exactly the history the learner saw.
 */
export function historySummaryFrom(observations: Observation[]): RecommendationHistorySummary {
  // summarizeHistory expects newest first; observations are stored oldest first.
  return summarizeHistory(
    [...observations].reverse().map((observation) => ({
      jobId: observation.jobId,
      jobName: '',
      uploadTime: observation.t,
      myPrice: observation.myPrice,
      winnerPrice: observation.winnerPrice,
      winningSeller: null,
      hasBuybox: observation.hasBuybox,
    })),
  );
}

/** The most frequent winning price this FSN has ever shown, ties going to the newest. */
function provenPrice(series: Series): number | null {
  if (series.y.length === 0) return null;

  const frequency = new Map<number, number>();
  for (const price of series.y) frequency.set(price, (frequency.get(price) ?? 0) + 1);

  let best: number | null = null;
  let bestCount = 0;
  for (const [price, count] of frequency) {
    if (count > bestCount) {
      best = price;
      bestCount = count;
    }
  }

  return bestCount >= 2 ? best : null;
}

/**
 * Every predictor's answer for the next upload, given history up to and
 * including the current one.
 *
 * A predictor that cannot answer returns null rather than a guess — an abstained
 * prediction is never scored, so a formula is not punished for the observations
 * it honestly had nothing to say about.
 */
export function evaluatePredictors(
  observations: Observation[],
  formulas: GeneratedFormula[],
): PredictorOutput[] {
  const series = seriesFrom(observations);
  if (series.y.length === 0) return [];

  const last = observations[observations.length - 1];
  const lastWinner = series.y[series.y.length - 1];
  const outputs: PredictorOutput[] = [];

  const push = (id: string, price: number | null, kind: 'rule' | 'formula' = 'rule', formula?: string) => {
    // A price below ₹1, or an order of magnitude away from the current board, is
    // an arithmetic accident rather than a forecast. Dropping it here keeps a
    // degenerate fit from ever reaching the settlement gate.
    const usable =
      price !== null && Number.isFinite(price) && price >= 1 && price <= lastWinner * 10 ? Math.round(price) : null;

    outputs.push({ id, label: PREDICTOR_LABELS[id] ?? id, kind, price: usable, formula });
  };

  /* ---- the predefined rules, as predictors ------------------------------ */

  push('rule:hold', last.myPrice);
  push('rule:match-winner', lastWinner);
  push('rule:undercut-1', lastWinner - 1);
  push('rule:proven-price', provenPrice(series) ?? lastWinner);

  // The existing chain, scored as a single policy. It only has an opinion when
  // the winner undercuts us; otherwise its answer is "keep the current price",
  // which is what it would do.
  const summary = historySummaryFrom(observations);
  const enginePrice =
    lastWinner < last.myPrice ? staticRuleTarget(last.myPrice, lastWinner, summary).target : last.myPrice;
  push('rule:engine', enginePrice);

  /* ---- the generated formulas ------------------------------------------ */

  for (const formula of formulas) {
    if (formula.status !== 'active') continue;
    push(formula.id, evaluateFormula(formula.kind, formula.params, series), 'formula', formula.expression);
  }

  return outputs;
}

export function labelFor(id: string, formulas: GeneratedFormula[]): string {
  if (PREDICTOR_LABELS[id]) return PREDICTOR_LABELS[id];
  const formula = formulas.find((entry) => entry.id === id);
  return formula ? `Generated: ${formula.kind}` : id;
}
