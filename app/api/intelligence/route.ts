/**
 * GET /api/intelligence?account=Previx
 *   → the per-FSN leaderboard: top rule, accuracy, average error, times used.
 *
 * GET /api/intelligence?account=Previx&fsn=ABC123
 *   → one FSN in full: ranking, formulas, and the accuracy chart series.
 *
 * GET /api/intelligence?account=Previx&view=formulas
 *   → the formula repository, one row per generated formula.
 *
 * POST /api/intelligence  { account }
 *   → drop the account's learning and replay it from the retained batches.
 */

import { NextResponse } from 'next/server';
import { deriveMetrics, emptyStats } from '@/lib/intelligence/metrics';
import { labelFor } from '@/lib/intelligence/predictors';
import {
  allRecords,
  countRecords,
  leaderboard,
  readRecord,
  resetAccount,
  syncAccount,
} from '@/lib/intelligence/store';
import { DEFAULT_INTELLIGENCE_CONFIG, type FsnIntelligence } from '@/lib/intelligence/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const config = DEFAULT_INTELLIGENCE_CONFIG;

/** The row the leaderboard shows — the "output per FSN" of the specification. */
function summarize(record: FsnIntelligence) {
  const top = record.ranking[0] ?? null;
  const activeFormula = record.formulas.find((formula) => formula.status === 'active');

  return {
    fsn: record.fsn,
    topRule: top?.label ?? null,
    topRuleId: top?.id ?? null,
    accuracyPct: top?.accuracyPct ?? null,
    averageError: top?.mae ?? null,
    timesUsed: top?.timesSelected ?? 0,
    lastUsedAt: top?.lastUsedAt ?? null,
    generatedFormula: activeFormula?.expression ?? null,
    reason: top?.reason ?? 'No scored predictions yet.',
    secondBest: record.ranking[1]?.label ?? null,
    thirdBest: record.ranking[2]?.label ?? null,
    observations: record.observations.length,
    scoredPredictions: top?.n ?? 0,
    champion: record.champion,
    updatedAt: record.updatedAt,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const account = url.searchParams.get('account')?.trim();
  if (!account) return NextResponse.json({ error: 'account is required.' }, { status: 400 });

  try {
    // Cheap when there is nothing new — it only folds in batches it has not
    // already recorded in intelligence_processed_jobs.
    await syncAccount(account, config);

    const fsn = url.searchParams.get('fsn')?.trim();

    if (fsn) {
      const record = await readRecord(account, fsn);
      if (!record) return NextResponse.json({ error: 'No intelligence for that FSN.' }, { status: 404 });

      return NextResponse.json({
        fsn: record.fsn,
        accountName: record.accountName,
        champion: record.champion,
        summary: summarize(record),
        // Every predictor with a track record, not just the podium — the whole
        // point is being able to see what the bench is doing.
        predictors: Object.values(record.stats)
          .map((stats) => ({
            ...deriveMetrics(stats, config),
            label: labelFor(stats.id, record.formulas),
            kind: stats.id.startsWith('fit:') ? 'formula' : 'rule',
          }))
          .sort((left, right) => right.score - left.score),
        ranking: record.ranking,
        formulas: record.formulas,
        observations: record.observations,
        /** Historical performance graph data: one point per scored upload. */
        performance: record.performance,
        pending: record.pending,
      });
    }

    if (url.searchParams.get('view') === 'formulas') {
      // The one view that genuinely needs every record: a formula lives inside
      // its FSN's blob, so there is nothing to filter on until it is unpacked.
      const records = await allRecords(account);
      const repository = records.flatMap((record) =>
        record.formulas.map((formula) => {
          const metrics = deriveMetrics(record.stats[formula.id] ?? emptyStats(formula.id), config);
          return {
            fsn: record.fsn,
            ruleName: formula.id,
            kind: formula.kind,
            formula: formula.expression,
            createdDate: formula.createdAt,
            lastUpdated: formula.updatedAt,
            accuracyPct: metrics.accuracyPct,
            validationMae: formula.validationMae,
            executionCount: metrics.n,
            averageError: metrics.mae,
            status: formula.status,
          };
        }),
      );

      return NextResponse.json({ account, total: repository.length, formulas: repository });
    }

    // Ordered and limited in SQL against the denormalised accuracy_pct column.
    // This used to read every shard, map, sort and slice, so asking for the top
    // 500 of 20,000 FSNs cost exactly as much as asking for all of them.
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 500) || 500, 5_000);
    const [records, total] = await Promise.all([leaderboard(account, limit), countRecords(account)]);

    return NextResponse.json({ account, total, rows: records.map(summarize) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not read intelligence.' },
      { status: 500 },
    );
  }
}

/**
 * Rebuild an account's learning from scratch.
 *
 * Destructive, and now lossy in a way it did not used to be. Every batch on
 * disk could once be replayed; retention prunes batches beyond the newest 30
 * per account, so anything learned from a pruned batch cannot be recovered by
 * replaying. The response says how many batches the rebuild actually had.
 */
export async function POST(request: Request) {
  let body: { account?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const account = body.account?.trim();
  if (!account) return NextResponse.json({ error: 'account is required.' }, { status: 400 });

  try {
    await resetAccount(account);
    const report = await syncAccount(account, config);

    return NextResponse.json({
      rebuilt: true,
      account,
      jobs: report.processedCount,
      fsns: report.fsnCount,
      note:
        'Rebuilt from the batches still retained. Anything learned from batches that have since ' +
        'been pruned is not recoverable this way.',
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not rebuild intelligence.' },
      { status: 500 },
    );
  }
}
