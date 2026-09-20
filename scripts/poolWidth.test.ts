/**
 * The width controller must find the machine's knee and stay there.
 *
 * A pool that is too wide does not just run slowly — it stretches every
 * product's wall-clock past the scraper's timeouts and reports the result as a
 * scrape failure, which is how a "faster" setting produces a worse output file.
 * The controller exists to stop that, so what is tested here is that it
 * converges on the width that actually maximises throughput, that it never
 * parks a worker forever, and that it cannot be talked below its floor.
 *
 * The machine is simulated: a product's duration is a function of how many are
 * in flight, flat while there is CPU to spare and climbing once there is not.
 * That is the shape measured against the real saved Flipkart markup (see
 * startingPoolWidth), and it is all the controller ever sees of the world.
 *
 * Run: npm run test:width
 */

import assert from 'node:assert/strict';

import { PoolWidth, pacedForWidth } from '@/scraper/poolWidth';
import { DEFAULT_OPTIONS, MIN_POOL_WIDTH } from '@/scraper/utils';

/**
 * Wall-clock for one product with `inFlight` of them running.
 *
 * Below the knee, a product costs what it costs. Above it, every extra product
 * is one more renderer on the same cores and each one takes *more* than its
 * proportional share longer — cache pressure, scheduler churn, a browser
 * process arbitrating twenty contexts. That exponent is what makes throughput
 * fall rather than flatten past the knee, and it is fitted to the measurement
 * in startingPoolWidth: on eight cores, twenty workers retired 1.28 products a
 * second against 1.77 at eight, or 72% of peak. This curve gives 76%.
 */
function durationAt(inFlight: number, knee: number): number {
  const base = 2_000;
  return inFlight <= knee ? base : Math.round(base * (inFlight / knee) ** 1.3);
}

/** A machine that stops improving past the knee but does not get worse. */
function plateauAt(inFlight: number, knee: number): number {
  const base = 2_000;
  return inFlight <= knee ? base : Math.round((base * inFlight) / knee);
}

/** Throughput the pool would sustain at a fixed width, products per second. */
function rateAt(width: number, knee: number): number {
  return width / (durationAt(width, knee) / 1000);
}

/**
 * Drive the controller through `rounds` of products, always reporting the
 * duration its current width would really have produced, and return the width
 * it spent the most rounds at.
 *
 * The settled width is the *modal* one, not whichever it happens to hold on the
 * last round. A converged controller still steps off its answer now and then to
 * re-measure a neighbour — that is how it notices a machine that got busier
 * mid-batch — so sampling one round would be reading the probe as the verdict.
 */
function converge(
  ceiling: number,
  start: number,
  knee: number,
  rounds: number,
  machine: (inFlight: number, knee: number) => number = durationAt,
): number {
  const width = new PoolWidth(ceiling, start);
  const visits = new Map<number, number>();

  for (let round = 0; round < rounds; round++) {
    const at = width.current();
    // Ignore the opening rounds: those are the search, not the answer.
    if (round > rounds / 2) visits.set(at, (visits.get(at) ?? 0) + 1);
    // One full round of results at the width the controller currently holds.
    for (let i = 0; i < at; i++) width.record(machine(at, knee));
  }

  let modal = width.current();
  let most = 0;
  for (const [at, count] of visits) {
    if (count > most) {
      most = count;
      modal = at;
    }
  }
  return modal;
}

/* ------------------------------------------------- it finds the right width */
{
  // A ceiling well above what the simulated machine can sustain — the case that
  // prompted all of this: twenty workers asked for, eight cores to run them.
  const knee = 8;
  const settled = converge(20, 8, knee, 40);

  assert.ok(
    settled >= knee - 1 && settled <= knee + 2,
    `expected to settle near the knee (${knee}), settled at ${settled}`,
  );

  // The real claim is about throughput, not about hitting a number: whatever it
  // settled on must be within a few percent of the best width available to it.
  const best = Math.max(...Array.from({ length: 20 }, (_, i) => rateAt(i + 1, knee)));
  assert.ok(
    rateAt(settled, knee) >= best * 0.9,
    `settled width ${settled} runs at ${rateAt(settled, knee).toFixed(2)}/s against a best of ${best.toFixed(2)}/s`,
  );
}

/* --------------------------------------- a plateau is not a reason to widen */
{
  // Throughput flat past the knee: every extra worker adds exactly as much
  // latency as it adds parallelism, so the run finishes at the same time either
  // way — but at twenty in flight each product takes 2.5x as long as at eight,
  // and it is that latency, not the throughput, that runs products into the
  // scraper's timeouts. Widening into a plateau buys nothing and costs the
  // failure rate, so the controller must stay put.
  const settled = converge(20, 8, 8, 40, plateauAt);
  assert.ok(settled <= 10, `a flat plateau should not pull the pool to its ceiling, went to ${settled}`);
}

