/**
 * The live progress snapshot.
 *
 * The dashboard used to learn what each browser context was doing from an
 * in-process event bus: the runner called `publish()` and an open SSE
 * connection in the same process forwarded it. That is free when it is a
 * function call and expensive when it is a network write, and a 20-wide pool
 * emits several step changes per second.
 *
 * So the snapshot is coalesced: steps are recorded in memory immediately and
 * written to `jobs.progress` at most once a second. One row UPDATE carries
 * every worker's state, and Realtime delivers it to every open tab.
 *
 * This is a projection, not a record. Nothing is recovered from it, and a
 * missed write costs a second of staleness — which is why it is safe to throttle
 * and safe to let fail quietly. Results, by contrast, are written individually
 * and never dropped.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { LiveProgress } from '@/types/dashboard';

const FLUSH_INTERVAL_MS = 1_000;

export class ProgressReporter {
  private readonly slots = new Map<number, LiveProgress>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private writing = false;

  constructor(
    private readonly db: SupabaseClient,
    private readonly jobId: string,
  ) {}

  /** Record what a worker is doing. Cheap; the write happens on the next flush. */
  set(workerId: number, progress: LiveProgress): void {
    this.slots.set(workerId, progress);
    this.schedule();
  }

  /** A worker finished its product and holds nothing. */
  clear(workerId: number): void {
    if (this.slots.delete(workerId)) this.schedule();
  }

  snapshot(): LiveProgress[] {
    return [...this.slots.values()].sort((left, right) => left.workerId - right.workerId);
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.write();
    }, FLUSH_INTERVAL_MS);
  }

  private async write(): Promise<void> {
    if (!this.dirty || this.writing) return;
    this.writing = true;
    this.dirty = false;

    try {
      await this.db.from('jobs').update({ progress: this.snapshot() }).eq('id', this.jobId);
    } catch {
      // A dropped snapshot is a second of stale progress in the UI. The next
      // step change schedules another write; nothing is lost that matters.
    } finally {
      this.writing = false;
      // A step that arrived while the write was in flight needs its own flush.
      if (this.dirty) this.schedule();
    }
  }

  /**
   * Write the final state and stop.
   *
   * Always called with an empty snapshot when a run ends, so a batch never
   * leaves the UI showing workers that stopped existing when the runner did.
   */
  async finish(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.slots.clear();
    this.dirty = true;
    await this.write();
  }
}
