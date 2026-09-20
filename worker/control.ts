/**
 * The control loop: is anyone asking us to stop, and is this batch still ours?
 *
 * Pause and Stop used to be a field on an in-memory `ActiveRun` object that the
 * API route set directly, because the route and the runner were the same
 * process. They are now a column the dashboard writes and this polls.
 *
 * 
 * 
 * That poll is the honest part of the design. It costs one small SELECT every
 * few seconds, and it is why the UI shows `pausing` and `stopping` as states
 * rather than pretending the batch has already stopped:
 *
 *  - A Stop is seen within one poll, then fires the local AbortController. The
 *    scraper closes its browser contexts on that signal, which is what unblocks
 *    a page already parked inside a 20-second navigation wait. Fast, but not
 *    instant, and the products in flight are discarded and stay pending.
 *  - A Pause is seen just as quickly but deliberately does less: workers stop
 *    taking new products and finish what they hold, so nothing nearly-done is
 *    thrown away. On a wide pool that is up to one product's worth of time.
 *
 * The same timer extends the lease. If the extension fails the lease is no
 * longer ours — something reaped it, or another runner claimed the batch — and
 * continuing would mean two workers writing results for one batch. So a lost
 * lease is treated exactly like a Stop.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { heartbeatJob, LEASE_SECONDS } from '@/lib/store/lease';
import type { RequestedAction } from '@/lib/supabase/types';

const POLL_INTERVAL_MS = 3_000;

export type Intent = 'run' | 'pause' | 'stop';

export interface ControlLoop {
  /** What the worker should be doing. Read by the scraper's `shouldStop` hook. */
  intent(): Intent;
  /** Fired on Stop and on a lost lease, so parked Playwright waits are released. */
  signal: AbortSignal;
  /** True when the lease was lost rather than the user asking to stop. */
  leaseLost(): boolean;
  stop(): void;
}

export function startControlLoop(
  db: SupabaseClient,
  jobId: string,
  owner: string,
  onNotice: (message: string) => void,
): ControlLoop {
  const controller = new AbortController();
  let intent: Intent = 'run';
  let leaseLost = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;

    const held = await heartbeatJob(jobId, owner, LEASE_SECONDS);
    if (!held && intent === 'run') {
      leaseLost = true;
      intent = 'stop';
      onNotice(
        'Lost the lease on this batch — it was reaped as stale, or another runner claimed it. ' +
          'Stopping so two workers cannot write results for one batch.',
      );
      controller.abort();
      return;
    }

    const { data, error } = await db
      .from('jobs')
      .select('requested_action, state')
      .eq('id', jobId)
      .maybeSingle();

    // A failed poll is a network blip, not an instruction. Carrying on is the
    // safe reading: the next tick asks again, and the lease check above is what
    // actually guards against running orphaned.
    if (error || !data) return;

    const requested = (data as { requested_action: RequestedAction }).requested_action;

    if (requested === 'STOP' && intent !== 'stop') {
      intent = 'stop';
      onNotice('Stop requested. Closing browser contexts; products in flight stay pending.');
      controller.abort();
      return;
    }

    if (requested === 'PAUSE' && intent === 'run') {
      intent = 'pause';
      onNotice('Pause requested. Finishing the products already in flight, then stopping.');
    }
  };

  const timer = setInterval(() => {
    void tick().catch(() => undefined);
  }, POLL_INTERVAL_MS);

  // Nothing else is keeping the process alive for this timer's sake; the run
  // itself is. Unref'ing means a finished run exits without waiting on a tick.
  timer.unref?.();

  return {
    intent: () => intent,
    signal: controller.signal,
    leaseLost: () => leaseLost,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
