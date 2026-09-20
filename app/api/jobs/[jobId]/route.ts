/**
 * GET    /api/jobs/:jobId — manifest, stats and current progress.
 * DELETE /api/jobs/:jobId — remove a batch and everything it wrote.
 */

import { NextResponse } from 'next/server';
import { computeStats, deleteJob, getJobRow } from '@/lib/store/jobStore';
import { toManifest } from '@/lib/store/mappers';
import { activeJobId, reapIfDue } from '@/lib/store/lease';
import { ACTIVE_STATES, type LiveProgress } from '@/types/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, { params }: Context) {
  await reapIfDue();
  const { jobId } = await params;

  const row = await getJobRow(jobId);
  if (!row) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  const manifest = toManifest(row);
  const isActive = ACTIVE_STATES.includes(manifest.state);

  const [stats, active] = await Promise.all([computeStats(jobId), activeJobId()]);

  return NextResponse.json({
    job: manifest,
    stats,
    // The worker's own snapshot of what its browser contexts are doing, written
    // to the batch row at most once a second. It used to come from the runner's
    // in-memory Map, which only existed while the runner was in this process.
    progress: isActive ? ((row.progress ?? []) as LiveProgress[]) : [],
    isActive,
    activeJobId: active,
  });
}

export async function DELETE(_request: Request, { params }: Context) {
  const { jobId } = await params;

  const row = await getJobRow(jobId);
  if (!row) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  if (ACTIVE_STATES.includes(row.state)) {
    return NextResponse.json({ error: 'Stop the job before deleting it.' }, { status: 409 });
  }

  // The account's learned intelligence is deliberately NOT reset here.
  //
  // It used to be, on the reasoning that the metrics are running sums that
  // cannot be un-added, so the only correct answer was to drop them and replay
  // the surviving uploads. That reasoning depended on the uploads surviving.
  // Retention now prunes batches beyond the newest 30 per account, so a replay
  // is lossy, and fsn_intelligence is authoritative in its own right —
  // no foreign key, no cascade, nothing here touches it.
  //
  // Rebuilding is still available, as an explicit POST /api/intelligence, where
  // the cost of it can be stated to the person choosing it.
  const deleted = await deleteJob(jobId);
  if (!deleted) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  return NextResponse.json({ deleted: true });
}
