/**
 * The pool's request budget must hold a rate, and must find a lower one when
 * Flipkart says so.
 *
 * This is the control that stops a batch dying the way it did: the scraper got
 * ~20x faster per product, the per-worker `delayMs` throttle did not notice, and
 * the pool went from ~0.2 requests a second to ~4.4 — straight through the
 * per-IP quota, after which every product fell into the rendered fallback and
 * took minutes.
 *
 * What matters is therefore: the rate is actually enforced across concurrent
 * callers, a 429 lowers it and pauses everyone, a clean streak wins it back, it
 * never reaches zero, and an abort is never held up by a cooldown.
 *
 * Run: npm run test:limiter
 */

import assert from 'node:assert/strict';
import { RateLimiter } from '../scraper/rateLimiter';
import { setVerbose } from '../scraper/utils';

setVerbose(false);

let passed = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${label}`);
    })
    .catch((error) => {
      console.error(`  FAIL  ${label}`);
      throw error;
    });
}

async function main(): Promise<void> {
  console.log('rate limiter');

  await check('the burst is spent immediately, then the rate binds', async () => {
    // 10/s with a burst of 5: five tokens are there for the taking, the sixth
    // has to wait about 100ms for the bucket to refill.
    const limiter = new RateLimiter(10, 5);
    const started = Date.now();
    for (let i = 0; i < 5; i++) assert.equal(await limiter.take(), true);
    assert.ok(Date.now() - started < 50, 'the burst should not have waited');

    await limiter.take();
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 70, `sixth take should have waited for a refill, waited ${elapsed}ms`);
  });

  await check('sustained throughput tracks the configured rate', async () => {
    const limiter = new RateLimiter(20, 1);
    const started = Date.now();
    for (let i = 0; i < 10; i++) await limiter.take();
    const elapsed = Date.now() - started;
    // 10 takes at 20/s is ~450ms after the one free burst token. Generous
    // bounds: this is asserting "it paces", not a stopwatch.
    assert.ok(elapsed >= 350, `expected pacing, took only ${elapsed}ms`);
    assert.ok(elapsed < 1500, `expected ~450ms, took ${elapsed}ms`);
  });

  await check('a 429 halves the rate and parks the pool', async () => {
    const limiter = new RateLimiter(8, 8);
    assert.equal(limiter.current(), 8);

    limiter.throttled();
    assert.equal(limiter.current(), 4, 'rate should halve');

    // Every worker waits out the cooldown, not just the one that was refused.
    const started = Date.now();
    await limiter.take();
    assert.ok(Date.now() - started >= 1_000, 'the cooldown should have held the next take');
  });

  await check('repeated 429s keep halving, and stop at the floor', () => {
    const limiter = new RateLimiter(8, 8);
    for (let i = 0; i < 12; i++) limiter.throttled();
    assert.equal(limiter.current(), 0.5, 'must not throttle itself to a standstill');
  });

  await check('a clean streak wins the rate back, but not past the configured max', () => {
    const limiter = new RateLimiter(3, 3);
    limiter.throttled();
    assert.equal(limiter.current(), 1.5);

    // Well past the recovery streak, several times over.
    for (let i = 0; i < 500; i++) limiter.succeeded();
    assert.equal(limiter.current(), 3, 'should climb back to the configured rate and stop there');
  });

  await check('recovery is slow enough not to re-trip immediately', () => {
    const limiter = new RateLimiter(4, 4);
    limiter.throttled();
    const afterThrottle = limiter.current();
    for (let i = 0; i < 10; i++) limiter.succeeded();
    assert.equal(limiter.current(), afterThrottle, 'ten successes is not a streak');
  });

  await check('concurrent workers share one budget', async () => {
    const limiter = new RateLimiter(20, 1);
    const started = Date.now();
    // Eight workers racing for the same tokens must still take ~8/20s overall.
    await Promise.all(Array.from({ length: 8 }, () => limiter.take()));
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 300, `eight takes at 20/s should pace, took ${elapsed}ms`);
  });

  await check('an abort returns immediately, even mid-cooldown', async () => {
    const limiter = new RateLimiter(1, 0);
    limiter.throttled(); // parks everyone for 1.5s
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);

    const started = Date.now();
    assert.equal(await limiter.take(controller.signal), false, 'take must report the abort');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 900, `abort should not wait out the cooldown, waited ${elapsed}ms`);
  });

  await check('an already-aborted signal never takes a token', async () => {
    const limiter = new RateLimiter(100, 100);
    const controller = new AbortController();
    controller.abort();
    assert.equal(await limiter.take(controller.signal), false);
  });

  console.log(`\n${passed} assertions passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
