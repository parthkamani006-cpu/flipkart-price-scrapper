/**
 * Deciding how many products may render at once, and pacing their waits to
 * match.
 *
 * Split out from scraper.ts because it is the one piece of the pool that is
 * pure control logic — no browser, no page, no Flipkart — so it can be tested
 * for convergence directly. See scripts/poolWidth.test.ts.
 */

import type { ResolvedOptions } from './types';
import { MIN_POOL_WIDTH, delay, log } from './utils';

/** How often a worker with no slot re-checks for one. */
const WIDTH_POLL_MS = 100;

/**
 * Rounds to sit on the best known width before re-measuring its neighbours.
 *
 * Six rounds is tens of products: long enough that the pool is not spending its
 * life exploring, short enough that a machine which got busier — or freer —
 * halfway through a thousand-product batch is noticed inside it.
 */
const REPROBE_ROUNDS = 6;

/**
 * How many products may be *in flight* at once, which is not the same number as
 * how many workers exist.
 *
 * The pool has `concurrency` workers because that is what the user asked for.
 * How many of them may hold a browser context *at the same moment* is a
 * different question, and it is answered by the machine rather than by the
 * request: past the point where renderers saturate the cores, another worker
 * does not add throughput, it subtracts it — see `startingPoolWidth` for the
 * measurements. Worse, it stretches every product's wall-clock, and every wait
 * in this scraper is wall-clock, so an over-wide pool converts CPU starvation
 * into timeouts and reports them as scrape failures.
 *
 * So the width starts at the machine's honest opening bid and then hill-climbs
 * on measured throughput: after each round of results it scores itself as
 * `width / median product time` — products per unit time, the thing we actually
 * want to maximise — and widens while that score keeps up with the best score
 * seen, narrows when it falls away. A run on a big host with slow network
 * climbs to the ceiling, because waiting on Flipkart costs no CPU. A run on a
 * small host settles below it. Neither needs to be told which it is.
 *
 * This changes only *when* a product starts. Results are still written to the
 * slot of their input index, so nothing here can reorder an output.
 */
export class PoolWidth {
  private limit: number;
  private active = 0;
  private samples: number[] = [];
  /** Throughput seen at each width tried so far, products per millisecond. */
  private readonly scores = new Map<number, number>();
  private roundsParked = 0;

  constructor(
    private readonly ceiling: number,
    start: number,
  ) {
    this.limit = Math.max(1, Math.min(ceiling, start));
  }

  current(): number {
    return this.limit;
  }

  /** Wait for a slot. Resolves false if the run was aborted while waiting. */
  async acquire(signal?: AbortSignal): Promise<boolean> {
    for (;;) {
      if (signal?.aborted) return false;
      if (this.active < this.limit) {
        this.active++;
        return true;
      }
      await delay(WIDTH_POLL_MS, signal);
    }
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }

  /**
   * Feed one finished product back in, and re-score once a full round of them
   * has landed.
   *
   * A round is `limit` products, so the median is taken over a sample the same
   * width as the pool — wide enough that one 40-click seller list does not move
   * it, narrow enough to react inside a batch rather than after it.
   */
  record(durationMs: number): void {
    if (durationMs <= 0) return;
    this.samples.push(durationMs);
    if (this.samples.length < this.limit) return;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.samples = [];
    if (median <= 0) return;

    // Products per unit time at this width. Latency alone would be the wrong
    // signal: a narrower pool always has lower per-product latency and would
    // win every comparison, which is how you talk yourself down to one worker.
    const score = this.limit / median;
    const previous = this.limit;

    // Blend rather than overwrite. Product times are wildly uneven — a listing
    // with forty sellers behind a "show more" button is not the same job as one
    // with three — and a single unlucky round would otherwise condemn a width
    // permanently.
    const seen = this.scores.get(this.limit);
    this.scores.set(this.limit, seen === undefined ? score : seen * 0.6 + score * 0.4);

