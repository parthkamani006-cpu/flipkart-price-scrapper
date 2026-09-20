/**
 * Analytics, computed in Postgres.
 *
 * This was six group-bys, a histogram and a median run in Node over a fully
 * materialised row array. All of it is now one `job_analytics` call
 * (supabase/migrations/0002_views.sql) — the same arithmetic, done where the
 * rows already are, in one round trip instead of a full table read.
 *
 * One behavioural fix came with the move. The old per-hour buckets were built
 * from `date.getHours()`, i.e. the clock of whatever machine happened to be
 * serving. On a developer's laptop that was IST; on Vercel it would silently
 * have become UTC and shifted every bar. The timezone is now explicit.
 */

import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AnalyticsPayload } from '@/lib/api';

/** Matches the default in the SQL function. Override with ANALYTICS_TIMEZONE. */
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export const EMPTY_ANALYTICS: AnalyticsPayload = {
  outcome: [
    { name: 'Succeeded', value: 0 },
    { name: 'Failed', value: 0 },
    { name: 'Pending', value: 0 },
  ],
  failureReasons: [],
  sellers: [],
  perHour: [],
  durations: [],
  averageMs: null,
  medianMs: null,
};

export async function computeAnalytics(jobId: string): Promise<AnalyticsPayload> {
  const { data, error } = await supabaseAdmin().rpc('job_analytics', {
    p_job_id: jobId,
    p_tz: process.env.ANALYTICS_TIMEZONE || DEFAULT_TIMEZONE,
  });

  if (error) throw new Error(`Could not compute analytics: ${error.message}`);
  if (!data) return EMPTY_ANALYTICS;

  // Postgres hands back numeric for the two averages; the charts want numbers.
  const payload = data as AnalyticsPayload;
  return {
    ...payload,
    averageMs: toNumber(payload.averageMs),
    medianMs: toNumber(payload.medianMs),
  };
}

function toNumber(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
