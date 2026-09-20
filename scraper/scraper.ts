/**
 * Orchestration: open the product, read both prices, compare, return a result.
 *
 * Every classified failure produces a result object with a `status` — the
 * function only throws on genuinely unexpected errors, and even then
 * `scrapeProduct` converts it into a result rather than exploding on the caller.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { probeBuybox } from './buyboxProbe';
import { humanBehavior } from './humanBehavior';
import { comparePrice, findSeller, pickBuyboxSeller, sellerNamesMatch } from './parser';
import {
  checkAvailability,
  findSellerListEntry,
  getFulfilledBy,
  getMainPrice,
  openProduct,
  readPageSignals,
  readProductJsonLd,
  type SellerListEntry,
} from './productPage';
import { PoolWidth, pacedForWidth } from './poolWidth';
import { RateLimiter } from './rateLimiter';
import { fetchSellerListings, type SellerApiReading } from './sellerApi';
import { attachNetworkCapture, getSellerPrice, openSellerDrawer, type NetworkCapture } from './sellerDrawer';
import { BLOCKED_HOSTS, BLOCKED_RESOURCE_TYPES, sellersUrlForPid } from './selectors';
import type {
  ResolvedOptions,
  ResultSink,
  ScrapeInput,
  ScrapeResult,
  ScrapeStatus,
  ScraperOptions,
} from './types';
import {
  ScrapeError,
  delay,
  errorMessage,
  jitteredDelay,
  log,
  resolveOptions,
  runAsWorker,
  setVerbose,
  startingPoolWidth,
} from './utils';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Floor for the gap between worker starts, used when the run sets no pacing of
 * its own. Enough for one context to boot and get its first navigation away
 * before the next worker begins.
 */
const WORKER_RAMP_MS = 750;

/**
 * The request budget for a run that has only one product in it.
 *
 * Metering exists to stop a pool of workers outrunning Flipkart's per-IP quota.
 * A single product cannot, so it gets a limiter wide enough to be invisible —
 * the plumbing stays uniform and `scrapeProduct` behaves exactly as it always
 * has.
 */
function soloLimiter(options: ResolvedOptions): RateLimiter {
  return new RateLimiter(Math.max(options.maxRequestsPerSecond, 10), 10);
}

/* ------------------------------------------------------------ single product */

/**
 * Scrape one product and compare its headline price against `targetSeller`'s.
 *
 * Launches and disposes its own browser. To scrape many products, use
 * `scrapeProducts` so one browser is reused across them.
 */
export async function scrapeProduct(input: ScrapeInput, options: ScraperOptions = {}): Promise<ScrapeResult> {
  const resolved = resolveOptions(options);
  setVerbose(resolved.verbose);

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser(resolved);
    const context = await createContext(browser, resolved);
    try {
      // A one-product run has no pool to meter, but the limiter is not optional
      // downstream — give it one whose budget it can never exhaust.
      return await scrapeInContext(context, input, resolved, 0, soloLimiter(resolved));
    } finally {
      await context.close().catch(() => undefined);
    }
  } catch (error) {
    return failure(input, 'ERROR', errorMessage(error));
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/* ---------------------------------------------------------------- block gate */

/**
 * A shared "everybody stop" timer for the worker pool.
 *
 * A bot wall is a fact about our IP, not about one product, so when any worker
 * is told to back off every other worker must back off too. Without this, one
 * worker would sit out its 60s penalty while the other two kept hammering the
 * same wall and kept extending it.
 *
 * `hold` only ever pushes the deadline later, never earlier, so two workers
 * blocking at once cannot shorten each other's penalty.
 */
class BlockGate {
  private until = 0;

  hold(ms: number): void {
    this.until = Math.max(this.until, Date.now() + ms);
  }

  private remaining(): number {
    return Math.max(0, this.until - Date.now());
  }

  /** Resolve once the pool is free to make requests again. */
  async wait(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const left = this.remaining();
      if (left <= 0 || signal?.aborted) return;
      // Woken in slices so a Stop mid-back-off is honoured promptly.
      await delay(Math.min(left, 1_000), signal);
    }
  }
}

