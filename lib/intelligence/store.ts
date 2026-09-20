/**
 * Persistence for the per-FSN intelligence.
 *
 * This was 32 JSON shards per account on disk. The sharding existed to answer
 * "read and rewrite a few hundred FSNs out of possibly tens of thousands"
 * without rewriting megabytes — which is a problem a table with a primary key
 * does not have. So it is one row per `(account_slug, fsn)` now, and the shard
 * arithmetic is gone.
 *
 * The bigger change is what this data *is*. It used to be derived: delete the
 * directory and the next sync rebuilt it by replaying every job folder. That
 * stops being true the moment batches are pruned (0005_retention.sql), because
 * after a prune there is no journal left to replay. `fsn_intelligence` is
 * therefore authoritative, has no foreign key to `jobs`, and is never cascaded.
 * `resetAccount` still exists but is now a destructive, explicit action that
 * can only rebuild from batches that are still retained.
 *
 * The engine itself (engine.ts, formulas.ts, metrics.ts) is untouched: records
 * are loaded, mutated in memory exactly as before, then written back.
 */

import { computeSettlement } from '@/lib/settlement';
import { getAllRows, listJobs, sameAccount } from '@/lib/store/jobStore';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { FsnIntelligenceDb } from '@/lib/supabase/types';
import { processObservation, type UploadDecision } from './engine';
import {
  DEFAULT_INTELLIGENCE_CONFIG,
  emptyIntelligence,
  type FsnIntelligence,
  type IntelligenceConfig,
  type Observation,
} from './types';

/** How many FSNs to read back or write in one request. */
const CHUNK = 500;

/**
 * A stable key for an account.
 *
 * Normalised the same way account matching is, so "Shoppping Dil Se" and
 * "ShopppingDilSe" share one store rather than quietly keeping two histories.
 * It named a directory before; it is a primary key column now, and it must not
 * change meaning — the records are keyed on it.
 */
export function accountSlug(accountName: string): string {
  const normalized = accountName.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return normalized || 'unassigned';
}

function toRow(slug: string, accountName: string, record: FsnIntelligence): FsnIntelligenceDb {
  const top = record.ranking[0] ?? null;

  return {
    account_slug: slug,
    fsn: record.fsn,
    account_name: accountName,
    record,
    // Denormalised so the leaderboard is an ORDER BY instead of loading every
    // record into Node and sorting there, which is what the old route did.
    champion: record.champion,
    accuracy_pct: top?.accuracyPct ?? null,
    average_error: top?.mae ?? null,
    observations_count: record.observations.length,
    updated_at: record.updatedAt,
  };
}

function fromRow(row: FsnIntelligenceDb): FsnIntelligence {
  return row.record as FsnIntelligence;
}

/* ----------------------------------------------------------------- reads */

export async function readRecord(accountName: string, fsn: string): Promise<FsnIntelligence | null> {
  const { data, error } = await supabaseAdmin()
    .from('fsn_intelligence')
    .select('*')
    .eq('account_slug', accountSlug(accountName))
    .eq('fsn', fsn)
    .maybeSingle();

  if (error || !data) return null;
  return fromRow(data as FsnIntelligenceDb);
}

/**
 * Every FSN this account has learned about, best first.
 *
 * `limit` is applied in SQL. The old version read all 32 shards into memory,
 * mapped, sorted and sliced — so asking for the top 500 of 20,000 FSNs cost the
 * same as asking for all of them.
 */
export async function leaderboard(accountName: string, limit = 500): Promise<FsnIntelligence[]> {
  const { data, error } = await supabaseAdmin()
    .from('fsn_intelligence')
    .select('*')
    .eq('account_slug', accountSlug(accountName))
    .order('accuracy_pct', { ascending: false, nullsFirst: false })
    .limit(Math.min(Math.max(limit, 1), 5_000));

  if (error || !data) return [];
  return (data as FsnIntelligenceDb[]).map(fromRow);
}

/** Everything, paged through. Used by the formula repository view. */
export async function allRecords(accountName: string): Promise<FsnIntelligence[]> {
  const db = supabaseAdmin();
  const slug = accountSlug(accountName);
  const records: FsnIntelligence[] = [];

  for (let offset = 0; ; offset += CHUNK) {
    const { data, error } = await db
      .from('fsn_intelligence')
      .select('*')
      .eq('account_slug', slug)
      .order('fsn', { ascending: true })
      .range(offset, offset + CHUNK - 1);

    if (error) throw new Error(`Could not read intelligence: ${error.message}`);

    const batch = (data ?? []) as FsnIntelligenceDb[];
    records.push(...batch.map(fromRow));
    if (batch.length < CHUNK) break;
  }

  return records;
}

export async function countRecords(accountName: string): Promise<number> {
  const { count } = await supabaseAdmin()
    .from('fsn_intelligence')
    .select('fsn', { count: 'exact', head: true })
    .eq('account_slug', accountSlug(accountName));

  return count ?? 0;
}

export async function processedJobIds(accountName: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin()
    .from('intelligence_processed_jobs')
    .select('job_id')
    .eq('account_slug', accountSlug(accountName));

  if (error || !data) return [];
  return (data as { job_id: string }[]).map((row) => row.job_id);
}

/* ---------------------------------------------------------------- ingest */

export interface SyncReport {
  accountName: string;
  accountSlug: string;
  /** Batches folded in during *this* call. Empty when there was nothing new. */
  newlyProcessed: string[];
  processedCount: number;
  fsnCount: number;
  decisions: Map<string, Map<string, UploadDecision>>;
}

