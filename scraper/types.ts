/**
 * Shared types for the Flipkart seller-price scraper.
 */

export interface ScrapeInput {
  productUrl: string;
  targetSeller: string;
  sku: string;
  fsn: string;
  /** Per-FSN floor from the account's Lowest Listing File column. */
  lowestListingFile?: number;
  /**
   * Per-product bank-settlement figures used only by the dashboard's settlement
   * view. The scraper reads none of these — they pass through untouched from the
   * inputs file to the journal-joined rows. Optional so older inputs stay valid.
   */
  currentBankSettlement?: number;
  bankSettlementThreshold?: number;
  /**
   * Flipkart's own "Benchmark Price" for this listing — its system-generated
   * read of a competitive price, from the same seller listing sheet. Zero is a
   * real value in that column and means Flipkart has no read, not ₹0.
   */
  benchmarkPrice?: number;
  /** "System Stock count". Zero orders on a zero-stock listing is not a price problem. */
  stockCount?: number;
  /**
   * The seller listing sheet's own "Your Listing Price" — the price as listed,
   * which is not always the price the product page ends up showing. The scraper
   * ignores it; it passes through for the recommendation's expected-price maths.
   */
  listingPrice?: number;
}

export type ScrapeStatus =
  | 'OK'
  | 'PRODUCT_UNAVAILABLE'
  | 'NO_SELLER_LINK'
  | 'SELLER_LIST_LOAD_FAILED'
  | 'SELLER_NOT_FOUND'
  | 'MAIN_PRICE_NOT_FOUND'
  | 'SELLER_PRICE_NOT_FOUND'
  | 'BLOCKED'
  | 'ERROR';

export interface ScrapeResult {
  fsn: string;
  sku: string;
  sellerName: string | null;
  /**
   * The seller holding the buy box — the offer the product page headlines.
   * Optional so journals written before this field existed still parse.
   */
  buyboxSellerName?: string | null;
  /** True when the product page's main seller is the account seller. */
  mainListingIsAccountSeller?: boolean;
  mainPrice: number | null;
  sellerPrice: number | null;
  /** sellerPrice - mainPrice. Null when either side is missing. */
  difference: number | null;
  isPriceDifferent: boolean;
  productUrl: string;

  /** Diagnostics — safe to ignore, useful when a run misbehaves. */
  status: ScrapeStatus;
  message?: string;
  sellersScanned?: number;
  showMoreClicks?: number;
  /** Where the seller list came from. */
  source?: 'network' | 'dom' | 'api';
  durationMs?: number;
  /** How many times this product was attempted, including back-off retries. 1 when it worked first go. */
  attempts?: number;
  /** Path to the failure screenshot, when one was captured. */
  screenshotPath?: string;
}

/** Coarse stages of one product's scrape, for live progress reporting. */
export type ScrapeStep =
  | 'opening'
  | 'reading-page'
  | 'main-price'
  | 'opening-sellers'
  | 'finding-seller'
  | 'comparing'
  | 'done';

/**
 * Called as a product moves through the pipeline. Purely informational.
 *
 * `workerId` is the 0-based index of the worker that owns this product. With
 * `concurrency: 1` it is always 0; above that it is what lets a caller keep
 * one live progress slot per worker instead of thrashing a single shared one.
 */
export type StepReporter = (step: ScrapeStep, input: ScrapeInput, workerId: number) => void;

/** A seller row as read off the page (or a network payload). */
export interface SellerCard {
  name: string;
  price: number | null;
  mrp?: number | null;
  rawPriceText?: string;
}

export interface ScraperOptions {
  headless?: boolean;
  /** Default per-action timeout (ms). */
  timeout?: number;
  /** Overall navigation timeout (ms). */
  navigationTimeout?: number;
  /**
   * Hard cap on "Show more" clicks. This is a runaway guard only — the loop
   * normally stops when the seller is found or the button disappears.
   */
  maxShowMoreClicks?: number;
  /**
   * How many products to scrape at once, each in its own browser context.
   *
   * 1 reproduces the old strictly-sequential behaviour exactly. Above that,
   * results still stream through `onResult` the moment each product lands, and
   * the journal is keyed by product rather than by position, so completeness
   * and resume are unaffected by the interleaving.
   *
   * The ceiling here is Flipkart's tolerance, not ours: N workers means roughly
   * N times the request rate from one IP. 3 is the CLI default; the dashboard
   * runs the pool at MAX_CONCURRENCY (20), paced by `delayMs` per worker.
   */
  concurrency?: number;

