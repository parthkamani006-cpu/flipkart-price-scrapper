/**
 * Job store, backed by Postgres.
 *
 * This used to be NDJSON on disk indexed in memory, which worked precisely
 * because one process owned both the scraper and the dashboard. It no longer
 * does: the scraper runs in GitHub Actions and the dashboard on Vercel, so the
 * two share nothing but the database. Supabase is therefore the record of
 * truth, and there is no cache here at all — a cached row would be a claim
 * about a process this one cannot see.
 *
 * Everything is async, and everything that filters, sorts, counts or paginates
 * does so in SQL. The old module answered those questions by materialising the
 * whole batch; a serverless function has no reason to.
 *
 * Writes go through the service-role client, so this module is server-only.
 */

import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  inputToColumns,
  manifestPatchToColumns,
  resultToColumns,
  toJobRow,
  toManifest,
  toScrapeInput,
} from '@/lib/store/mappers';
import { EMPTY_STATS, statsFromView } from '@/lib/store/stats';
import { assertJobId, newJobId } from '@/lib/store/ids';
import { applyRowFilters, type RowFilters } from '@/lib/services/rowFilters';
import { sellerNamesMatch } from '@/scraper/parser';
import type { OrdersReport } from '@/lib/demand';
import type { ScrapeInput, ScrapeResult } from '@/scraper/types';
import { DEFAULT_JOB_OPTIONS } from '@/types/dashboard';
import type {
  JobManifest,
  JobOptions,
  JobRow,
  JobState,
  JobStats,
  JournalRow,
  LiveProgress,
} from '@/types/dashboard';
import type {
  JobInputDb,
  JobRowDb,
  JobRowViewDb,
  JobStatsViewDb,
  RequestedAction,
} from '@/lib/supabase/types';

/**
 * PostgREST returns at most a page at a time, and a batch is routinely a
 * thousand rows. Anything that genuinely needs every row (export, analytics,
 * recommendations, the worker's pending list) pages through in these chunks.
 */
const PAGE_SIZE = 1_000;

/* ------------------------------------------------------------------ create */

export async function createJob(
  name: string,
  inputs: ScrapeInput[],
  options: JobOptions,
  accountName?: string,
  /** Per-FSN demand from the orders report, when one was uploaded with the batch. */
  orders?: OrdersReport | null,
): Promise<JobManifest> {
  const db = supabaseAdmin();
  const id = newJobId();
  const createdAt = new Date().toISOString();

  const { data, error } = await db
    .from('jobs')
    .insert({
      id,
      name,
      // The account is the seller name every row carries, so the rows are the
      // fallback when the caller does not name it explicitly.
      account_name: (accountName ?? inputs[0]?.targetSeller ?? '').trim(),
      state: 'queued',
      requested_action: 'RUN',
      total: inputs.length,
      options,
      created_at: createdAt,
      upload_time: createdAt,
      orders_window: orders
        ? {
            start: orders.windowStart,
            end: orders.windowEnd,
            last24hStart: orders.last24hStart,
            observedDays: orders.observedDays,
            orderItems: orders.totalOrderItems,
            units: orders.totalUnits,
            fsnCount: orders.fsnCount,
          }
        : null,
    })
    .select('*')
    .single();

  if (error) throw new Error(`Could not create the batch: ${error.message}`);

  // Inputs in chunks: a 1000-row spreadsheet in one INSERT is a large request
  // body, and a partial failure mid-way is easier to reason about per chunk.
  for (let start = 0; start < inputs.length; start += PAGE_SIZE) {
    const chunk = inputs
      .slice(start, start + PAGE_SIZE)
      .map((input, offset) => inputToColumns(id, input, start + offset));

    const { error: inputError } = await db.from('job_inputs').insert(chunk);
    if (inputError) {
      // Leaving a job row with half its inputs would show the user a batch that
      // silently scrapes the wrong number of products. Cascade takes the rest.
      await db.from('jobs').delete().eq('id', id);
      throw new Error(`Could not save the uploaded rows: ${inputError.message}`);
    }
  }

  return toManifest(data as JobRowDb);
}

/* ---------------------------------------------------------------- reading */

/**
 * The batch manifest, or null when there is no such batch.
 *
 * The filesystem version returned a record carrying the manifest, the inputs
 * and every row joined together, because it had just read all of that off disk
 * anyway. Here those are three different queries with three different costs, so
 * callers ask for what they need: `getRows`, `getAllRows`, `pendingInputs`.
 */
