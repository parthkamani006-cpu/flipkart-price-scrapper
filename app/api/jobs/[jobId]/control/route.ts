/**
 * POST /api/jobs/:jobId/control — { action: 'start' | 'pause' | 'resume' | 'stop' }
 *
 * Start and resume are the same call. That is not a shortcut: resuming *is*
 * starting a run over whatever is still pending, so giving them separate code
 * paths would mean two implementations of the resume rule.
 *
 * What changed with the move off this machine: none of these actions *does* the
 * thing any more. Start queues the batch and pokes GitHub; Pause and Stop write
 * what the user asked for and let the worker notice. The request returns in
 * milliseconds either way, which is the only shape that fits in a serverless
 * function — the run itself is half an hour long.
 *
 * The honest consequences, which the response and the UI both reflect:
 *
 *  - Start does not mean started. A runner has to boot, install Chromium and
 *    claim the batch, which is tens of seconds. Until then the batch is queued.
 *  - Pause does not mean paused. The worker checks every few seconds and then
 *    finishes the products already in flight, because dropping them would throw
 *    away work that is nearly done. That is what the `pausing` state is for.
 *  - Stop is faster but still not instant: the worker aborts its contexts, and
 *    a page already parked on a navigation takes a moment to let go.
 *  - Pausing or stopping a batch no worker has claimed is immediate, because
 *    there is nothing running to interrupt.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { computeStats, countPending, getJobRow, setJobState, setRequestedAction } from '@/lib/store/jobStore';
import { reapIfDue } from '@/lib/store/lease';
import { dispatchScraperRun } from '@/lib/services/githubDispatch';
import { ACTIVE_STATES, RESUMABLE_STATES } from '@/types/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  action: z.enum(['start', 'resume', 'pause', 'stop']),
});

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, { params }: Context) {
  // Before deciding whether a batch is busy, give a dead worker's lease a
  // chance to be noticed — otherwise Start on a crashed run refuses forever.
  await reapIfDue();

  const { jobId } = await params;

  const row = await getJobRow(jobId);
  if (!row) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'action must be one of: start, resume, pause, stop.' },
      { status: 400 },
    );
  }

  const { action } = parsed.data;
  const isActive = ACTIVE_STATES.includes(row.state);

  /* ------------------------------------------------------------ start */

  if (action === 'start' || action === 'resume') {
    if (isActive) {
      return NextResponse.json({ error: 'This job is already running.' }, { status: 409 });
    }
    if (!RESUMABLE_STATES.includes(row.state)) {
      return NextResponse.json({ error: `A ${row.state} batch cannot be started.` }, { status: 409 });
    }

    const pending = await countPending(jobId);
    if (pending === 0) {
      await setJobState(jobId, 'completed', { finishedAt: new Date().toISOString() });
      return NextResponse.json({
        ok: true,
        pending: 0,
        queued: false,
        dispatched: false,
        note: 'Nothing left to scrape — the batch is already complete.',
        stats: await computeStats(jobId),
      });
    }

    // Queue first, dispatch second. The queue write is what makes the batch
    // real; the dispatch only decides whether a runner comes now or at the next
    // scheduled sweep. Doing it the other way round would let a runner arrive
    // before there was anything for it to claim.
    await setRequestedAction(jobId, 'RUN', {
      state: 'queued',
      finishedAt: undefined,
      interruptedAt: undefined,
    });

    const dispatch = await dispatchScraperRun(jobId);

    return NextResponse.json({
      ok: true,
      pending,
      queued: true,
      dispatched: dispatch.dispatched,
      note: dispatch.dispatched
        ? 'Queued. A GitHub Actions runner is starting — this takes a minute or so.'
        : `Queued, but the runner could not be triggered now (${dispatch.reason}) — it will be picked up by the next scheduled run.`,
      stats: await computeStats(jobId),
    });
  }

  /* ------------------------------------------------------ pause / stop */

  if (!isActive) {
    // No worker holds this batch, so there is nothing to ask. Apply the result
    // directly rather than leaving a request nobody will ever read.
    if (row.state === 'queued') {
      const state = action === 'pause' ? 'paused' : 'stopped';
      await setRequestedAction(jobId, 'RUN', { state, finishedAt: new Date().toISOString() });
      return NextResponse.json({
        ok: true,
        state,
        note: 'The batch had not started yet, so it was taken out of the queue.',
        stats: await computeStats(jobId),
      });
    }

    return NextResponse.json(
      { error: `Nothing to ${action} — the batch is ${row.state}.` },
      { status: 409 },
    );
  }

  const state = action === 'pause' ? 'pausing' : 'stopping';
  await setRequestedAction(jobId, action === 'pause' ? 'PAUSE' : 'STOP', { state });

  return NextResponse.json({
    ok: true,
    state,
    note:
      action === 'pause'
        ? 'Pausing. The worker finishes the products already in flight, then stops — usually within a minute.'
        : 'Stopping. The worker is closing its browser contexts; products in flight are discarded and stay pending.',
    stats: await computeStats(jobId),
  });
}