  /**
   * Drop images, media and fonts before they are fetched. On by default: a
   * Flipkart PDP pulls ~90 images that no extractor ever reads.
   *
   * Stylesheets and scripts are always allowed through, whatever this is set
   * to — the struck-through MRP is told apart from the selling price with
   * `getComputedStyle`, and that decoration comes from Flipkart's external CSS
   * bundles. Blocking CSS would not fail loudly; it would silently start
   * reporting MRPs as selling prices.
   */
  blockResources?: boolean;

  /**
   * Try to reuse a captured seller API/network payload before DOM scraping.
   *
   * Off by default. Across 1010 recorded products it resolved zero of them,
   * while buffering the JSON body of every response whose URL merely looked
   * seller-ish. Left in as an opt-in for the day Flipkart exposes a real one.
   */
  useNetworkCapture?: boolean;
  /** Skip clicking and navigate straight to /sellers?pid=... when we can. */
  preferDirectSellerNavigation?: boolean;

  /**
   * Ask who holds the buy box before rendering anything, by fetching the product
   * page as HTML and reading its "Fulfilled by" line and structured data.
   *
   * On by default, and the single biggest saving in a batch: roughly a quarter
   * of a typical run is already won by the account, and those products finish on
   * the probe alone without ever opening a browser page. The rest skip the
   * product-page render too — the probe has read the price, so the browser opens
   * straight onto the seller list.
   *
   * A probe that is anything short of conclusive returns nothing and the product
   * is rendered exactly as it was before, so turning this off changes speed and
   * nothing else.
   */
  buyboxProbe?: boolean;

  /**
   * Read the seller list from the endpoint the /sellers page itself calls,
   * instead of rendering that page and scraping its cards.
   *
   * On by default, and by a wide margin the largest saving in the scraper. One
   * POST returns the headline price, the buy-box listing and the COMPLETE
   * seller list — so a product needs no browser page at all: no PDP, no
   * /sellers navigation, no hydration wait, no card-count settle, no "Show
   * More" paging. Measured against the rendered path it agrees on every price
   * and every seller, and returns in a few hundred milliseconds rather than
   * tens of seconds.
   *
   * A reply that is anything short of complete returns nothing and the product
   * is rendered exactly as it was before, so turning this off changes speed and
   * nothing else. See scraper/sellerApi.ts.
   */
  sellerApi?: boolean;

  /**
   * Ceiling on requests per second **for the whole pool**, not per worker.
   *
   * Flipkart meters the seller endpoint per IP: a large opening allowance, then
   * a refill of roughly four or five a second, and HTTP 429 for everything over
   * it. `delayMs` cannot express that, because it is a gap between one worker's
   * products — eight workers at 1500ms produced 0.2 requests a second when a
   * product took 40s and produce 4.4 now that one takes 0.3s, without a single
   * setting changing. That twenty-fold jump is what makes a fast run collapse
   * after the burst allowance is spent.
   *
   * This is a starting rate, not a fixed one: a 429 halves it and pauses the
   * pool, and a long clean streak wins it back, so a run converges just under
   * whatever its own IP is allowed. A datacentre address — a GitHub Actions
   * runner, say — is metered far more tightly than a home connection, and
   * neither has to be told which it is.
   */
  maxRequestsPerSecond?: number;

  /**
   * How many times one product re-asks the seller API after a 429 before it is
   * handed to the pool-wide block back-off.
   *
   * Each retry costs one request and a cooldown the limiter has already
   * imposed, so this is cheap; the alternative — rendering the page — costs a
   * PDP, a seller-page navigation and two script bundles to learn the same
   * thing.
   */
  sellerApiThrottleRetries?: number;