/* -------------------------------------------------------------- many products */

/**
 * Scrape several products, `options.concurrency` at a time, in one browser.
 *
 * Each worker owns its own browser context and its own pacing, and pulls the
 * next product off a shared queue as soon as it is free. `concurrency: 1`
 * reproduces the original strictly-sequential behaviour exactly.
 *
 * `onResult` fires as each product finishes — use it to persist incrementally so
 * a crash at item 900 of 1000 doesn't lose the run. It fires in completion
 * order, which under concurrency is not input order; the returned array is
 * sorted back into input order, and the journal is keyed by product rather than
 * by position, so neither resume nor any caller depends on the interleaving.
 *
 * The pool stops taking new work if a product stays BLOCKED through every
 * back-off; anything after that would only be blocked too. Products already in
 * flight are allowed to finish and are still reported, and the untouched inputs
 * are left for a resumed run.
 */
export async function scrapeProducts(
  inputs: ScrapeInput[],
  options: ScraperOptions = {},
  onResult?: ResultSink,
): Promise<ScrapeResult[]> {
  const resolved = resolveOptions(options);
  setVerbose(resolved.verbose);

  // Slots, not pushes: workers finish out of order, and every caller so far has
  // read the returned array as "the inputs, in the order I gave them".
  const slots: (ScrapeResult | null)[] = new Array(inputs.length).fill(null);
  const gate = new BlockGate();

  // One request budget for the whole pool. The burst is a second's worth of
  // headroom so a worker that has just been handed a product does not wait on a
  // token that is already due — not the large opening allowance Flipkart itself
  // grants, which is precisely the thing that lets a run feel fast for eighty
  // products and then fall off a cliff.
  const limiter = new RateLimiter(
    Math.max(0.1, resolved.maxRequestsPerSecond),
    Math.max(1, Math.ceil(resolved.maxRequestsPerSecond)),
  );

  const workerCount = Math.max(1, Math.min(Math.trunc(resolved.concurrency) || 1, inputs.length));
  // The workers are the ceiling; the width is how many of them may be scraping
  // at any one moment. See PoolWidth for why those are different numbers.
  const width = new PoolWidth(workerCount, startingPoolWidth(workerCount));
  if (workerCount > 1) {
    log.info(
      `scraping with up to ${workerCount} concurrent workers, starting ${width.current()} wide`,
    );
  }

  let cursor = 0;
  let stopIntake = false;

  /** Hand out the next input, or null when the pool should wind down. */
  const takeNext = (): number | null => {
    if (stopIntake || resolved.signal?.aborted || cursor >= inputs.length) return null;
    // A drain request stops intake without tearing down work in flight.
    if (resolved.shouldStop?.()) return null;
    return cursor++;
  };

  const browser = await launchBrowser(resolved);

  const runWorker = async (workerId: number): Promise<void> => {
    // Stagger the start so a twenty-worker pool does not open twenty contexts
    // and fire twenty navigations in the same instant. That opening burst is
    // both the most block-prone moment of a run and the worst moment for CPU:
    // every context boots at once, and the page-render waits inside a product
    // are measured against a machine that is briefly saturated. Spacing the
    // starts by the run's own pacing also leaves the workers out of lockstep for
    // the whole batch, so they keep arriving spread out rather than in waves.
    //
    // The ramp is per worker, so a full pool takes (workers - 1) * delay to come
    // up — about 28s at twenty workers and the default 1500ms pacing. That is
    // paid once per run, against a batch the pool then retires twenty at a time,
    // so it is left in place rather than compressed: this is the exact window
    // where a wide pool would otherwise read as a burst.
    if (workerId > 0) {
      await delay(workerId * Math.max(resolved.delayMs, WORKER_RAMP_MS), resolved.signal);
      if (resolved.signal?.aborted) return;
    }

    for (;;) {
      const index = takeNext();
      if (index === null) return;

      // Honour a pool-wide back-off before touching the network.
      await gate.wait(resolved.signal);
      if (resolved.signal?.aborted || stopIntake) return;

      // Hold a width slot for the whole product. Above the machine's capacity
      // this is where the surplus workers wait — they keep their place in the
      // queue, they simply do not add a twentieth renderer to an eight-core box.
      if (!(await width.acquire(resolved.signal))) return;

      const input = inputs[index];
      log.step(`\n=== [${index + 1}/${inputs.length}] ${input.sku} — ${input.targetSeller} ===`);

      const startedAt = Date.now();
      let result: ScrapeResult;
      try {
        result = await scrapeWithBackoff(
          browser,
          input,
          pacedForWidth(resolved, width.current()),
          gate,
          limiter,
          workerId,
        );
      } finally {
        width.release();
      }
      // Wall-clock for the whole product, gap included — that is what the width
      // controller is trying to trade against. `result.durationMs` stops at the
      // last extraction and would leave the between-products pacing invisible.
      //
      // Only clean first attempts are measured. A product that sat out a block
      // back-off carries a minute of Flipkart's decision in its duration, and a
      // retried one carries a second scrape; feeding either to the controller
      // would have it narrow the pool in response to something that has nothing
      // to do with how loaded this machine is.
      const firstAttempt = (result.attempts ?? 1) === 1 && result.status !== 'BLOCKED';
      if (!resolved.signal?.aborted && firstAttempt) width.record(Date.now() - startedAt);

      // An abort mid-product produces a torn result — the context was closed out
      // from under Playwright. Dropping it unreported leaves the row exactly as
      // it was, so a later resume scrapes it cleanly instead of trusting a
      // failure we caused ourselves.
      if (resolved.signal?.aborted) {
        log.warn(`cancelled during ${input.sku} — leaving it unrecorded for resume.`);
        return;
      }

      slots[index] = result;
      await onResult?.(result, index);

      if (result.status === 'BLOCKED') {
        stopIntake = true;
        log.error(
          `still blocked after ${resolved.blockRetries} back-off(s) — no new products will be started.`,
        );
        return;
      }
    }
  };

  try {
    // Every worker's logging is tagged with its id, so the one interleaved
    // stream can still be read back per product.
    await Promise.all(
      Array.from({ length: workerCount }, (_, workerId) => runAsWorker(workerId, () => runWorker(workerId))),
    );
  } finally {
    await browser.close().catch(() => undefined);
  }

  const results = slots.filter((slot): slot is ScrapeResult => slot !== null);
  const unprocessed = inputs.length - results.length;
  if (stopIntake && unprocessed > 0) {
    log.error(`${unprocessed} product(s) left unprocessed — resume to continue.`);
  }
  return results;
}