export async function getJob(jobId: string): Promise<JobManifest | null> {
  if (!isValidId(jobId)) return null;

  const { data, error } = await supabaseAdmin().from('jobs').select('*').eq('id', jobId).maybeSingle();
  if (error || !data) return null;

  return toManifest(data as JobRowDb);
}

/** The raw job row, including the control and lease columns the manifest hides. */
export async function getJobRow(jobId: string): Promise<JobRowDb | null> {
  if (!isValidId(jobId)) return null;

  const { data, error } = await supabaseAdmin().from('jobs').select('*').eq('id', jobId).maybeSingle();
  if (error || !data) return null;

  return data as JobRowDb;
}

export async function listJobs(): Promise<JobManifest[]> {
  const { data, error } = await supabaseAdmin()
    .from('jobs')
    .select('*')
    .order('created_at', { ascending: false });

  if (error || !data) return [];
  return (data as JobRowDb[]).map(toManifest);
}

/**
 * Every batch with its counts, in one round trip plus one.
 *
 * The old dashboard list called computeStats() once per job, and each of those
 * calls re-read that job's whole journal — an N+1 that grew with both the
 * number of batches and their size. job_stats_v aggregates all of them at once.
 */
export async function listJobsWithStats(): Promise<(JobManifest & { stats: JobStats })[]> {
  const db = supabaseAdmin();

  const [jobsResult, statsResult] = await Promise.all([
    db.from('jobs').select('*').order('created_at', { ascending: false }),
    db.from('job_stats_v').select('*'),
  ]);

  if (jobsResult.error || !jobsResult.data) return [];

  const statsById = new Map<string, JobStatsViewDb>(
    ((statsResult.data ?? []) as JobStatsViewDb[]).map((row) => [row.job_id, row]),
  );

  return (jobsResult.data as JobRowDb[]).map((row) => {
    const manifest = toManifest(row);
    return { ...manifest, stats: statsFromView(statsById.get(row.id), manifest.options) };
  });
}

export async function computeStats(jobId: string): Promise<JobStats> {
  if (!isValidId(jobId)) return EMPTY_STATS;

  const db = supabaseAdmin();
  const [statsResult, jobResult] = await Promise.all([
    db.from('job_stats_v').select('*').eq('job_id', jobId).maybeSingle(),
    db.from('jobs').select('options').eq('id', jobId).maybeSingle(),
  ]);

  const options = {
    ...DEFAULT_JOB_OPTIONS,
    ...((jobResult.data?.options as JobOptions | undefined) ?? {}),
  };

  return statsFromView(statsResult.data as JobStatsViewDb | null, options);
}

/**
 * Two account names are the same account when the scraper's own matcher says
 * so, which is what makes "Shoppping Dil Se" and "ShopppingDilSe" one history
 * rather than two.
 */
export function sameAccount(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return sellerNamesMatch(left, right);
}

export interface AccountSummary {
  name: string;
  uploads: number;
  lastUploadAt: string;
}

/**
 * The accounts that have uploads, newest first.
 *
 * Still derived from the batches rather than kept in a separate registry — one
 * fewer thing to keep in step, and deleting the last batch for an account
 * removes the account with it. The grouping stays in JS because it uses the
 * scraper's fuzzy name matcher, not string equality.
 */
export async function listAccounts(): Promise<AccountSummary[]> {
  const { data, error } = await supabaseAdmin()
    .from('jobs')
    .select('account_name, upload_time, created_at')
    .order('created_at', { ascending: false });

  if (error || !data) return [];

  const accounts: AccountSummary[] = [];

  for (const row of data as { account_name: string; upload_time: string | null; created_at: string }[]) {
    const name = row.account_name?.trim();
    if (!name) continue;

    const uploadedAt = new Date(row.upload_time ?? row.created_at).toISOString();
    const existing = accounts.find((account) => sameAccount(account.name, name));

    if (existing) {
      existing.uploads += 1;
      if (uploadedAt > existing.lastUploadAt) existing.lastUploadAt = uploadedAt;
      continue;
    }

    accounts.push({ name, uploads: 1, lastUploadAt: uploadedAt });
  }

  return accounts.sort((a, b) => b.lastUploadAt.localeCompare(a.lastUploadAt));
}

/* --------------------------------------------------------------- mutation */

export async function deleteJob(jobId: string): Promise<boolean> {
  if (!isValidId(jobId)) return false;

  // Inputs, results and recommendations go with it: every child table declares
  // `on delete cascade`. fsn_intelligence deliberately does not.
  const { data, error } = await supabaseAdmin().from('jobs').delete().eq('id', jobId).select('id');
  if (error) throw new Error(`Could not delete the batch: ${error.message}`);

  return (data?.length ?? 0) > 0;
}

