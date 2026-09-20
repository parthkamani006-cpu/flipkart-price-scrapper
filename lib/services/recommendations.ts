/**
 * Pricing recommendations.
 *
 * These used to be a versioned JSON file per batch, and the version existed
 * because the file had to be discarded whenever the maths behind it changed —
 * a stale file would have shown a number the current code would never produce.
 *
 * They are rows now, so there is nothing to version: the shape is the table's,
 * and a schema change is a migration. What survives from the old design is the
 * rule that matters — a batch's recommendations are written once, when the run
 * ends, and viewing an old batch reads them back rather than re-deciding
 * anything. History must not move under the user.
 */

import { buildRecommendation, type Recommendation } from '@/lib/recommendation';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getAllRows, getJob, updateManifest } from '@/lib/store/jobStore';
import { recommendationToColumns, toRecommendation } from '@/lib/store/mappers';
import type { RecommendationDb } from '@/lib/supabase/types';

export interface RecommendationFile {
  jobId: string;
  jobName: string;
  accountName: string;
  generatedAt: string;
  summary: string;
  recommendations: Recommendation[];
}

const PAGE_SIZE = 1_000;

/** Rebuild from the batch's rows and replace whatever was stored. */
export async function generateRecommendations(jobId: string): Promise<RecommendationFile | null> {
  const manifest = await getJob(jobId);
  if (!manifest) return null;

  const rows = await getAllRows(jobId);
  const recommendations = rows.map(buildRecommendation);
  const generatedAt = new Date().toISOString();
  const summary = `${recommendations.length} FSNs`;

  const db = supabaseAdmin();

  // Delete-then-insert rather than upsert: a requeued row that has not been
  // re-scraped yet must lose its old recommendation, not keep it.
  const { error: clearError } = await db.from('recommendations').delete().eq('job_id', jobId);
  if (clearError) throw new Error(`Could not clear old recommendations: ${clearError.message}`);

  for (let start = 0; start < recommendations.length; start += PAGE_SIZE) {
    const chunk = recommendations
      .slice(start, start + PAGE_SIZE)
      .map((item) => recommendationToColumns(jobId, item));

    const { error } = await db.from('recommendations').insert(chunk);
    if (error) throw new Error(`Could not save recommendations: ${error.message}`);
  }

  await updateManifest(jobId, {
    recommendationSummary: summary,
    recommendationsGeneratedAt: generatedAt,
  });

  return {
    jobId,
    jobName: manifest.name,
    accountName: manifest.accountName ?? '',
    generatedAt,
    summary,
    recommendations,
  };
}

/** Read back what was stored, or null when the batch has none yet. */
export async function loadRecommendations(jobId: string): Promise<RecommendationFile | null> {
  const manifest = await getJob(jobId);
  if (!manifest) return null;

  const db = supabaseAdmin();
  const recommendations: Recommendation[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db
      .from('recommendations')
      .select('*')
      .eq('job_id', jobId)
      .order('idx', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`Could not read recommendations: ${error.message}`);

    const batch = (data ?? []) as RecommendationDb[];
    for (const row of batch) recommendations.push(toRecommendation(jobId, row));
    if (batch.length < PAGE_SIZE) break;
  }

  if (recommendations.length === 0) return null;

  return {
    jobId,
    jobName: manifest.name,
    accountName: manifest.accountName ?? '',
    generatedAt: manifest.recommendationsGeneratedAt ?? new Date().toISOString(),
    summary: manifest.recommendationSummary ?? `${recommendations.length} FSNs`,
    recommendations,
  };
}

/**
 * Read them, generating them first if the batch has none.
 *
 * The worker generates these when a run ends, so this only fires for a batch
 * whose run was interrupted before that point, or one whose rows were requeued
 * and re-scraped since. Both are a genuine "these do not exist yet", which is
 * why a GET is allowed to write here.
 */
export async function ensureRecommendations(jobId: string): Promise<RecommendationFile | null> {
  return (await loadRecommendations(jobId)) ?? (await generateRecommendations(jobId));
}