  /**
   * Hard ceiling on one attempt at one product, in ms. A backstop, not a knob.
   *
   * Every wait in the rendered pipeline is individually reasonable and they
   * compose into something that is not: `openProduct` retries its navigation
   * three times, `openSellerDrawer` twice, and `pacedForWidth` multiplies each
   * of those timeouts by up to 2.5 when the pool is wide. A 45s navigation
   * timeout becomes 84s, three of those is 252s, and the seller list has not
   * been opened yet. That is how a product that is merely being refused
   * everywhere turns into five minutes of wall-clock — and, because the pool
   * width controller measures wall-clock, into a narrower pool as well.
   *
   * No individual timeout is wrong, so none of them is changed. This bounds the
   * product instead: when the budget is spent the context is closed, which is
   * the one lever that makes a parked Playwright call return, and the attempt is
   * recorded as a failure it can be resumed from.
   */
  productBudgetMs?: number;

  /** Emit progress logs. */
  verbose?: boolean;
  /** Playwright storageState path, for a logged-in session if you need one. */
  storageStatePath?: string;
  userAgent?: string;
  /**
   * Screenshot destination on failure.
   *
   * The dashboard's worker leaves this unset. It runs on a GitHub Actions
   * runner whose filesystem is destroyed when the job ends, so a screenshot
   * written there could only ever be a dead path in the results. The CLI still
   * sets it, because a local run has a disk that outlives it.
   */
  screenshotOnFailureDir?: string;

  /**
   * Route Chromium through an HTTP/SOCKS proxy.
   *
   * Unset means direct, which is what a local run wants. It exists for the
   * GitHub Actions worker: Flipkart rate-limits and bot-walls by IP, and
   * Actions runners come from Azure datacentre ranges that e-commerce sites
   * commonly treat as suspect. If a batch starts coming back full of BLOCKED
   * rows, pointing this at a residential proxy is the fix, and it is the whole
   * fix — nothing else in the scraper changes.
   */
  proxy?: {
    /** e.g. `http://proxy.example.com:8000` or `socks5://…`. */
    server: string;
    username?: string;
    password?: string;
  };

  /**
   * Pause between products, in ms. Zero (the default) preserves the old
   * back-to-back behaviour; anything above ~1000 is strongly advised for
   * batches in the hundreds, where 1000 rapid hits from one IP is what
   * actually trips Flipkart's bot wall.
   */
  delayMs?: number;
  /** Random 0..n ms added to each `delayMs` pause, so the cadence isn't robotic. */
  delayJitterMs?: number;
  /** First back-off pause after a BLOCKED product. Doubles per consecutive block. */
  blockBackoffMs?: number;
  /** How many times to back off and retry one product before giving up on the run. */
  blockRetries?: number;

  /**
   * Between products in a batch, spend ~0.5–3s doing idle human things on the
   * finished page — small curved mouse moves, a short scroll, a hover — before
   * the next product opens. Purely decorative: it runs after the result has
   * been computed, changes no page state, and cannot affect extracted data.
   * Defaults to on; set false to go straight from one product to the next.
   */
  humanLikeBehavior?: boolean;

  /**
   * Cancels a batch. Checked between products, and — because a product can sit
   * inside a 20s Playwright wait — also wired to close the active browser
   * context, so aborting takes effect immediately rather than at the next
   * product boundary. The aborted product is left unreported so a later resume
   * picks it up untouched.
   */
  signal?: AbortSignal;

  /**
   * Asked before each worker picks up its NEXT product. Return true to wind the
   * pool down gracefully.
   *
   * This is the difference between a Pause and a Stop. `signal` tears down the
   * active contexts at once, which abandons every product currently in flight —
   * correct for a Stop, but under a worker pool it would throw away the other
   * workers' half-finished products too, when the user only asked to stop after
   * the current one. Draining lets each worker finish and journal what it holds
   * and then exit, so nothing is left half-done.
   */
  shouldStop?: () => boolean;

  /** Fires as each product moves through the pipeline. Drives the live progress panel. */
  onStep?: StepReporter;
}

/** Called after each product in a batch, before the next one starts. */
export type ResultSink = (result: ScrapeResult, index: number) => void | Promise<void>;

export interface ResolvedOptions
  extends Required<
    Omit<
      ScraperOptions,
      | 'storageStatePath'
      | 'screenshotOnFailureDir'
      | 'userAgent'
      | 'proxy'
      | 'signal'
      | 'onStep'
      | 'shouldStop'
    >
  > {
  storageStatePath?: string;
  screenshotOnFailureDir?: string;
  userAgent?: string;
  proxy?: ScraperOptions['proxy'];
  signal?: AbortSignal;
  onStep?: StepReporter;
  shouldStop?: () => boolean;
}