/* ------------------------------------ a roomy machine is allowed the ceiling */
{
  // Knee above the ceiling: nothing the pool can do saturates this host, so the
  // controller must spend every worker it was given rather than hold back.
  const settled = converge(12, 4, 40, 40);
  assert.equal(settled, 12, `a machine with headroom should reach the ceiling, got ${settled}`);
}

/* ------------------------------- an overloaded pool never widens on round one */
{
  // A machine that is already past saturation. The first round has nothing to
  // compare against, and "no baseline" must not read as "this is going well".
  const width = new PoolWidth(20, 10);
  for (let i = 0; i < 10; i++) width.record(durationAt(10, 1));
  assert.ok(width.current() <= 10, `an overloaded pool widened to ${width.current()} on its first round`);
}

/* --------------------------------------------- it never goes below the floor */
{
  // A machine that is saturated at any width at all. The controller should
  // narrow, but a pool of one that cannot be widened again is a worse failure
  // than a slow one, so the floor holds.
  const settled = converge(20, 10, 1, 60);
  assert.ok(settled >= MIN_POOL_WIDTH, `width fell to ${settled}, below the floor ${MIN_POOL_WIDTH}`);
}

/* ------------------------------------------- the ceiling is never overshot */
{
  const width = new PoolWidth(5, 5);
  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < width.current(); i++) width.record(1_000);
    assert.ok(width.current() <= 5, `width ${width.current()} exceeded its ceiling of 5`);
  }
}

/* ------------------------------------- pacing scales waits, not the answers */
{
  const base = { ...DEFAULT_OPTIONS, timeout: 20_000, navigationTimeout: 45_000 };

  const idle = pacedForWidth(base, 1);
  assert.equal(idle.timeout, 20_000, 'a pool of one must scrape with the timeouts it was given');
  assert.equal(idle.navigationTimeout, 45_000);

  const wide = pacedForWidth(base, 20);
  assert.ok(wide.timeout > base.timeout, 'a wide pool must be more patient, not less');
  assert.ok(wide.timeout <= base.timeout * 2.5, `timeout scaling is uncapped: ${wide.timeout}`);
  assert.ok(wide.navigationTimeout <= base.navigationTimeout * 2.5);

  // The settling window downstream sizes itself off `concurrency`, and the
  // honest input to that is how many products are really in flight.
  assert.equal(wide.concurrency, 20);
  assert.equal(pacedForWidth(base, 6).concurrency, 6);

  // Everything that decides *what* is extracted must come through untouched.
  for (const key of ['blockResources', 'useNetworkCapture', 'preferDirectSellerNavigation', 'maxShowMoreClicks'] as const) {
    assert.deepEqual(wide[key], base[key], `pacing altered ${key}, which shapes the result`);
  }
}

/* ------------------------------------------------------------ the slot gate */

/** The gate is async, and this file is compiled without top-level await. */
async function gateTests(): Promise<void> {
  // Two acquires at width 1: the second must wait for the release, then run.
  {
    const width = new PoolWidth(1, 1);
    assert.equal(await width.acquire(), true);

    let secondGotIn = false;
    const second = width.acquire().then((ok) => {
      secondGotIn = ok;
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(secondGotIn, false, 'a slot was handed out while the pool was full');

    width.release();
    await second;
    assert.equal(secondGotIn, true, 'the freed slot was never handed to the waiting worker');
  }

  // A Stop must not leave a worker parked on the gate: the whole run is waiting
  // on those promises to settle before it can close the browser.
  {
    const width = new PoolWidth(1, 1);
    await width.acquire();

    const controller = new AbortController();
    const waiting = width.acquire(controller.signal);
    controller.abort();

    assert.equal(await waiting, false, 'aborting a run left a worker parked on the width gate');
  }

  // Widening must wake the workers already waiting, not only new arrivals.
  {
    const width = new PoolWidth(4, 1);
    await width.acquire();

    let admitted = false;
    const waiting = width.acquire().then((ok) => {
      admitted = ok;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(admitted, false, 'the gate admitted a second product at width 1');

    // A round of fast results at width 1 — the controller should widen.
    for (let round = 0; round < 3; round++) width.record(500);
    assert.ok(width.current() > 1, 'a healthy pool of one never widened');

    await waiting;
    assert.equal(admitted, true, 'widening the pool did not release the waiting worker');
  }
}

void gateTests().then(() => {
  console.log('Pool width tests passed (convergence, floor, ceiling, hand-off, abort, pacing).');
});
