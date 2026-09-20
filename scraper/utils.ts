/**
 * Cross-cutting helpers: logging, retry, polling, option defaults.
 * Deliberately dependency-free apart from Playwright's Page type.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { cpus } from 'node:os';
import type { Page } from 'playwright';
import type { ResolvedOptions, ScraperOptions } from './types';

/* ------------------------------------------------------------------ logging */

let verbose = true;

export function setVerbose(v: boolean): void {
  verbose = v;
}

export type LogLevel = 'step' | 'info' | 'warn' | 'error';

/**
 * Receives every log line, regardless of `verbose`.
 *
 * `workerId` says which worker emitted the line. Without it, concurrent workers
 * produce a single interleaved stream in which no line can be attributed to the
 * product that caused it — every "Seller not found" would be guesswork.
 */
export type LogSink = (level: LogLevel, message: string, workerId: number) => void;

let sink: LogSink | null = null;

/**
 * Which worker the currently-running code belongs to.
 *
 * A plain module variable cannot do this job: the moment a worker awaits, some
 * other worker's continuation runs and would overwrite it, so lines would be
 * attributed to whichever product happened to be mid-flight. AsyncLocalStorage
 * follows the async call chain instead, so a line logged twelve awaits deep
 * still carries the id of the worker that started that chain.
 *
 * The alternative — threading a workerId parameter through every function in
 * this package — would touch code that has no other reason to know a pool
 * exists.
 */
const workerContext = new AsyncLocalStorage<number>();

/** Run `fn` with everything it logs, however deep, attributed to `workerId`. */
export function runAsWorker<T>(workerId: number, fn: () => Promise<T>): Promise<T> {
  return workerContext.run(workerId, fn);
}

/**
 * Route log output somewhere besides the console — the dashboard's live log
 * viewer, in practice.
 *
 * The sink is module-global, like `verbose`. That is safe under a worker pool
 * because every line arrives tagged with its `workerId`, so a caller can fan the
 * one stream back out per worker. Pass `null` to detach.
 */
export function setLogSink(next: LogSink | null): void {
  sink = next;
}

/** Emit to the sink first — it must see the line even when `verbose` is off. */
function emit(level: LogLevel, message: string, consoleWrite: () => void): void {
  try {
    sink?.(level, message, workerContext.getStore() ?? 0);
  } catch {
    // A broken sink must never take down a scrape.
  }
  if (level === 'error' || verbose) consoleWrite();
}

export const log = {
  step(message: string): void {
    emit('step', message, () => console.log(message));
  },
  info(message: string): void {
    emit('info', message, () => console.log(`  ${message}`));
  },
  warn(message: string): void {
    emit('warn', message, () => console.warn(`  ! ${message}`));
  },
  error(message: string): void {
    emit('error', message, () => console.error(`  x ${message}`));
  },
};

/* ------------------------------------------------------------------- errors */

export type ScrapeErrorCode =
  | 'PRODUCT_UNAVAILABLE'
  | 'NO_SELLER_LINK'
  | 'SELLER_LIST_LOAD_FAILED'
  | 'SELLER_NOT_FOUND'
  | 'MAIN_PRICE_NOT_FOUND'
  | 'SELLER_PRICE_NOT_FOUND'
  | 'BLOCKED';

/** An expected, classified failure — distinct from an unhandled crash. */
export class ScrapeError extends Error {
  constructor(readonly code: ScrapeErrorCode, message: string) {
    super(message);
    this.name = 'ScrapeError';
  }
}

/* -------------------------------------------------------------- pool sizing */

/** Never narrow the pool below this, however unhappy the numbers look. */
export const MIN_POOL_WIDTH = 3;

/**
 * How many products this machine can have in flight before adding more stops
 * buying throughput.
 *
 * A worker is not a thread: it is a browser context whose renderer competes for
 * the same cores as every other context. Measured on an 8-core box against the
 * real saved Flipkart markup, 24 products retired by N workers:
 *
 *     workers    3      6      8     10     14     20
 *     rate    1.11   1.60   1.77   1.66   1.77   1.28   products/sec
 *     each    1.9s   3.8s   4.2s   5.9s   6.6s  15.5s   per product
 *
 * Throughput plateaus around the core count and then *falls*: at twenty the box
 * did less work per second than at three, and each product took eight times
 * longer. That second row is why a too-wide pool also fails more — every wait in
 * the scraper is wall-clock, so a product stretched to 15s starts blowing
 * through timeouts that a 4s product never came near, and a starved wait is
 * reported as SELLER_LIST_LOAD_FAILED or a seller "not found".
 *
 * So this is where the pool *starts*, not where it is capped: `PoolWidth` climbs
 * from here while throughput keeps improving. Cores are the honest opening bid
 * because the plateau tracked them, and network waits — which cost no CPU — are
 * exactly what makes the true optimum higher on some runs and not others.
 */
export function startingPoolWidth(ceiling: number): number {
  const cores = Math.max(1, cpus().length);
  return Math.max(1, Math.min(ceiling, Math.max(MIN_POOL_WIDTH, cores)));
}

/* ------------------------------------------------------------------ options */

