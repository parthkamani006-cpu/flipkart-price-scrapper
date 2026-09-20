/**
 * Translation between the database's rows and the app's types.
 *
 * One file, so a column rename is one compile error rather than a shape that
 * quietly changes under a component. Nothing here talks to Supabase; it is pure
 * data shaping and is safe to unit-test.
 */

import { DEFAULT_JOB_OPTIONS } from '@/types/dashboard';
import type { JobManifest, JobRow, JournalRow, ScrapeInput } from '@/types/dashboard';
import type { Recommendation } from '@/lib/recommendation';
import type {
  JobInputDb,
  JobResultDb,
  JobRowDb,
  JobRowViewDb,
  RecommendationDb,
} from '@/lib/supabase/types';

/** Postgres `numeric` arrives as a string over PostgREST when it is wide enough. */
function num(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numOrNull(value: number | string | null | undefined): number | null {
  const parsed = num(value);
  return parsed === undefined ? null : parsed;
}

function iso(value: string | null | undefined): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

/* ------------------------------------------------------------------ jobs */

export function toManifest(row: JobRowDb): JobManifest {
  return {
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    state: row.state,
    total: row.total,
    // Merged the way the filesystem store merged it on hydration: a job created
    // before an option existed must not run with that option undefined.
    options: { ...DEFAULT_JOB_OPTIONS, ...(row.options ?? {}) },
    interruptedAt: iso(row.interrupted_at),
    accountName: row.account_name || undefined,
    uploadTime: iso(row.upload_time) ?? new Date(row.created_at).toISOString(),
    ordersWindow: row.orders_window ?? undefined,
    recommendationSummary: row.recommendation_summary ?? undefined,
    recommendationsGeneratedAt: iso(row.recommendations_generated_at),
  };
}

/** The manifest fields the API is allowed to patch, as database columns. */
export function manifestPatchToColumns(patch: Partial<JobManifest>): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if ('name' in patch) columns.name = patch.name;
  if ('state' in patch) columns.state = patch.state;
  if ('total' in patch) columns.total = patch.total;
  if ('options' in patch) columns.options = patch.options;
  if ('accountName' in patch) columns.account_name = patch.accountName ?? '';
  if ('uploadTime' in patch) columns.upload_time = patch.uploadTime ?? null;
  if ('startedAt' in patch) columns.started_at = patch.startedAt ?? null;
  if ('finishedAt' in patch) columns.finished_at = patch.finishedAt ?? null;
  if ('interruptedAt' in patch) columns.interrupted_at = patch.interruptedAt ?? null;
  if ('ordersWindow' in patch) columns.orders_window = patch.ordersWindow ?? null;
  if ('recommendationSummary' in patch) columns.recommendation_summary = patch.recommendationSummary ?? null;
  if ('recommendationsGeneratedAt' in patch) {
    columns.recommendations_generated_at = patch.recommendationsGeneratedAt ?? null;
  }
  return columns;
}

/* ---------------------------------------------------------------- inputs */

export function inputToColumns(jobId: string, input: ScrapeInput, idx: number): JobInputDb {
  return {
    job_id: jobId,
    idx,
    sku: input.sku,
    fsn: input.fsn,
    target_seller: input.targetSeller,
    product_url: input.productUrl,
    current_bank_settlement: numOrNull(input.currentBankSettlement),
    bank_settlement_threshold: numOrNull(input.bankSettlementThreshold),
    benchmark_price: numOrNull(input.benchmarkPrice),
    stock_count: numOrNull(input.stockCount),
    listing_price: numOrNull(input.listingPrice),
    lowest_listing_file: numOrNull(input.lowestListingFile),
  };
}

export function toScrapeInput(row: JobInputDb): ScrapeInput {
  return {
    productUrl: row.product_url,
    targetSeller: row.target_seller,
    sku: row.sku,
    fsn: row.fsn,
    currentBankSettlement: num(row.current_bank_settlement),
    bankSettlementThreshold: num(row.bank_settlement_threshold),
    benchmarkPrice: num(row.benchmark_price),
    stockCount: num(row.stock_count),
    listingPrice: num(row.listing_price),
    lowestListingFile: num(row.lowest_listing_file),
  };
}

/* --------------------------------------------------------------- results */

/**
 * A finished product, as columns.
 *
 * `screenshotPath` is dropped on purpose: the worker runs in GitHub Actions,
 * where the filesystem it would name disappears with the runner, so failure
 * screenshots are no longer captured at all.
 */
export function resultToColumns(jobId: string, idx: number, result: JournalRow): JobResultDb {
  return {
    job_id: jobId,
    idx,
    fsn: result.fsn,
    sku: result.sku,
    product_url: result.productUrl,
    seller_name: result.sellerName ?? null,
    buybox_seller_name: result.buyboxSellerName ?? null,
    main_listing_is_account_seller: result.mainListingIsAccountSeller ?? null,
    main_price: numOrNull(result.mainPrice),
    seller_price: numOrNull(result.sellerPrice),
    difference: numOrNull(result.difference),
    is_price_different: Boolean(result.isPriceDifferent),
    status: result.status,
    message: result.message ?? null,
    sellers_scanned: result.sellersScanned ?? null,
    show_more_clicks: result.showMoreClicks ?? null,
    source: result.source ?? null,
    duration_ms: result.durationMs ?? null,
    attempts: result.attempts ?? null,
    finished_at: result.finishedAt ?? new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ rows */

/**
 * One row of job_rows_v as the UI's JobRow.
 *
 * `key` used to be the journal's NUL-joined `sku \0 productUrl`. It is now
 * `<jobId>#<idx>`, which is what the database actually keys on — the old form
 * could collide whenever a SKU contained the separator. Nothing but React list
 * keys and log correlation ever read it.
 */
export function toJobRow(row: JobRowViewDb): JobRow {
  const result = (row.result ?? undefined) as JournalRow | undefined;

  return {
    index: row.idx,
    key: `${row.job_id}#${row.idx}`,
    sku: row.sku,
    fsn: row.fsn,
    targetSeller: row.target_seller,
    productUrl: row.product_url,
    status: row.status,
    result,
    durationMs: row.duration_ms ?? undefined,
    attempts: row.attempts ?? undefined,
    message: row.message ?? undefined,
    finishedAt: iso(row.finished_at),
    currentBankSettlement: num(row.current_bank_settlement),
    bankSettlementThreshold: num(row.bank_settlement_threshold),
    benchmarkPrice: num(row.benchmark_price),
    stockCount: num(row.stock_count),
    listingPrice: num(row.listing_price),
    lowestListingFile: num(row.lowest_listing_file),
  };
}

/* -------------------------------------------------------- recommendations */

export function recommendationToColumns(jobId: string, item: Recommendation): RecommendationDb {
  return {
    job_id: jobId,
    idx: item.index,
    sku: item.sku,
    fsn: item.fsn,
    diff_amount: numOrNull(item.diffAmount),
    status: item.status,
    final_bank_settlement: numOrNull(item.finalBankSettlement),
    reason: item.reason,
    generated_at: new Date().toISOString(),
  };
}

export function toRecommendation(jobId: string, row: RecommendationDb): Recommendation {
  return {
    key: `${jobId}#${row.idx}`,
    index: row.idx,
    sku: row.sku,
    fsn: row.fsn,
    diffAmount: numOrNull(row.diff_amount),
    status: row.status,
    finalBankSettlement: numOrNull(row.final_bank_settlement),
    reason: row.reason,
  };
}
