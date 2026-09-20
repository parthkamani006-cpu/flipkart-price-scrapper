/**
 * Deterministic formula generation.
 *
 * When a rule stops predicting an FSN's winning price well, the engine derives a
 * replacement from that FSN's own history. Nothing is learned in the statistical
 * -model sense: this is a fixed library of closed-form estimators, each with at
 * most two free parameters, all fitted by median or least squares, all selected
 * by the same out-of-sample rule.
 *
 * ── Why a library of small estimators, rather than one big fit ───────────────
 *
 * A realistic FSN has between three and twenty observations. That is the whole
 * design constraint. Fitting a many-featured regression to eight points does not
 * find structure, it memorises noise and then predicts confidently wrong prices;
 * and a wide brute-force coefficient search does the same thing more expensively.
 * So every candidate here is deliberately low-capacity, and the winner is chosen
 * by *walk-forward validation* — fit on the first i points, predict point i+1,
 * repeat — which scores each candidate only on data it has not seen. A formula
 * that survives that has actually predicted the future, not described the past.
 *
 * Medians are preferred to means wherever a plain average would do, because
 * scraped price series contain genuine outliers (a competitor dumping stock for
 * a day). A squared-error fit chases those; a median ignores them.
 */

import type { FormulaKind, IntelligenceConfig, Series } from './types';

/** Candidate configurations. Fixed lists, so the search is finite and repeatable. */
const SMA_WINDOWS = [2, 3, 5];
const SES_ALPHAS = [0.2, 0.35, 0.5, 0.65, 0.8];
const HOLT_ALPHAS = [0.3, 0.5, 0.7];
const HOLT_BETAS = [0.1, 0.3, 0.5];

/** Free parameters per kind, for the complexity penalty. */
const COMPLEXITY: Record<FormulaKind, number> = {
  drift: 1,
  sma: 1,
  ses: 1,
  holt: 2,
  ratio: 1,
  'ols-lag1': 2,
  'ols-my': 2,
  'ols-2': 3,
  'theil-sen': 2,
  segmented: 2,
};

/**
 * How hard a candidate is penalised per parameter per observation.
 *
 * The same idea as the small-sample correction in AIC: two candidates that
 * validate equally well are not equally good, and the simpler one will hold up
 * better on the next point. 0.5 is deliberately firm — at n=6 a three-parameter
 * fit must be 25% more accurate than a one-parameter fit to win.
 */
const COMPLEXITY_PENALTY = 0.5;

/* ------------------------------------------------------------ small maths */

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Ordinary least squares for y = a·x + b. Null when x has no spread to fit to. */
function ols1(xs: number[], ys: number[]): [number, number] | null {
  const n = xs.length;
  if (n < 3) return null;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i];
    sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumXX += xs[i] * xs[i];
  }

  const denominator = n * sumXX - sumX * sumX;
  // A flat x column means the slope is unidentifiable — every line through the
  // points is equally good. Returning null lets a simpler candidate take it.
  if (Math.abs(denominator) < 1e-9) return null;

  const a = (n * sumXY - sumX * sumY) / denominator;
  const b = (sumY - a * sumX) / n;
  return [a, b];
}

/**
 * Solve a 3×3 system by Gaussian elimination with partial pivoting.
 *
 * Hand-rolled on purpose: this is the only linear algebra the engine needs, and
 * pulling in a matrix library for one 3×3 solve would be a dependency that has
 * to be trusted, versioned and shipped for no gain.
 */
function solve3(matrix: number[][], rhs: number[]): number[] | null {
  const augmented = matrix.map((row, index) => [...row, rhs[index]]);

  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-9) return null;

    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];

    for (let row = column + 1; row < 3; row += 1) {
      const factor = augmented[row][column] / augmented[column][column];
      for (let k = column; k < 4; k += 1) augmented[row][k] -= factor * augmented[column][k];
    }
  }

  const solution = [0, 0, 0];
  for (let row = 2; row >= 0; row -= 1) {
    let value = augmented[row][3];
    for (let k = row + 1; k < 3; k += 1) value -= augmented[row][k] * solution[k];
    solution[row] = value / augmented[row][row];
  }

  return solution.every(Number.isFinite) ? solution : null;
}