/* ---------------------------------------------------------------- internals */

/**
 * Failures that describe the run rather than the listing.
 *
 * Each of these means "we did not manage to read the page this time": the
 * markup had not rendered when the wait expired, the seller list never came up,
 * navigation threw. On an idle machine they are rare; under a pool they are
 * mostly our own load coming back as an error, and a second look — in a fresh
 * context, with the page rendered again from scratch — usually settles it.
 *
 * Deliberately absent:
 *   - PRODUCT_UNAVAILABLE and SELLER_NOT_FOUND are *answers*. The listing is
 *     dead, or the seller genuinely is not on it. Retrying them would pay a
 *     second scrape for every correct negative in the batch, and the guard
 *     against a starved seller list being mistaken for an absent seller is the
 *     settling window in sellerDrawer, not a retry here.
 *   - BLOCKED has its own back-off loop above; it must not also come through
 *     here, or a bot wall would be retried without the pause that clears it.
 */
const TRANSIENT_STATUSES: readonly ScrapeStatus[] = [
  'NO_SELLER_LINK',
  'SELLER_LIST_LOAD_FAILED',
  'MAIN_PRICE_NOT_FOUND',
  'SELLER_PRICE_NOT_FOUND',
  'ERROR',
];

/**
 * Run one product, pausing and retrying while it comes back BLOCKED, then
 * giving a run-shaped failure one more go.
 *
 * The pause doubles each time: a bot wall clears on Flipkart's schedule, not
 * ours, so hammering it at a fixed interval just extends the block. The pause is
 * published to the shared gate so the rest of the pool waits it out too.
 */
