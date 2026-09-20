/**
 * One request budget for the whole pool.
 *
 * Flipkart meters the seller endpoint per IP with a token bucket: a large
 * opening allowance, then a refill of roughly four or five requests a second.
 * Measured directly (see the note in README, "The pacing problem the speed-up
 * created"):
 *
 *     4 req/s   150 requests over 38s   all 200
 *     6 req/s   broke at request 225    (t+37s)
 *    10 req/s   broke at request 181    (t+18s)
 *
 * That shape is exactly why a run "starts amazing and then collapses": the
 * burst allowance carries the opening stretch at any rate, and the moment it is
 * spent every request over the refill rate comes back HTTP 429.
 *
 * The scraper's own politeness throttle cannot prevent this, because it is
 * per worker. It was calibrated when a product took ~40s, so eight workers
 * produced about 0.2 requests a second. A product now takes ~0.3s, so the same
 * eight workers and the same `delayMs` produce about 4.4 — a twenty-fold
 * increase in request rate that nobody asked for and no setting expressed.
 *
 * So the budget has to be held in one place, for the pool as a whole, and it
 * has to be a rate rather than a gap between products.
 *
 * ## Why it adapts
 *
 * The measurements above are from a home connection. A GitHub Actions runner is
 * an Azure datacentre address, which e-commerce edges meter far more tightly —
 * the same run there collapses after 70-80 products rather than 200. Hard-coding
 * a number that suits one of those starves or breaks the other, and neither host
 * will tell us which it is.
 *
 * So this is AIMD, the same control law TCP uses: run at the configured rate,
 * halve it the moment a 429 says we are over, and creep back up while requests
 * keep succeeding. A run converges just under whatever its own IP is actually
 * allowed, without being told, and without repeatedly slamming into the ceiling
 * to find out.
 */

import { delay, log } from './utils';

/** Never throttle below this, or a batch stops making progress at all. */
const FLOOR_PER_SEC = 0.5;

/** Consecutive clean requests before the rate creeps back up a step. */
const RECOVERY_STREAK = 25;

/** How much one recovery step adds, in requests per second. */
const RECOVERY_STEP = 0.5;

/** First pause after a 429, doubling while they keep coming. */
const BASE_COOLDOWN_MS = 1_500;
const MAX_COOLDOWN_MS = 30_000;

export class RateLimiter {
  /** Requests per second we are currently willing to make. */
  private rate: number;
  private tokens: number;
  private lastRefill = Date.now();
  /** No token is handed out before this instant. Set by a 429. */
  private cooldownUntil = 0;
  private cooldownMs = BASE_COOLDOWN_MS;
  private streak = 0;

  /**
   * @param maxPerSec  the rate to run at while nothing is complaining
   * @param burst      tokens available at once, for the opening stretch
   */
  constructor(
    private readonly maxPerSec: number,
    private readonly burst: number,
  ) {
    this.rate = Math.max(FLOOR_PER_SEC, maxPerSec);
    this.tokens = Math.max(1, burst);
  }

  /** The rate currently in force — for logging and for the tests. */
  current(): number {
    return this.rate;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
  }

  /**
   * Wait until the pool may make one more request. Resolves false if the run was
   * aborted while waiting, so a Stop is not held up by a cooldown.
   */
  async take(signal?: AbortSignal): Promise<boolean> {
    for (;;) {
      if (signal?.aborted) return false;

      const cooling = this.cooldownUntil - Date.now();
      if (cooling > 0) {
        // Woken in slices so a Stop mid-cooldown is honoured promptly.
        await delay(Math.min(cooling, 500), signal);
        continue;
      }

      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return true;
      }

      // Sleep exactly as long as the next token needs, capped so a very slow
      // rate still wakes up often enough to notice an abort.
      const waitMs = Math.min(1_000, Math.ceil(((1 - this.tokens) / this.rate) * 1000));
      await delay(Math.max(20, waitMs), signal);
    }
  }

  /**
   * Told that a request came back 429.
   *
   * Halves the rate and parks every worker for a doubling cooldown. Both halves
   * matter: the cooldown clears the backlog Flipkart is already angry about, and
   * the halved rate is what stops us walking straight back into it.
   */
  throttled(): void {
    const previous = this.rate;
    this.rate = Math.max(FLOOR_PER_SEC, this.rate / 2);
    this.tokens = 0;
    this.streak = 0;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + this.cooldownMs);

    log.warn(
      `rate limited by Flipkart — pool pausing ${Math.round(this.cooldownMs / 1000)}s and ` +
        `slowing from ${previous.toFixed(1)} to ${this.rate.toFixed(1)} req/s`,
    );
    this.cooldownMs = Math.min(MAX_COOLDOWN_MS, this.cooldownMs * 2);
  }

  /**
   * Told that a request came back cleanly.
   *
   * A long enough clean streak both steps the rate back up and forgets one
   * doubling of the cooldown, so a run that was throttled early is not stuck
   * paying for it an hour later.
   */
  succeeded(): void {
    if (this.rate >= this.maxPerSec && this.cooldownMs === BASE_COOLDOWN_MS) return;
    if (++this.streak < RECOVERY_STREAK) return;

    this.streak = 0;
    this.cooldownMs = Math.max(BASE_COOLDOWN_MS, this.cooldownMs / 2);
    if (this.rate < this.maxPerSec) {
      this.rate = Math.min(this.maxPerSec, this.rate + RECOVERY_STEP);
      log.info(`${RECOVERY_STREAK} clean requests — rate back up to ${this.rate.toFixed(1)} req/s`);
    }
  }
}