function slice(series: Series, count: number): Series {
  return {
    y: series.y.slice(0, count),
    my: series.my.slice(0, count),
    won: series.won.slice(0, count),
  };
}

/* --------------------------------------------------------------- fitting */

/**
 * Derive a kind's coefficients from a training slice.
 *
 * `hyper` carries the parts of the configuration that are searched rather than
 * derived — the SMA window, the smoothing constants. Everything else is
 * computed from the data.
 */
export function fitParams(kind: FormulaKind, series: Series, hyper: number[]): number[] | null {
  const { y, my, won } = series;
  const n = y.length;

  switch (kind) {
    case 'drift': {
      const deltas: number[] = [];
      for (let i = 1; i < n; i += 1) deltas.push(y[i] - y[i - 1]);
      const value = median(deltas);
      return value === null ? null : [value];
    }

    case 'sma':
      return n >= hyper[0] ? [hyper[0]] : null;

    case 'ses':
      return n >= 2 ? [hyper[0]] : null;

    case 'holt':
      return n >= 3 ? [hyper[0], hyper[1]] : null;

    case 'ratio': {
      const ratios: number[] = [];
      for (let i = 1; i < n; i += 1) {
        if (y[i - 1] !== 0) ratios.push(y[i] / y[i - 1]);
      }
      const value = median(ratios);
      return value === null ? null : [value];
    }

    case 'ols-lag1': {
      // Pairs are (this upload's winner → next upload's winner).
      const xs = y.slice(0, n - 1);
      const ys = y.slice(1);
      return ols1(xs, ys);
    }

    case 'ols-my': {
      // Does our own price move the winner? Sometimes it does — undercutting a
      // reseller who tracks us shifts the whole board.
      const xs = my.slice(0, n - 1);
      const ys = y.slice(1);
      return ols1(xs, ys);
    }

    case 'ols-2': {
      if (n < 5) return null;

      // Normal equations for y' = a·winner + b·myPrice + c, accumulated directly
      // rather than by building a design matrix.
      let sYY = 0;
      let sYM = 0;
      let sY = 0;
      let sMM = 0;
      let sM = 0;
      let count = 0;
      let tY = 0;
      let tM = 0;
      let t1 = 0;

      for (let i = 0; i < n - 1; i += 1) {
        const a = y[i];
        const b = my[i];
        const target = y[i + 1];
        sYY += a * a;
        sYM += a * b;
        sY += a;
        sMM += b * b;
        sM += b;
        count += 1;
        tY += a * target;
        tM += b * target;
        t1 += target;
      }

      return solve3(
        [
          [sYY, sYM, sY],
          [sYM, sMM, sM],
          [sY, sM, count],
        ],
        [tY, tM, t1],
      );
    }

    case 'theil-sen': {
      if (n < 3) return null;

      // Median of all pairwise slopes: the robust answer to "which way is this
      // series trending", immune to a single freak price.
      const slopes: number[] = [];
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) slopes.push((y[j] - y[i]) / (j - i));
      }
      const slope = median(slopes);
      if (slope === null) return null;

      const intercept = median(y.map((value, index) => value - slope * index));
      return intercept === null ? null : [slope, intercept];
    }

    case 'segmented': {
      // The board behaves differently depending on whether we were holding the
      // Buy Box, so the step is estimated separately for the two regimes.
      const heldDeltas: number[] = [];
      const lostDeltas: number[] = [];
      for (let i = 1; i < n; i += 1) {
        const delta = y[i] - y[i - 1];
        if (won[i - 1] === true) heldDeltas.push(delta);
        else if (won[i - 1] === false) lostDeltas.push(delta);
      }

      const allDeltas: number[] = [];
      for (let i = 1; i < n; i += 1) allDeltas.push(y[i] - y[i - 1]);
      const fallback = median(allDeltas);
      if (fallback === null) return null;

      return [median(heldDeltas) ?? fallback, median(lostDeltas) ?? fallback];
    }

    default:
      return null;
  }
}