async function scrapeWithBackoff(
  browser: Browser,
  input: ScrapeInput,
  options: ResolvedOptions,
  gate: BlockGate,
  limiter: RateLimiter,
  workerId: number,
): Promise<ScrapeResult> {
  let attempts = 1;
  let result = await scrapeOnce(browser, input, options, limiter, attempts, workerId);

  for (let attempt = 1; attempt <= options.blockRetries && result.status === 'BLOCKED'; attempt++) {
    if (options.signal?.aborted) break;
    const backoffMs = options.blockBackoffMs * 2 ** (attempt - 1);
    log.warn(`blocked — pausing ${Math.round(backoffMs / 1000)}s (back-off ${attempt}/${options.blockRetries})`);

    gate.hold(backoffMs);
    await gate.wait(options.signal);
    if (options.signal?.aborted) break;

    attempts++;
    result = await scrapeOnce(browser, input, options, limiter, attempts, workerId);
  }

  // One second look at a failure that reads as ours rather than the listing's.
  // Bounded to a single extra attempt, and only ever on a product that is
  // already lost — a batch that is scraping cleanly pays nothing for this.
  if (!options.signal?.aborted && TRANSIENT_STATUSES.includes(result.status)) {
    log.warn(`${result.status} — one retry in a fresh context before recording it.`);
    attempts++;
    const retried = await scrapeOnce(browser, input, options, limiter, attempts, workerId);
    // Take the retry's verdict either way: it is the more recent evidence, and
    // its screenshot and message describe the attempt that was actually kept.
    if (!options.signal?.aborted) result = retried;
  }

  return { ...result, attempts };
}

/** One product in its own context, with every throw flattened into a result. */
async function scrapeOnce(
  browser: Browser,
  input: ScrapeInput,
  options: ResolvedOptions,
  limiter: RateLimiter,
  attempt: number,
  workerId: number,
): Promise<ScrapeResult> {
  const context = await createContext(browser, options);

  // Playwright has no notion of an AbortSignal, and a product can be parked in a
  // 20s wait. Closing the context is the one lever that makes those calls return
  // now; the resulting throw is caught below and discarded by the caller.
  const abortContext = (): void => {
    void context.close().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', abortContext, { once: true });

  // The same lever, on a timer: no single attempt may outrun its budget however
  // the waits inside it happen to compose. See ScraperOptions.productBudgetMs.
  let overBudget = false;
  const budget = setTimeout(() => {
    overBudget = true;
    log.warn(`over budget after ${Math.round(options.productBudgetMs / 1000)}s — abandoning this attempt.`);
    abortContext();
  }, options.productBudgetMs);

  const gaveUp = (): string =>
    `Gave up after ${Math.round(options.productBudgetMs / 1000)}s — the page never became readable.`;

  try {
    // `betweenProducts` only here, not in `scrapeProduct`: idle browsing and
    // pacing belong in the gap *between* products, and a single-product run has
    // no next product.
    const result = await scrapeInContext(context, input, options, workerId, limiter, attempt, true);
    // Closing the context throws inside the pipeline, which catches it and
    // reports whatever Playwright said about a closed target. Say what actually
    // happened instead — the status is right, only the message is misleading.
    return overBudget && result.status !== 'OK' ? { ...result, message: gaveUp() } : result;
  } catch (error) {
    return failure(input, 'ERROR', overBudget ? gaveUp() : errorMessage(error));
  } finally {
    clearTimeout(budget);
    options.signal?.removeEventListener('abort', abortContext);
    await context.close().catch(() => undefined);
  }
}

async function launchBrowser(options: ResolvedOptions): Promise<Browser> {
  return chromium.launch({
    headless: options.headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    // Set at the browser, not per context: every worker shares one browser, and
    // splitting them across exits would only make the traffic look stranger,
    // not less. Undefined is the normal case and means a direct connection.
    proxy: options.proxy,
  });
}

async function createContext(browser: Browser, options: ResolvedOptions): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: 'en-IN',
    storageState: options.storageStatePath,
  });
  context.setDefaultTimeout(options.timeout);
  context.setDefaultNavigationTimeout(options.navigationTimeout);
  if (options.blockResources) await installResourceBlocking(context);
  return context;
}

