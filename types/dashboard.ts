/**
 * Dashboard-facing types.
 *
 * The scraper's own types are re-exported rather than redefined — `ScrapeResult`
 * is the contract the journal is written in, and duplicating it here would be
 * the fastest way to let the two drift apart.
 */

import type { ScrapeInput, ScrapeResult, ScrapeStatus, ScrapeStep } from '@/scraper/types';

export type { ScrapeInput, ScrapeResult, ScrapeStatus, ScrapeStep };

/* --------------------------------------------------------------------- job */

/**
 * Lifecycle of a batch.
 *
 * `pausing` and `stopping` are transient: the control API returns immediately
 * while the runner finishes what it is doing, and the UI needs to show that
 * in-between state rather than lying about being already paused.
 *
 * `interrupted` is set by crash recovery at boot, never by the runner itself.
 */
export type JobState =
  | 'draft'
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'interrupted';

/** States from which the runner can be started or resumed. */
export const RESUMABLE_STATES: readonly JobState[] = ['draft', 'queued', 'paused', 'stopped', 'interrupted'];

/** States where the runner currently owns the job. */
export const ACTIVE_STATES: readonly JobState[] = ['running', 'pausing', 'stopping'];

export type RowStatus = 'pending' | 'running' | 'success' | 'failed' | 'paused' | 'cancelled';

/**
 * The most workers a batch may run.
 *
 * Twenty contexts in one Chromium instance behind one residential IP.
 *
 * Read this as a ceiling, not a target. Workers are browser contexts competing
 * for the same cores, and on a host with fewer cores than workers, raising this
 * number does not make a batch finish sooner — measured on eight cores against
 * the real markup, twenty workers retired *fewer* products per second than
 * eight, and stretched each product from four seconds to fifteen. Since every
 * wait in the scraper is wall-clock, that stretch is what turns machine load
 * into SELLER_LIST_LOAD_FAILED rows: the run gets no faster and the output gets
 * worse.
 *
 * So the pool sizes itself. `PoolWidth` admits as many products at once as the
 * machine is actually retiring work with, climbing towards this ceiling while
 * that keeps paying and holding below it when it does not — a big host with
 * slow network reaches twenty, a laptop settles near its core count, and
 * neither has to be told which it is. Raising this number gives a capable host
 * more room; it can no longer flood a small one.
 */
export const MAX_CONCURRENCY = 20;

/** The subset of ScraperOptions a dashboard user is allowed to set per job. */
export interface JobOptions {
  delayMs: number;
  delayJitterMs: number;
  timeout: number;
  blockBackoffMs: number;
  blockRetries: number;
  /** Products scraped at once, each in its own browser context. 1 = sequential. */
  concurrency: number;
  /** Drop images, media and fonts. Never blocks CSS — prices depend on it. */
  blockResources: boolean;
  useNetworkCapture: boolean;
  /** Local-only convenience: watch the browser work. Useless on a headless host. */
  headed: boolean;
}

export const DEFAULT_JOB_OPTIONS: JobOptions = {
  // 1500ms is the pacing the scraper's own docs recommend for large batches;
  // defaulting to it means the dashboard is polite out of the box. Note that
  // this is per worker, so the pool's aggregate request rate is roughly
  // `concurrency` times what a single worker would produce — at the default
  // pool that is a product every ~75ms, which is why the delay is not lowered
  // to buy speed. Speed comes from the pool; the delay is what keeps it from
  // reading as a burst.
  delayMs: 1500,
  delayJitterMs: 400,
  timeout: 20_000,
  blockBackoffMs: 60_000,
  blockRetries: 3,
  concurrency: MAX_CONCURRENCY,
  blockResources: true,
  // Zero hits in 1010 recorded products; opt in only if Flipkart ships an API.
  useNetworkCapture: false,
  headed: false,
};

/**
 * How many SKUs landed in each recommendation bucket.
 *
 * Stored on the manifest so the dashboard can show an upload's headline figures
 * without opening its recommendations file.
 */

/**
 * What the uploaded orders report covered.
 *
 * "Last 24 hours" is measured against the report's own newest order, not the
 * wall clock — a report downloaded this morning still has a well-defined last
 * day, and re-opening the batch next week must not silently empty it.
 */
