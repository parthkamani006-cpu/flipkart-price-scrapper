/**
 * POST /api/jobs/:jobId/retry — { indexes: number[] }
 *
 * Deletes those rows' results so they count as pending again. It does not start
 * a run; the user decides when to resume, which keeps retry from quietly
 * seizing the runner.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { computeStats, getJobRow, requeueRows, setJobState } from '@/lib/store/jobStore';
import { ACTIVE_STATES, RESUMABLE_STATES, type JobState } from '@/types/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  indexes: z.array(z.number().int().nonnegative()).min(1).max(10_000),
});

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, { params }: Context) {
  const { jobId } = await params;

  const row = await getJobRow(jobId);
  if (!row) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  // Deleting results underneath a live run would race the worker's writes: it
  // decides what is still pending by asking the same question this changes.
  if (ACTIVE_STATES.includes(row.state)) {
    return NextResponse.json(
      { error: 'Pause or stop the batch before requeuing rows.' },
      { status: 409 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'indexes must be a non-empty array of row numbers.' }, { status: 400 });
  }

  const requeued = await requeueRows(jobId, parsed.data.indexes);
  let state: JobState = row.state;

  if (requeued > 0 && !RESUMABLE_STATES.includes(state) && !ACTIVE_STATES.includes(state)) {
    // A finished batch has work again, so it cannot stay in a terminal state:
    // the dashboard only offers Start/Resume from a resumable one, and would
    // otherwise leave the user with rows to scrape and no way to scrape them.
    // 'stopped' is the honest description — unfinished work, nothing running.
    await setJobState(jobId, 'stopped', { finishedAt: undefined });
    state = 'stopped';
  }

  // No event to publish. The deletes and the state change are both writes the
  // dashboard is already subscribed to over Realtime, so every open tab sees
  // them without this route telling anyone.
  return NextResponse.json({ requeued, state, stats: await computeStats(jobId) });
}