/**
 * Predict the next winning price from a fitted formula.
 *
 * A pure function of (kind, params, series): the stored parameters plus the
 * stored observations are always enough to reproduce a prediction exactly.
 */
export function evaluateFormula(kind: FormulaKind, params: number[], series: Series): number | null {
  const { y, my, won } = series;
  const n = y.length;
  if (n === 0) return null;

  const last = y[n - 1];

  switch (kind) {
    case 'drift':
      return last + params[0];

    case 'sma': {
      const window = params[0];
      return n >= window ? mean(y.slice(n - window)) : null;
    }

    case 'ses': {
      const alpha = params[0];
      let level = y[0];
      for (let i = 1; i < n; i += 1) level = alpha * y[i] + (1 - alpha) * level;
      return level;
    }

    case 'holt': {
      const [alpha, beta] = params;
      if (n < 2) return null;

      let level = y[0];
      let trend = y[1] - y[0];
      for (let i = 1; i < n; i += 1) {
        const previousLevel = level;
        level = alpha * y[i] + (1 - alpha) * (level + trend);
        trend = beta * (level - previousLevel) + (1 - beta) * trend;
      }
      return level + trend;
    }

    case 'ratio':
      return last * params[0];

    case 'ols-lag1':
      return params[0] * last + params[1];

    case 'ols-my':
      return params[0] * my[n - 1] + params[1];

    case 'ols-2':
      return params[0] * last + params[1] * my[n - 1] + params[2];

    case 'theil-sen':
      // The next point sits at index n on the 0-based axis the fit used.
      return params[0] * n + params[1];

    case 'segmented':
      return last + (won[n - 1] === true ? params[0] : params[1]);

    default:
      return null;
  }
}

/** Every candidate configuration, in a fixed order. */
function candidateConfigs(): { kind: FormulaKind; hyper: number[] }[] {
  const configs: { kind: FormulaKind; hyper: number[] }[] = [
    { kind: 'drift', hyper: [] },
    { kind: 'ratio', hyper: [] },
    { kind: 'ols-lag1', hyper: [] },
    { kind: 'ols-my', hyper: [] },
    { kind: 'ols-2', hyper: [] },
    { kind: 'theil-sen', hyper: [] },
    { kind: 'segmented', hyper: [] },
  ];

  for (const window of SMA_WINDOWS) configs.push({ kind: 'sma', hyper: [window] });
  for (const alpha of SES_ALPHAS) configs.push({ kind: 'ses', hyper: [alpha] });
  for (const alpha of HOLT_ALPHAS) {
    for (const beta of HOLT_BETAS) configs.push({ kind: 'holt', hyper: [alpha, beta] });
  }

  return configs;
}

export interface FormulaDraft {
  kind: FormulaKind;
  hyper: number[];
  params: number[];
  expression: string;
  validationMae: number;
  penalizedMae: number;
  validationPoints: number;
}

/**
 * Walk-forward validation for one candidate configuration.
 *
 * Refits from scratch at every step, which is the honest version: a formula is
 * scored only against points that were in its future at the moment it was
 * fitted. The cost is quadratic in history, which is exactly why history is
 * capped — at 24 observations the whole search is a few thousand operations.
 */
function walkForward(
  kind: FormulaKind,
  hyper: number[],
  series: Series,
  minTrain: number,
): { mae: number; points: number } | null {
  let sum = 0;
  let points = 0;

  for (let i = minTrain; i < series.y.length; i += 1) {
    const train = slice(series, i);
    const params = fitParams(kind, train, hyper);
    if (!params) continue;

    const predicted = evaluateFormula(kind, params, train);
    if (predicted === null || !Number.isFinite(predicted)) continue;

    sum += Math.abs(predicted - series.y[i]);
    points += 1;
  }

  return points > 0 ? { mae: sum / points, points } : null;
}