export interface OrdersWindow {
  start: string;
  end: string;
  last24hStart: string;
  observedDays: number;
  orderItems: number;
  units: number;
  fsnCount: number;
}

/** Persisted as job.json. The durable description of a batch. */
export interface JobManifest {
  id: string;
  name: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  state: JobState;
  total: number;
  options: JobOptions;
  /** Set when recovery finds the job was interrupted mid-run. */
  interruptedAt?: string;

  /**
   * The Flipkart account this upload belongs to — the seller name applied to
   * every row. History is read account-wise, so this is what partitions it.
   * Optional because jobs created before accounts existed have none; those are
   * backfilled from the rows' target seller on load.
   */
  accountName?: string;
  /** When the spreadsheet was uploaded. Mirrors `createdAt` for older jobs. */
  uploadTime?: string;
  /**
   * Headline figures of the orders report this batch was judged against, when
   * one was uploaded. Mirrored onto the manifest so a batch can say what its
   * "last 24 hours" actually covered without opening orders.json.
   */
  ordersWindow?: OrdersWindow;
  /** Filled in once recommendations have been generated for this job. */
  recommendationSummary?: string;
  recommendationsGeneratedAt?: string;
}

/**
 * A journal row plus the completion timestamp.
 *
 * The scraper records `durationMs` but not when a product finished — it has no
 * reason to. The dashboard stamps it on arrival so date filters and
 * products-per-hour have something real to work with. Extra fields are ignored
 * by the CLI, so the file stays readable by both.
 */
export type JournalRow = ScrapeResult & { finishedAt?: string };

/** One product in the queue: its input, and its outcome once it has one. */
export interface JobRow {
  index: number;
  key: string;
  sku: string;
  fsn: string;
  targetSeller: string;
  productUrl: string;
  status: RowStatus;
  result?: JournalRow;
  durationMs?: number;
  attempts?: number;
  message?: string;
  finishedAt?: string;
  /** Per-product settlement inputs, carried straight through from the inputs file. */
  currentBankSettlement?: number;
  bankSettlementThreshold?: number;
  /** Flipkart's Benchmark Price for this listing. 0 means "no benchmark published". */
  benchmarkPrice?: number;
  /** System stock count, so a zero-order day can be blamed on the shelf, not the price. */
  stockCount?: number;
  /** The sheet's "Your Listing Price", carried through for the recommendation view. */
  listingPrice?: number;
  /** Lowest Listing File value for this FSN. */
  lowestListingFile?: number;
}

/* ------------------------------------------------------------------- stats */

export interface JobStats {
  total: number;
  pending: number;
  running: number;
  completed: number;
  succeeded: number;
  failed: number;
  /** Percentage of *finished* rows that succeeded. Null before anything finishes. */
  successRate: number | null;
  /** Mean duration of finished rows, ms. Null before anything finishes. */
  averageMs: number | null;
  /** Wall-clock projection for the remaining queue, ms. Null when not derivable. */
  estimatedRemainingMs: number | null;
  queueLength: number;
}

/* -------------------------------------------------------------------- live */

/** What the runner is doing right now. Absent when nothing is running. */
export interface LiveProgress {
  jobId: string;
  /** Which worker owns this product. 0 when running sequentially. */
  workerId: number;
  rowIndex: number;
  sku: string;
  fsn: string;
  targetSeller: string;
  productUrl: string;
  step: ScrapeStep;
  startedAt: string;
  browserStatus: 'idle' | 'launching' | 'scraping' | 'backing-off' | 'closing';
}

/* -------------------------------------------------------------------- logs */

/**
 * Severity of a worker log line.
 *
 * Still used by the scraper's log sink, which the worker prints to stdout so
 * the lines land in the GitHub Actions console. They are no longer persisted:
 * there is no job_logs table and no Logs tab. What survives a run is the
 * per-product `status` and `message` on each result row, which is where the
 * diagnosis actually lived.
 */
export type LogLevel = 'step' | 'info' | 'warn' | 'error';

/*
 * There is no JobEvent union any more.
 *
 * It described the frames of an in-process SSE bus that only worked while the
 * scraper and the dashboard shared a Node process. The browser now subscribes
 * to Supabase Realtime on `jobs` and `job_results` directly, so the wire format
 * is the table row — see hooks/useJobStream.ts.
 */
