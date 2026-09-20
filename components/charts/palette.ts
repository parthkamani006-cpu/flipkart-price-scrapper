/**
 * Chart palette, from the data-viz reference instance.
 *
 * Two rules this file exists to enforce:
 *   1. Green and red are STATUS colours (good / critical), never categorical
 *      series. They only appear paired in the outcome and throughput charts,
 *      and always beside a direct text label — which is the secondary encoding
 *      that makes the red↔green pair safe for colour-blind readers.
 *   2. Every single-series chart uses one blue. A single series needs no hue
 *      contrast, so there is nothing to get wrong.
 *
 * Both light and dark values are declared; the dashboard renders dark, but the
 * chart tooltip/axis chrome reads its ink from CSS variables so it tracks the
 * app theme regardless.
 */

export const CHART = {
  series: '#3987e5', // categorical slot 1 (blue), for single-series charts
  good: '#0ca30c', // status: succeeded
  critical: '#d03b3b', // status: failed
  pending: '#898781', // muted: not yet run
  // A short, fixed ramp for the few multi-category charts (failure reasons),
  // taken in slot order so identity never depends on rank.
  categorical: ['#3987e5', '#c98500', '#008300', '#d55181', '#9085e9', '#d95926'],
} as const;

export const CHART_INK = {
  grid: 'hsl(var(--border))',
  axis: 'hsl(var(--muted-foreground))',
  text: 'hsl(var(--foreground))',
  surface: 'hsl(var(--card))',
} as const;
