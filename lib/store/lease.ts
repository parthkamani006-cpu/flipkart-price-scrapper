/**
 * The job lease — claiming, holding and reaping.
 *
 * This replaces two things that only worked inside one process:
 * `globalThis.__jobRunner.active` (which batch is running) and
 * lib/services/recovery.ts (noticing that a batch claimed to be running when
 * no runner existed). Both were true observations about the local process and
 * meaningless once the scraper moved to GitHub Actions.
 *
 * The database now holds the answer. A worker claims a batch with a conditional
 * UPDATE, extends the lease while it works, and releases it when it stops. A
 * lease that stops being extended is, by definition, a worker that stopped —
 * which is exactly what "interrupted" means.
 *
 * The SQL for all of this is supabase/migrations/0004_claim.sql.
 */

import { supabaseAdmin } from '@/lib/supabase/admin';
import { toManifest } from '@/lib/store/mappers';
import type { JobManifest } from '@/types/dashboard';
import { ACTIVE_STATES } from '@/types/dashboard';
import type { JobRowDb } from '@/lib/supabase/types';

/** How long a claim is good for before a reaper may take it. */
export const LEASE_SECONDS = 900;

/**
 * Claim a batch to run.
 *
 * With `jobId` null this takes the oldest queued one, which is what a scheduled
 * run does. Returns null when there was nothing to claim — an idle scheduled
 * run, or a race lost to another runner. Neither is an error.
 */
export async function claimJob(
  jobId: string | null,
  owner: string,
  leaseSeconds = LEASE_SECONDS,
): Promise<JobManifest | null> {
  const { data, error } = await supabaseAdmin().rpc('claim_job', {
    p_job_id: jobId,
    p_owner: owner,
    p_lease_seconds: leaseSeconds,
  });

  if (error) throw new Error(`Could not claim a batch: ${error.message}`);

  const rows = (data ?? []) as JobRowDb[];
  return rows.length ? toManifest(rows[0]) : null;
}

/**
 * Extend the lease.
 *
 * False means the lease is no longer ours — reaped, or re-claimed by another
 * runner. The worker treats that as a stop signal rather than carrying on and
 * racing whoever holds it now.
 */
export async function heartbeatJob(
  jobId: string,
  owner: string,
  leaseSeconds = LEASE_SECONDS,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('heartbeat_job', {
    p_job_id: jobId,
    p_owner: owner,
    p_lease_seconds: leaseSeconds,
  });

  if (error) return false;
  return data === true;
}

/** The terminal write: set the final state and drop the lease. */
export async function releaseJob(
  jobId: string,
  owner: string,
  state: JobManifest['state'],
  errorMessage: string | null = null,
): Promise<JobManifest | null> {
  const { data, error } = await supabaseAdmin().rpc('release_job', {
    p_job_id: jobId,
    p_owner: owner,
    p_state: state,
    p_error: errorMessage,
  });

  if (error) throw new Error(`Could not finish the batch: ${error.message}`);

  const rows = (data ?? []) as JobRowDb[];
  return rows.length ? toManifest(rows[0]) : null;
}

/**
 * Mark batches whose lease has expired as interrupted.
 *
 * Returns how many were flipped. Safe to call at any time, from anywhere.
 */
export async function reapStaleJobs(): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc('reap_stale_jobs');
  if (error) return 0;
  return typeof data === 'number' ? data : 0;
}

/**
 * A cheap, best-effort reap for request handlers.
 *
 * The filesystem version ran recovery once per process and pinned a flag to
 * globalThis to make that true across Next's per-route module instances. There
 * is no process to be "once per" any more, so this is a plain rate limit on a
 * cheap statement: a serverless instance reaps at most every 30 seconds, and
 * every instance that never gets a request never reaps at all.
 *
 * Nothing depends on this running. It only shortens the window in which a
 * crashed batch still looks busy; the worker reaps on startup, which is the
 * moment that actually matters.
 */
const REAP_INTERVAL_MS = 30_000;
let lastReapAt = 0;

export async function reapIfDue(): Promise<void> {
  const now = Date.now();
  if (now - lastReapAt < REAP_INTERVAL_MS) return;
  lastReapAt = now;

  try {
    await reapStaleJobs();
  } catch {
    // A reap that fails is a slightly stale state column, not a failed request.
  }
}

/**
 * The batch a worker currently holds, if any.
 *
 * The dashboard shows "another batch is running, only one runs at a time", and
 * that is still true — the workflow's concurrency group allows one scraper run
 * at a time. This is how the UI finds out which one.
 */
export async function activeJobId(): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('jobs')
    .select('id')
    .in('state', ACTIVE_STATES as unknown as string[])
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return (data as { id: string }).id;
}