export const DEFAULT_OPTIONS: ResolvedOptions = {
  headless: true,
  timeout: 20_000,
  navigationTimeout: 45_000,
  // Runaway guard only. Flipkart caps seller lists well under this; the loop
  // exits on "seller found" or "button gone" long before hitting it.
  maxShowMoreClicks: 40,
  // Zero hits in 1010 recorded products; it only ever cost us response bodies.
  useNetworkCapture: false,
  preferDirectSellerNavigation: true,
  // Read the buy box off the raw HTML before anything is rendered. Products the
  // account already wins end there, and the rest skip the PDP render.
  //
  // Second in line now: `sellerApi` answers the same question and more, from
  // one request, so this only runs for products it could not read.
  buyboxProbe: true,
  // One POST for the price, the buy box and the whole seller list, with no
  // browser page. See ScraperOptions.sellerApi.
  sellerApi: true,
  // Pool-wide, not per worker. Measured: 4/s ran clean for 150 requests, 6/s
  // was metered at 225 and 10/s at 181 — all from a home connection, and a
  // datacentre address gets less. 3 is a deliberately conservative opening bid
  // that the limiter then adapts down or up from. See ScraperOptions.
  maxRequestsPerSecond: 3,
  sellerApiThrottleRetries: 3,
  // Backstop only. A healthy rendered product is ~4s; one that is being refused
  // everywhere used to compose its way to five minutes. See ScraperOptions.
  productBudgetMs: 90_000,
  // Three concurrent contexts. Measured against a 202-product batch without a
  // single block; raise it only with the same evidence in hand.
  concurrency: 3,
  blockResources: true,
  verbose: true,
  // Zero keeps single-product and small-batch runs exactly as fast as before.
  // Long batches should set --delay; see the note on ScraperOptions.delayMs.
  delayMs: 0,
  delayJitterMs: 400,
  blockBackoffMs: 60_000,
  blockRetries: 3,
  humanLikeBehavior: true,
};

/**
 * Fill in every unset option from DEFAULT_OPTIONS.
 *
 * Explicitly-undefined keys are dropped before merging, because a plain spread
 * does not treat them as absent: the CLI builds its options object field by
 * field, so omitting `--timeout` yields `{ timeout: undefined }`, and
 * `{ ...DEFAULT_OPTIONS, timeout: undefined }` overwrites the default with
 * undefined rather than keeping 20_000. That then reaches `waitFor` as
 * `Date.now() + undefined` — NaN, which no `>=` comparison is ever true for, so
 * the poll loop never reaches its deadline.
 */
export function resolveOptions(options: ScraperOptions = {}): ResolvedOptions {
  const provided = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as ScraperOptions;

  return { ...DEFAULT_OPTIONS, ...provided };
}

/* ------------------------------------------------------------------ waiting */

/**
 * Poll `check` until it returns a truthy value or `timeoutMs` elapses.
 *
 * This exists so the scraper never sleeps for a fixed duration waiting on
 * content — it waits on the actual condition and returns the moment it holds.
 * The only fixed number involved is the timeout ceiling.
 */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs: number; pollMs?: number; description?: string },
): Promise<T | null> {
  const pollMs = opts.pollMs ?? 150;
  const deadline = Date.now() + opts.timeoutMs;

  for (;;) {
    try {
      const value = await check();
      if (value) return value as T;
    } catch {
      // A transient DOM detach mid-poll is normal on a re-rendering page.
      // Swallow and try again until the deadline.
    }
    if (Date.now() >= deadline) return null;
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Plain sleep. Used only for poll backoff, never as a substitute for a wait.
 *
 * With a `signal`, resolves early on abort — a block back-off can be a full
 * minute, and a Stop that waits it out is a Stop that looks broken.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }

    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Sleep for `ms` plus a random 0..`jitterMs`.
 *
 * Politeness throttle between products, not a wait for content — a perfectly
 * even request cadence is itself a bot signal, hence the jitter.
 */
export function jitteredDelay(ms: number, jitterMs: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return delay(ms + Math.floor(Math.random() * Math.max(0, jitterMs)), signal);
}

/**
 * Retry `fn` on transient failures — the classic Playwright "element is not
 * attached to the DOM" churn you get while Flipkart hydrates widgets.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; backoffMs?: number; description?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const backoffMs = opts.backoffMs ?? 400;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      // A classified failure is a real answer, not a flake — do not retry it.
      if (error instanceof ScrapeError) throw error;
      lastError = error;
      if (attempt < attempts) {
        log.warn(
          `${opts.description ?? 'operation'} failed (attempt ${attempt}/${attempts}), retrying: ${errorMessage(error)}`,
        );
        await delay(backoffMs * attempt);
      }
    }
  }
  throw lastError;
}

/* -------------------------------------------------------------------- pages */

/**
 * Wait for the page to settle without hanging on Flipkart's long-lived
 * analytics/beacon connections, which mean `networkidle` frequently never fires.
 *
 * `load` is opt-in via `waitForLoad`, and callers that have already found the
 * content they came for should leave it off. It fires only once every subresource
 * has landed, so on a PDP it is a wait on ~90 product images that no extractor
 * reads — worth ~1s per product, for a signal we do not use. The real readiness
 * gate is the caller polling for its own content.
 */
export async function waitForPageSettled(
  page: Page,
  timeoutMs: number,
  waitForLoad = false,
): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
  if (waitForLoad) {
    await page.waitForLoadState('load', { timeout: Math.min(timeoutMs, 10_000) }).catch(() => undefined);
  }
}

/** Close the login interstitial if it is covering the page. Best-effort. */
export async function dismissOverlays(page: Page): Promise<void> {
  try {
    await page.keyboard.press('Escape');
  } catch {
    /* page may be navigating; harmless */
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Pull the Flipkart product id (FSN) out of a product URL. */
export function pidFromUrl(url: string): string | null {
  const match = /[?&]pid=([A-Za-z0-9]+)/.exec(url);
  return match ? match[1] : null;
}