/** Patch the batch row. The one place the manifest columns are edited. */
export async function updateManifest(
  jobId: string,
  patch: Partial<JobManifest>,
): Promise<JobManifest | null> {
  if (!isValidId(jobId)) return null;

  const columns = manifestPatchToColumns(patch);
  if (Object.keys(columns).length === 0) return getJob(jobId);

  const { data, error } = await supabaseAdmin()
    .from('jobs')
    .update(columns)
    .eq('id', jobId)
    .select('*')
    .maybeSingle();

  if (error || !data) return null;
  return toManifest(data as JobRowDb);
}

export async function setJobState(
  jobId: string,
  state: JobState,
  extra: Partial<JobManifest> = {},
): Promise<JobManifest | null> {
  return updateManifest(jobId, { ...extra, state });
}

/**
 * Record what the user last asked for.
 *
 * Separate from `state` on purpose: the worker is in another process on another
 * machine, so a Pause is a request that becomes true when the worker next looks,
 * not an instruction that takes effect on return. The dashboard shows the
 * transient `pausing` / `stopping` states for exactly that gap.
 */
export async function setRequestedAction(
  jobId: string,
  action: RequestedAction,
  extra: Partial<JobManifest> = {},
): Promise<JobManifest | null> {
  if (!isValidId(jobId)) return null;

  const { data, error } = await supabaseAdmin()
    .from('jobs')
    .update({ ...manifestPatchToColumns(extra), requested_action: action })
    .eq('id', jobId)
    .select('*')
    .maybeSingle();

  if (error || !data) return null;
  return toManifest(data as JobRowDb);
}

/**
 * Persist one finished product.
 *
 * `idx` is the row's position in the upload, which is what the database keys
 * on. The old store matched on a NUL-joined `sku + productUrl` string because
 * a journal line carried no position; a database row does, so the join is now
 * an integer and cannot collide.
 *
 * Upsert rather than insert: a worker that is re-run after an interrupted
 * batch may legitimately re-report a product whose write landed but whose
 * acknowledgement did not.
 */
export async function recordResult(jobId: string, idx: number, result: ScrapeResult): Promise<JournalRow> {
  const stamped: JournalRow = { ...result, finishedAt: new Date().toISOString() };

  const { error } = await supabaseAdmin()
    .from('job_results')
    .upsert(resultToColumns(jobId, idx, stamped), { onConflict: 'job_id,idx' });

  if (error) throw new Error(`Could not save the result for row ${idx}: ${error.message}`);
  return stamped;
}

/** Overwrite the live progress snapshot the dashboard renders from. */
export async function setProgress(jobId: string, progress: LiveProgress[]): Promise<void> {
  await supabaseAdmin().from('jobs').update({ progress }).eq('id', jobId);
}

/* ----------------------------------------------------------------- queries */

export interface RowPage {
  rows: JobRow[];
  /** Every row in the batch, before filtering. */
  total: number;
  /** Rows the filters matched, before paging. */
  matched: number;
  offset: number;
  limit: number;
}

/**
 * A page of the queue, filtered and counted in SQL.
 *
 * Ordered by `idx`, which is upload order — the same order the array version
 * returned, and the order the queue table and the exports assume.
 */
export async function getRows(
  jobId: string,
  filters: RowFilters = {},
  page: { offset?: number; limit?: number } = {},
): Promise<RowPage> {
  const offset = Math.max(0, page.offset ?? 0);
  const limit = Math.min(5_000, Math.max(1, page.limit ?? 500));

  if (!isValidId(jobId)) return { rows: [], total: 0, matched: 0, offset, limit };

  const db = supabaseAdmin();

  const totalPromise = db
    .from('job_inputs')
    .select('idx', { count: 'exact', head: true })
    .eq('job_id', jobId);

  const filtered = applyRowFilters(
    db.from('job_rows_v').select('*', { count: 'exact' }).eq('job_id', jobId),
    filters,
  )
    .order('idx', { ascending: true })
    .range(offset, offset + limit - 1);

  const [totalResult, pageResult] = await Promise.all([totalPromise, filtered]);

  if (pageResult.error) {
    throw new Error(`Could not read the queue: ${pageResult.error.message}`);
  }

  return {
    rows: ((pageResult.data ?? []) as JobRowViewDb[]).map(toJobRow),
    total: totalResult.count ?? 0,
    matched: pageResult.count ?? 0,
    offset,
    limit,
  };
}