    this.limit = this.chooseWidth();

    if (this.limit !== previous) {
      this.roundsParked = 0;
      log.info(
        `pool width ${previous} → ${this.limit} (median ${Math.round(median)}ms/product, ceiling ${this.ceiling})`,
      );
      return;
    }

    // Parked on the best width we know. A batch runs for hours and the machine
    // it runs on does not hold still — another program opens, the network
    // slows — so periodically forget what we think we know about the
    // neighbours and go and measure them again.
    if (++this.roundsParked >= REPROBE_ROUNDS) {
      this.roundsParked = 0;
      this.scores.delete(this.limit - 1);
      this.scores.delete(this.limit + 1);
    }
  }

  /**
   * The width to run next: measure any unmeasured neighbour, otherwise sit on
   * the best width measured so far.
   *
   * Comparing every width against every other, rather than each step against
   * the step before it, is what makes this work on a real machine. The curve
   * either side of the knee is nearly flat — the measurements behind
   * `startingPoolWidth` lose 28% of throughput between eight workers and twenty,
   * which is under 3% per worker — and a controller that only ever compared
   * adjacent rounds would read every one of those steps as noise and ratchet
   * itself all the way to the ceiling.
   */
  private chooseWidth(): number {
    let best = this.limit;
    let bestScore = -1;
    // Ascending, with a strict comparison, so equal throughput keeps the
    // narrowest width. That tie-break is the whole safety argument: two widths
    // that retire the same number of products per second are not equivalent,
    // because the narrower one finishes each product sooner, and every wait in
    // the scraper is wall-clock. The wide plateau is where products start
    // expiring against timeouts and getting written down as scrape failures.
    for (const width of [...this.scores.keys()].sort((a, b) => a - b)) {
      const score = this.scores.get(width) ?? 0;
      if (score > bestScore) {
        bestScore = score;
        best = width;
      }
    }

    // Narrower first, and the order matters. An unmeasured neighbour has to be
    // tried to be known, but the two directions do not carry the same risk: a
    // round spent one worker narrower costs a little throughput at worst, while
    // a round spent one worker wider on a machine that is already saturated is
    // how products get stretched past their timeouts and recorded as failures.
    // On a host with room to spare this costs exactly one extra round at the
    // start, after which every step explores upward as normal.
    const narrower = best - 1;
    if (narrower >= MIN_POOL_WIDTH && !this.scores.has(narrower)) return narrower;

    const wider = best + 1;
    if (wider <= this.ceiling && !this.scores.has(wider)) return wider;

    return best;
  }
}

/**
 * Give a product the timeouts that match how loaded the machine is right now.
 *
 * Every wait in the scraper is wall-clock, but the thing it is really waiting
 * for is a renderer that may be sharing eight cores with nineteen siblings. A
 * page that resolves in 2s on an idle box can take three times that at width,
 * and a fixed 20s ceiling then fails it — not because Flipkart was slow or the
 * markup moved, but because we were busy. That failure is indistinguishable in
 * the output from a real one.
 *
 * Widening the ceiling in proportion costs nothing on the happy path: `waitFor`
 * returns the moment its condition holds, so this only ever buys patience for
 * the products that would otherwise have been failed for our own load. It is
 * capped, so a genuinely dead page still fails in bounded time.
 *
 * `concurrency` is overwritten with the live width for the same reason — it is
 * read downstream by the seller-list settling window, which is sizing itself
 * against how contended the machine is, and the honest answer to that is the
 * number of products actually in flight, not the number the user typed.
 */
export function pacedForWidth(options: ResolvedOptions, width: number): ResolvedOptions {
  const load = Math.min(2.5, 1 + Math.max(0, width - 1) / 8);
  return {
    ...options,
    concurrency: width,
    timeout: Math.round(options.timeout * load),
    navigationTimeout: Math.round(options.navigationTimeout * load),
  };
}