function describe(kind: FormulaKind, params: number[]): string {
  const round = (value: number, digits = 3) => Number(value.toFixed(digits));

  switch (kind) {
    case 'drift':
      return `next = last_winner ${params[0] >= 0 ? '+' : '−'} ${Math.abs(round(params[0], 2))}`;
    case 'sma':
      return `next = mean(last ${params[0]} winner prices)`;
    case 'ses':
      return `next = exponential smoothing of winner price (α=${round(params[0], 2)})`;
    case 'holt':
      return `next = Holt level + trend (α=${round(params[0], 2)}, β=${round(params[1], 2)})`;
    case 'ratio':
      return `next = last_winner × ${round(params[0], 4)}`;
    case 'ols-lag1':
      return `next = ${round(params[0])} × last_winner ${params[1] >= 0 ? '+' : '−'} ${Math.abs(round(params[1], 2))}`;
    case 'ols-my':
      return `next = ${round(params[0])} × my_price ${params[1] >= 0 ? '+' : '−'} ${Math.abs(round(params[1], 2))}`;
    case 'ols-2':
      return `next = ${round(params[0])} × last_winner + ${round(params[1])} × my_price ${
        params[2] >= 0 ? '+' : '−'
      } ${Math.abs(round(params[2], 2))}`;
    case 'theil-sen':
      return `next = ${round(params[0])} × upload_index ${params[1] >= 0 ? '+' : '−'} ${Math.abs(round(params[1], 2))} (robust trend)`;
    case 'segmented':
      return `next = last_winner + (held Buy Box ? ${round(params[0], 2)} : ${round(params[1], 2)})`;
    default:
      return 'unknown';
  }
}

/**
 * Fit every candidate against an FSN's history and return them best-first.
 *
 * Returns drafts, not stored formulas — the caller decides how many to keep
 * active and reconciles them with what is already in the repository.
 */
export function generateFormulas(series: Series, config: IntelligenceConfig): FormulaDraft[] {
  if (series.y.length < config.minObservationsToFit) return [];

  // Leave enough points ahead of the first fit for the validation to mean
  // something: three training points and at least two scored predictions.
  const minTrain = Math.max(3, Math.min(series.y.length - 2, config.minObservationsToFit - 2));
  const drafts: FormulaDraft[] = [];

  for (const { kind, hyper } of candidateConfigs()) {
    const validation = walkForward(kind, hyper, series, minTrain);
    if (!validation) continue;

    // Refit on everything once the configuration has proved itself, so the
    // stored formula uses every observation available.
    const params = fitParams(kind, series, hyper);
    if (!params || !params.every(Number.isFinite)) continue;

    const check = evaluateFormula(kind, params, series);
    if (check === null || !Number.isFinite(check) || check <= 0) continue;

    const penalty = 1 + (COMPLEXITY_PENALTY * COMPLEXITY[kind]) / Math.max(1, validation.points);

    drafts.push({
      kind,
      hyper,
      params,
      expression: describe(kind, params),
      validationMae: validation.mae,
      penalizedMae: validation.mae * penalty,
      validationPoints: validation.points,
    });
  }

  // Keep only the best configuration per kind — the SMA windows and smoothing
  // constants are a search, not nine separate rules competing for the podium.
  const bestPerKind = new Map<FormulaKind, FormulaDraft>();
  for (const draft of drafts) {
    const existing = bestPerKind.get(draft.kind);
    if (!existing || draft.penalizedMae < existing.penalizedMae) bestPerKind.set(draft.kind, draft);
  }

  return [...bestPerKind.values()].sort(
    (left, right) => left.penalizedMae - right.penalizedMae || left.kind.localeCompare(right.kind),
  );
}
