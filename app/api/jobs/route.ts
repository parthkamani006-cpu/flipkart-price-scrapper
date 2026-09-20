/**
 * GET  /api/jobs — every batch, newest first, with live counts.
 * POST /api/jobs — create a batch from validated rows.
 *
 * Both are short database calls now. The list used to call computeStats() once
 * per batch, re-reading each journal to do it; it is one aggregate query.
 */

import { NextResponse } from 'next/server';
import { createJob, listJobsWithStats } from '@/lib/store/jobStore';
import { activeJobId, reapIfDue } from '@/lib/store/lease';
import { EMPTY_STATS } from '@/lib/store/stats';
import { validateUpload } from '@/lib/validation/uploadSchema';
import { DEFAULT_JOB_OPTIONS, MAX_CONCURRENCY, type JobOptions } from '@/types/dashboard';
import type { OrdersReport } from '@/lib/demand';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // Best-effort, rate-limited: flips batches whose worker stopped reporting to
  // `interrupted`. Nothing depends on it running here — the worker reaps on
  // startup — it just shortens the window in which a dead run still looks live.
  await reapIfDue();

  const [jobs, active] = await Promise.all([listJobsWithStats(), activeJobId()]);
  return NextResponse.json({ jobs, activeJobId: active });
}

export async function POST(request: Request) {
  let body: {
    name?: string;
    accountName?: string;
    rows?: unknown;
    options?: Partial<JobOptions>;
    orders?: OrdersReport | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  // Re-validate server-side. The client already did, but the client is not the
  // authority on what lands in the database.
  const report = validateUpload(JSON.stringify(body.rows ?? []));
  if (!report.ok) {
    return NextResponse.json({ error: 'Rows failed validation.', report }, { status: 400 });
  }

  const options = sanitizeOptions(body.options);
  const name = (body.name ?? '').trim() || `Batch of ${report.rows.length}`;
  // The account defaults to the seller name the rows already carry, so a client
  // that does not send one still lands in the right history.
  const accountName = (body.accountName ?? '').trim() || report.rows[0]?.targetSeller || '';

  try {
    const manifest = await createJob(name, report.rows, options, accountName, ordersOrNull(body.orders));
    // A batch that has just been created has no results, so its counts are the
    // empty set with the row total filled in — no need for a round trip to
    // learn that nothing has happened yet.
    return NextResponse.json(
      { job: manifest, stats: { ...EMPTY_STATS, total: manifest.total, pending: manifest.total, queueLength: manifest.total } },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not create the batch.' },
      { status: 500 },
    );
  }
}

/**
 * Merge the posted options over the defaults, then hold the numeric ones to a
 * sane range.
 *
 * `concurrency` is the one that can hurt: it is the number of browser contexts
 * the run will open at once, so an unchecked value out of a request body is a
 * way to exhaust the machine's memory. (The worker clamps it again against
 * WORKER_MAX_CONCURRENCY, because a GitHub runner is smaller than the laptop
 * this ceiling was chosen for.) The rest are clamped in the same pass because a
 * zero timeout or a negative delay would fail deep inside the scraper rather
 * than here, where the value came from.
 */
function sanitizeOptions(posted: Partial<JobOptions> | undefined): JobOptions {
  const merged: JobOptions = { ...DEFAULT_JOB_OPTIONS, ...(posted ?? {}) };

  const clamp = (value: number, min: number, max: number, fallback: number): number =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;

  return {
    ...merged,
    concurrency: clamp(merged.concurrency, 1, MAX_CONCURRENCY, DEFAULT_JOB_OPTIONS.concurrency),
    delayMs: clamp(merged.delayMs, 0, 600_000, DEFAULT_JOB_OPTIONS.delayMs),
    delayJitterMs: clamp(merged.delayJitterMs, 0, 600_000, DEFAULT_JOB_OPTIONS.delayJitterMs),
    timeout: clamp(merged.timeout, 1_000, 600_000, DEFAULT_JOB_OPTIONS.timeout),
    blockBackoffMs: clamp(merged.blockBackoffMs, 0, 3_600_000, DEFAULT_JOB_OPTIONS.blockBackoffMs),
    blockRetries: clamp(merged.blockRetries, 0, 20, DEFAULT_JOB_OPTIONS.blockRetries),
  };
}

/**
 * Accept an orders report only if it still looks like one.
 *
 * The client posts back what /api/upload parsed, so this is a round-trip check
 * rather than a re-parse: anything without a window and an FSN index is dropped
 * to null, because a malformed report reads downstream as universal zero demand.
 */
function ordersOrNull(orders: OrdersReport | null | undefined): OrdersReport | null {
  if (!orders || typeof orders !== 'object') return null;
  if (typeof orders.windowEnd !== 'string' || typeof orders.observedDays !== 'number') return null;
  if (!orders.byFsn || typeof orders.byFsn !== 'object') return null;
  return orders;
}