/**
 * Drop requests for bytes no extractor reads.
 *
 * A product page pulls roughly ninety images plus fonts and a spread of
 * analytics beacons, none of which contribute a character to a price, a seller
 * name or an availability string. Every one of them competes for the same
 * connection pool as the markup we actually need.
 *
 * Stylesheets and scripts always continue, by construction — see
 * BLOCKED_RESOURCE_TYPES for why blocking CSS would corrupt prices silently
 * rather than fail loudly.
 */
async function installResourceBlocking(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const request = route.request();

    if (BLOCKED_RESOURCE_TYPES.includes(request.resourceType())) {
      void route.abort().catch(() => undefined);
      return;
    }

    // Suffix match so subdomains are covered, anchored on a dot boundary so
    // "notgoogle-analytics.com" cannot match "google-analytics.com".
    let host = '';
    try {
      host = new URL(request.url()).hostname;
    } catch {
      // Unparseable URL: let it through rather than guess.
    }
    if (host && BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
      void route.abort().catch(() => undefined);
      return;
    }

    void route.continue().catch(() => undefined);
  });
}

/** The actual pipeline, factored out so both entry points share it exactly. */
async function scrapeInContext(
  context: BrowserContext,
  input: ScrapeInput,
  options: ResolvedOptions,
  workerId: number,
  limiter: RateLimiter,
  attempt = 1,
  betweenProducts = false,
): Promise<ScrapeResult> {
  const startedAt = Date.now();
  const step = (name: Parameters<NonNullable<ResolvedOptions['onStep']>>[0]): void => {
    try {
      options.onStep?.(name, input, workerId);
    } catch {
      // Progress reporting must never break a scrape.
    }
  };

  // The gap this product hands over to the next one. Pulled out because three
  // paths now finish without ever opening a page, and a page-less product has
  // nothing to browse idly on — but the politeness throttle still applies,
  // because the next product is a request either way.
  const handOver = async (): Promise<void> => {
    if (betweenProducts) await jitteredDelay(options.delayMs, options.delayJitterMs, options.signal);
  };

  // 0. The whole comparison from one request, off the endpoint the /sellers
  //    page itself calls — no page, no PDP, no renderer.
  //
  // That one reply carries the headline price, the listing the page defaults to
  // and the COMPLETE seller list, so a product that it answers is finished here
  // in a few hundred milliseconds. See scraper/sellerApi.ts for what it returns
  // and why the rendered seller list could never beat it.
  //
  // Null means "not conclusive", not "not ours": everything below then runs
  // exactly as it did before this call existed.
  step('opening');
  const api =
    options.sellerApi && input.fsn
      ? await fetchSellerListings(context, input.fsn, options, options.userAgent ?? DEFAULT_USER_AGENT, limiter)
      : null;

  // Being metered is a fact about our IP, not about this product, and the one
  // answer it must never get is "then go and render the page" — that spends a
  // PDP, a seller-page navigation and two script bundles at the exact moment we
  // have been told to make fewer requests, and with the pool's timeouts widened
  // for load it costs minutes to arrive at nothing. BLOCKED is the status that
  // already means this: it parks the whole pool on the shared gate, waits, and
  // retries the product cheaply.
  if (api?.kind === 'throttled') {
    return {
      ...failure(input, 'BLOCKED', 'Flipkart rate limited the seller API (HTTP 429).'),
      durationMs: Date.now() - startedAt,
      attempts: attempt,
    };
  }

  if (api?.kind === 'read') {
    const resolved = resolveFromApi(input, api.reading, startedAt, attempt);
    if (resolved) {
      step('done');
      log.step('Done.');
      await handOver();
      return resolved;
    }
  }

  // 1. The buy box, off the raw HTML — no page, no renderer.
  //
  // Second in line now: the seller API answers the same question and more. This
  // still runs for the products it could not read, where it decides how much of
  // the rest is worth doing. If the account already holds the buy box, its price
  // IS the page price, the bank settlement does not move, and the seller list
  // has nothing to add — so that product is finished here too.
  const probe = options.buyboxProbe ? await probeBuybox(context, input.productUrl, options) : null;
  if (probe) log.info(`fulfilled by: ${probe.buyboxSeller} (from page HTML)`);

  if (probe && sellerNamesMatch(probe.buyboxSeller, input.targetSeller)) {
    log.step('Buy box is already ours — no seller comparison needed.');
    step('done');
    await handOver();
    return {
      fsn: input.fsn,
      sku: input.sku,
      sellerName: probe.buyboxSeller,
      buyboxSellerName: probe.buyboxSeller,
      mainListingIsAccountSeller: true,
      mainPrice: probe.mainPrice,
      sellerPrice: probe.mainPrice,
      difference: null,
      isPriceDifferent: false,
      productUrl: input.productUrl,
      status: 'OK',
      durationMs: Date.now() - startedAt,
      attempts: attempt,
    };
  }

  // The seller list is addressable directly as /sellers?pid=<FSN>, and a probe
  // has already answered everything the PDP would have been rendered for. Both
  // halves have to hold: without a pid there is no address to open, and the
  // click-through fallback needs a product page to come home to.
  const knownPid = probe ? (probe.pid ?? (input.fsn || null)) : null;
  const skipProductPage = probe !== null && knownPid !== null;

  const page = await context.newPage();
  let capture: NetworkCapture | null = null;
  if (options.useNetworkCapture) capture = attachNetworkCapture(page);

  try {
    let mainPrice: number;
    let fulfilledBy: string | null;
    let entry: SellerListEntry;

    if (skipProductPage && probe) {
      // Straight to the seller list. Rendering the PDP now would spend a second
      // reproducing the two numbers already in hand.
      mainPrice = probe.mainPrice;
      fulfilledBy = probe.buyboxSeller;
      entry = { link: null, url: sellersUrlForPid(knownPid as string), productUrl: probe.productUrl };
    } else {
      // 1. Open the product page.
      await openProduct(page, input.productUrl, options);

      // 2. Structured data first — it carries the price, sku and availability.
      step('reading-page');
      const jsonLd = await readProductJsonLd(page);

      // One read of the page's text answers the availability question. Structured
      // data misses some of these — a listing whose JSON-LD still says InStock can
      // render "Out of stock" — so the text check is not redundant with the above.
      const signals = await readPageSignals(page);
      const unavailable = await checkAvailability(page, jsonLd, signals);
      if (unavailable) {
        throw new ScrapeError('PRODUCT_UNAVAILABLE', unavailable);
      }

      // 3. Main price.
      step('main-price');
      const domPrice = await getMainPrice(page, jsonLd, options);
      if (domPrice === null) {
        throw new ScrapeError('MAIN_PRICE_NOT_FOUND', 'Could not read the product page price.');
      }
      mainPrice = domPrice;

      // 4. Who the page says is fulfilling this listing — the winning seller.
      fulfilledBy = await getFulfilledBy(page);
      if (fulfilledBy) log.info(`fulfilled by: ${fulfilledBy}`);

      // The probe answers this for most products, but a page it could not read
      // reaches here unanswered — and the account holding the buy box still ends
      // the product, whichever read established it.
      if (sellerNamesMatch(fulfilledBy, input.targetSeller)) {
        step('done');
        return {
          fsn: input.fsn,
          sku: input.sku,
          sellerName: fulfilledBy,
          buyboxSellerName: fulfilledBy,
          mainListingIsAccountSeller: true,
          mainPrice,
          sellerPrice: mainPrice,
          difference: null,
          isPriceDifferent: false,
          productUrl: input.productUrl,
          status: 'OK',
          durationMs: Date.now() - startedAt,
          attempts: attempt,
        };
      }

      entry = await findSellerListEntry(page, jsonLd, input.productUrl, input.fsn);
    }

    // 5. Into the seller list.
    step('opening-sellers');
    await openSellerDrawer(page, entry, options);

    // 6. Find the seller, paging as needed.
    step('finding-seller');
    const { seller, sellers, source, sellersScanned, showMoreClicks } = await getSellerPrice(
      page,
      input.targetSeller,
      capture,
      options,
    );

    // Who holds the buy box. The PDP's "Fulfilled by" line states it outright, so
    // that wins; inferring it from the seller list is only the fallback for pages
    // that carry no such line.
    const buyboxSellerName = fulfilledBy ?? pickBuyboxSeller(sellers, mainPrice, source === 'dom')?.name ?? null;

    if (!seller) {
      throw new ScrapeError(
        'SELLER_NOT_FOUND',
        `"${input.targetSeller}" is not among the ${sellersScanned} sellers listed for this product.`,
      );
    }
    if (seller.price === null) {
      throw new ScrapeError('SELLER_PRICE_NOT_FOUND', `Found "${seller.name}" but could not read its price.`);
    }

    // 6. Compare.
    step('comparing');
    log.step('Comparing prices...');
    const { difference, isPriceDifferent } = comparePrice(mainPrice, seller.price);

    step('done');
    log.step('Done.');
    return {
      fsn: input.fsn,
      sku: input.sku,
      sellerName: seller.name,
      buyboxSellerName,
      mainPrice,
      sellerPrice: seller.price,
      difference,
      isPriceDifferent,
      productUrl: input.productUrl,
      status: 'OK',
      sellersScanned,
      showMoreClicks,
      source,
      durationMs: Date.now() - startedAt,
      attempts: attempt,
    };
  } catch (error) {
    const screenshotPath = await captureFailureScreenshot(page, input, options, attempt);
    const tail = { durationMs: Date.now() - startedAt, attempts: attempt, screenshotPath };

    if (error instanceof ScrapeError) {
      log.error(`${error.code}: ${error.message}`);
      return { ...failure(input, error.code, error.message), ...tail };
    }
    log.error(errorMessage(error));
    return { ...failure(input, 'ERROR', errorMessage(error)), ...tail };
  } finally {
    capture?.detach();

    // The handover to this worker's next product. The result above is already
    // built and returned by this point, so nothing here can change it.
    //
    // Idle browsing and the politeness throttle run CONCURRENTLY, not one after
    // the other. They are two ways of spending the same gap — the mouse drift
    // happens on the finished page while the throttle counts down — so running
    // them in series was paying for that gap twice.
    if (betweenProducts) {
      await Promise.all([
        humanBehavior(page, { enabled: options.humanLikeBehavior, signal: options.signal }),
        jitteredDelay(options.delayMs, options.delayJitterMs, options.signal),
      ]);
    }

    await page.close().catch(() => undefined);
  }
}