/**
 * Every matching row, paged through.
 *
 * For the callers that genuinely need the whole set — export, analytics'
 * fallback, recommendation generation. Kept explicit so it is obvious at the
 * call site that this one is not bounded by a page.
 */
export async function getAllRows(jobId: string, filters: RowFilters = {}): Promise<JobRow[]> {
  if (!isValidId(jobId)) return [];

  const db = supabaseAdmin();
  const rows: JobRow[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = applyRowFilters(db.from('job_rows_v').select('*').eq('job_id', jobId), filters)
      .order('idx', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    const { data, error } = await query;
    if (error) throw new Error(`Could not read the queue: ${error.message}`);

    const batch = (data ?? []) as JobRowViewDb[];
    rows.push(...batch.map(toJobRow));
    if (batch.length < PAGE_SIZE) break;
  }

  return rows;
}

/**
 * How many products still need scraping.
 *
 * A `head: true` count, so asking "is there anything left to do?" before
 * starting a run costs one number rather than the whole pending list.
 */
export async function countPending(jobId: string): Promise<number> {
  if (!isValidId(jobId)) return 0;

  const { count, error } = await supabaseAdmin()
    .from('job_rows_v')
    .select('idx', { count: 'exact', head: true })
    .eq('job_id', jobId)
    .eq('status', 'pending');

  if (error) throw new Error(`Could not count pending products: ${error.message}`);
  return count ?? 0;
}

export interface PendingInput {
  /** Position in the upload. The key every write goes back under. */
  idx: number;
  input: ScrapeInput;
}

/**
 * Inputs still needing a scrape, in queue order.
 *
 * The resume rule, unchanged in substance: a row is done when a result exists
 * for it, and a finished product is never re-scraped. What changed is that the
 * question is now a LEFT JOIN instead of a Map built from a journal file.
 */
export async function pendingInputs(jobId: string): Promise<PendingInput[]> {
  if (!isValidId(jobId)) return [];

  const db = supabaseAdmin();
  const pending: PendingInput[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db
      .from('job_rows_v')
      .select(
        'job_id, idx, sku, fsn, target_seller, product_url, current_bank_settlement, ' +
          'bank_settlement_threshold, benchmark_price, stock_count, listing_price, lowest_listing_file',
      )
      .eq('job_id', jobId)
      .eq('status', 'pending')
      .order('idx', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`Could not read the pending queue: ${error.message}`);

    const batch = (data ?? []) as unknown as JobInputDb[];
    for (const row of batch) pending.push({ idx: row.idx, input: toScrapeInput(row) });
    if (batch.length < PAGE_SIZE) break;
  }

  return pending;
}

/**
 * Drop BLOCKED results so a resumed run retries them.
 *
 * BLOCKED describes the bot wall, not the product, so it was never an answer.
 * This is the same rule the CLI's `--resume` applies when it heals a journal;
 * here it is a DELETE, and the LEFT JOIN in job_rows_v turns those rows back
 * into pending ones on its own.
 */
export async function prepareForRun(jobId: string): Promise<number> {
  if (!isValidId(jobId)) return 0;

  const { data, error } = await supabaseAdmin()
    .from('job_results')
    .delete()
    .eq('job_id', jobId)
    .eq('status', 'BLOCKED')
    .select('idx');

  if (error) throw new Error(`Could not prepare the batch for a run: ${error.message}`);
  return data?.length ?? 0;
}

/**
 * Send finished rows back to the queue.
 *
 * A row is "done" precisely because a result exists for it, so retrying means
 * deleting those results. One statement, so a crash halfway through it leaves
 * either all of them or none — the old version rewrote a whole file to achieve
 * roughly the same thing and admitted in its own comment that it was only
 * "atomic enough".
 */
export async function requeueRows(jobId: string, indexes: number[]): Promise<number> {
  if (!isValidId(jobId) || indexes.length === 0) return 0;

  const { data, error } = await supabaseAdmin()
    .from('job_results')
    .delete()
    .eq('job_id', jobId)
    .in('idx', indexes)
    .select('idx');

  if (error) throw new Error(`Could not requeue those rows: ${error.message}`);
  return data?.length ?? 0;
}

/* ---------------------------------------------------------------- helpers */

function isValidId(jobId: string): boolean {
  try {
    assertJobId(jobId);
    return true;
  } catch {
    return false;
  }
}
