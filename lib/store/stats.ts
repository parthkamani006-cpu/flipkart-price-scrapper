/**
 * JobStats, half in SQL and half here.
 *
 * The counts and the mean duration come from job_stats_v — they are a GROUP BY
 * and belong in the database. The other two fields do not: `successRate` is
 * trivial, and `estimatedRemainingMs` depends on startingPoolWidth() from the
 * scraper itself. Reimplementing that curve in SQL would leave two versions of
 * it to keep in step, and the ETA would start disagreeing with the run it is
 * describing. So the arithmetic stays next to the constant it depends on.
 */

import { startingPoolWidth } from '@/scraper/utils';
import type { JobOptions, JobStats } from '@/types/dashboard';
import type { JobStatsViewDb } from '@/lib/supabase/types';

export const EMPTY_STATS: JobStats = {
  total: 0,
  pending: 0,
  running: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  successRate: null,
  averageMs: null,
  estimatedRemainingMs: null,
  queueLength: 0,
};

export function statsFromView(view: JobStatsViewDb | null | undefined, options: JobOptions): JobStats {
  if (!view) return EMPTY_STATS;

  const total = view.total ?? 0;
  const succeeded = view.succeeded ?? 0;
  const failed = view.failed ?? 0;
  const completed = view.completed ?? succeeded + failed;
  // A worker can report more in flight than there is work left if a progress
  // snapshot outlives the results it describes; clamping keeps `pending` from
  // going negative and the progress bar from overshooting.
  const running = Math.min(Math.max(view.running ?? 0, 0), Math.max(total - completed, 0));
  const pending = Math.max(total - completed - running, 0);

  const averageRaw = view.average_ms === null || view.average_ms === undefined ? null : Number(view.average_ms);
  const averageMs = averageRaw === null || !Number.isFinite(averageRaw) ? null : Math.round(averageRaw);

  // The throttle between products is real wall-clock time; leaving it out makes
  // a 1000-item estimate hours too optimistic. It overlaps the idle-browsing
  // burst rather than following it, so the gap costs the larger of the two, not
  // their sum — and both are per worker.
  const perProductMs =
    averageMs === null ? null : averageMs + options.delayMs + options.delayJitterMs / 2;

  // Workers run in parallel, so N of them retire the queue N times as fast.
  // The divisor is the width the scraper will actually run at, not the number
  // of workers on the manifest: the pool holds itself to what the machine can
  // render at once, so dividing by the manifest figure would quote an ETA no
  // run on that host could meet.
  const workers = Math.max(1, startingPoolWidth(Math.max(1, options.concurrency || 1)));

  return {
    total,
    pending,
    running,
    completed,
    succeeded,
    failed,
    successRate: completed ? Math.round((succeeded / completed) * 1000) / 10 : null,
    averageMs,
    estimatedRemainingMs:
      perProductMs === null ? null : Math.round((perProductMs * (pending + running)) / workers),
    queueLength: pending,
  };
}