/**
 * Turn one seller-API reading into a finished product, or null to hand it to
 * the rendered pipeline.
 *
 * Two of the three outcomes are answered here outright:
 *
 *   - the buy box is the account's own listing, so its price IS the page price
 *     and there is nothing to compare;
 *   - the account is in the list at a readable price, so compare and be done.
 *
 * The third — the target seller is not in the list — deliberately returns null
 * and renders the page. The reply is provably complete (a 38-seller product
 * comes back with all 38, and "Show More" is client-side reveal of a list
 * already downloaded), so the rendered path will almost always agree. But
 * SELLER_NOT_FOUND is the one verdict that reads as *fact* in the
 * recommendations — "this seller is not on this listing" — rather than as a
 * retryable failure, and it is the verdict a payload whose shape had shifted
 * under us would produce silently. So the products that would carry it are the
 * ones that still get looked at the slow way. They are a minority of a batch,
 * and the cost of the second look is one extra request on a product that was
 * always going to be the expensive kind.
 */
function resolveFromApi(
  input: ScrapeInput,
  api: SellerApiReading,
  startedAt: number,
  attempt: number,
): ScrapeResult | null {
  const tail = {
    fsn: input.fsn,
    sku: input.sku,
    productUrl: input.productUrl,
    mainPrice: api.mainPrice,
    buyboxSellerName: api.buyboxSeller,
    status: 'OK' as const,
    sellersScanned: api.sellers.length,
    showMoreClicks: 0,
    source: 'api' as const,
    durationMs: Date.now() - startedAt,
    attempts: attempt,
  };

  if (sellerNamesMatch(api.buyboxSeller, input.targetSeller)) {
    log.step('Buy box is already ours — no seller comparison needed.');
    return {
      ...tail,
      sellerName: api.buyboxSeller,
      mainListingIsAccountSeller: true,
      sellerPrice: api.mainPrice,
      difference: null,
      isPriceDifferent: false,
    };
  }

  const seller = findSeller(api.sellers, input.targetSeller);
  // A named seller with no price is a reply we do not understand well enough to
  // record; the rendered path reads that card for itself.
  if (!seller || seller.price === null) return null;

  log.step('Seller found...');
  const { difference, isPriceDifferent } = comparePrice(api.mainPrice, seller.price);
  return {
    ...tail,
    sellerName: seller.name,
    mainListingIsAccountSeller: false,
    sellerPrice: seller.price,
    difference,
    isPriceDifferent,
  };
}