/**
 * Fold every upload this account has, in chronological order, into the store.
 *
 * Ordering is not a detail: a formula fitted on uploads 1–4 must be scored
 * against upload 5, never the reverse. Replaying out of order would produce a
 * different — and wrong — set of coefficients.
 *
 * Already-processed batches are skipped, so this is safe to call on every run
 * and cheap when there is nothing new. `intelligence_processed_jobs` is the
 * guard, and it deliberately has no foreign key to `jobs`: once a batch has
 * been folded in, pruning it must not make the store willing to add it again.
 */
export async function syncAccount(
  accountName: string,
  config: IntelligenceConfig = DEFAULT_INTELLIGENCE_CONFIG,
): Promise<SyncReport> {
  const db = supabaseAdmin();
  const slug = accountSlug(accountName);

  const processed = new Set(await processedJobIds(accountName));

  const jobs = (await listJobs())
    .filter((manifest) => sameAccount(manifest.accountName, accountName))
    .sort((left, right) =>
      (left.uploadTime ?? left.createdAt).localeCompare(right.uploadTime ?? right.createdAt),
    );

  const decisions = new Map<string, Map<string, UploadDecision>>();
  const newlyProcessed: string[] = [];

  for (const manifest of jobs) {
    if (processed.has(manifest.id)) continue;

    const uploadTime = manifest.uploadTime ?? manifest.createdAt;
    const rows = await getAllRows(manifest.id, { status: ['success'] });

    // One upload can legitimately list the same FSN under two SKUs; the first
    // one wins so a single upload contributes a single observation.
    const observations = new Map<string, Observation>();
    for (const row of rows) {
      if (!row.result || row.result.status !== 'OK' || observations.has(row.fsn)) continue;

      const settlement = computeSettlement(row);
      if (settlement.sellerPrice === null || settlement.currentPrice === null) continue;

      observations.set(row.fsn, {
        jobId: manifest.id,
        t: uploadTime,
        myPrice: settlement.sellerPrice,
        winnerPrice: settlement.currentPrice,
        hasBuybox: settlement.hasBuybox,
        currentSettlement: settlement.currentBankSettlement,
        minSettlement: settlement.bankSettlementThreshold,
      });
    }

    const fsns = [...observations.keys()];
    const existing = await loadRecords(slug, fsns);
    const perFsn = new Map<string, UploadDecision>();
    const touched: FsnIntelligence[] = [];

    for (const [fsn, observation] of observations) {
      const record = existing.get(fsn) ?? emptyIntelligence(fsn, accountName);
      perFsn.set(fsn, processObservation(record, observation, config));
      touched.push(record);
    }

    await writeRecords(slug, accountName, touched);

    // The marker goes in only after the records are written. Reversing the two
    // would let a failure halfway through mark a batch as folded in when it was
    // not, and the observations it carried could never be recovered.
    const { error } = await db
      .from('intelligence_processed_jobs')
      .upsert({ account_slug: slug, job_id: manifest.id }, { onConflict: 'account_slug,job_id' });

    if (error) throw new Error(`Could not record intelligence progress: ${error.message}`);

    processed.add(manifest.id);
    newlyProcessed.push(manifest.id);
    decisions.set(manifest.id, perFsn);
  }

  return {
    accountName,
    accountSlug: slug,
    newlyProcessed,
    processedCount: processed.size,
    fsnCount: await countRecords(accountName),
    decisions,
  };
}

async function loadRecords(slug: string, fsns: string[]): Promise<Map<string, FsnIntelligence>> {
  const db = supabaseAdmin();
  const found = new Map<string, FsnIntelligence>();

  for (let start = 0; start < fsns.length; start += CHUNK) {
    const chunk = fsns.slice(start, start + CHUNK);
    const { data, error } = await db
      .from('fsn_intelligence')
      .select('*')
      .eq('account_slug', slug)
      .in('fsn', chunk);

    if (error) throw new Error(`Could not read intelligence: ${error.message}`);
    for (const row of (data ?? []) as FsnIntelligenceDb[]) found.set(row.fsn, fromRow(row));
  }

  return found;
}

async function writeRecords(
  slug: string,
  accountName: string,
  records: FsnIntelligence[],
): Promise<void> {
  if (records.length === 0) return;

  const db = supabaseAdmin();

  for (let start = 0; start < records.length; start += CHUNK) {
    const chunk = records.slice(start, start + CHUNK).map((record) => toRow(slug, accountName, record));
    const { error } = await db
      .from('fsn_intelligence')
      .upsert(chunk, { onConflict: 'account_slug,fsn' });

    if (error) throw new Error(`Could not save intelligence: ${error.message}`);
  }
}

/* ----------------------------------------------------------------- reset */

/**
 * Throw the account's learning away so the next sync rebuilds it.
 *
 * Destructive, and no longer free. The accumulators are running sums that
 * cannot be un-added, so this used to be the honest response to history
 * changing shape — a batch deleted, rows re-scraped — because the whole store
 * could be regenerated from the job folders.
 *
 * Under retention it can only replay the batches still retained. Everything
 * learned from a pruned batch is gone for good. That is why deleting a batch no
 * longer calls this: it is now an explicit action a person takes, with the
 * consequence stated, rather than a side effect of tidying up.
 */
export async function resetAccount(accountName: string): Promise<void> {
  const db = supabaseAdmin();
  const slug = accountSlug(accountName);

  const { error } = await db.from('fsn_intelligence').delete().eq('account_slug', slug);
  if (error) throw new Error(`Could not reset intelligence: ${error.message}`);

  const { error: markerError } = await db
    .from('intelligence_processed_jobs')
    .delete()
    .eq('account_slug', slug);

  if (markerError) throw new Error(`Could not reset intelligence progress: ${markerError.message}`);
}