/**
 * Screenshot a failed product. Returns the path written, or undefined.
 *
 * The name carries sku, fsn and attempt because none of them is unique alone:
 * sku can be blank, the same sku can appear under two URLs, and a back-off retry
 * of the same row would otherwise overwrite the evidence from the first failure.
 */
async function captureFailureScreenshot(
  page: Page,
  input: ScrapeInput,
  options: ResolvedOptions,
  attempt: number,
): Promise<string | undefined> {
  if (!options.screenshotOnFailureDir) return undefined;

  const safe = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
  const path = `${options.screenshotOnFailureDir}/${safe(input.sku)}-${safe(input.fsn)}-a${attempt}.png`;

  const written = await page
    .screenshot({ path, fullPage: false })
    .then(() => true)
    .catch(() => false);

  if (!written) return undefined;
  log.info(`failure screenshot written to ${path}`);
  return path;
}

/** Build a result for a run that could not produce prices. */
function failure(input: ScrapeInput, status: ScrapeStatus, message: string): ScrapeResult {
  return {
    fsn: input.fsn,
    sku: input.sku,
    sellerName: null,
    buyboxSellerName: null,
    mainListingIsAccountSeller: false,
    mainPrice: null,
    sellerPrice: null,
    difference: null,
    isPriceDifferent: false,
    productUrl: input.productUrl,
    status,
    message,
  };
}
