/**
 * GET /api/jobs/:jobId/recommendations/export?format=csv|xlsx
 *
 * Exports the first tab — Price change (Diff) — and nothing else.
 *
 * The docblock here used to promise an optional `search` that narrowed the file
 * to what the user had on screen. No such parameter was ever read, so the
 * promise is removed rather than left standing: the export is the whole set.
 */

import { NextResponse } from 'next/server';
import {
  exportFilename,
  recommendationCsvStream,
  recommendationXlsxBuffer,
} from '@/lib/services/exportService';
import { ensureRecommendations } from '@/lib/services/recommendations';
import { getJob } from '@/lib/store/jobStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { jobId } = await params;
  const manifest = await getJob(jobId);
  if (!manifest) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  const url = new URL(request.url);
  const format = (url.searchParams.get('format') ?? 'xlsx').toLowerCase();

  if (format !== 'csv' && format !== 'xlsx') {
    return NextResponse.json({ error: 'format must be csv or xlsx.' }, { status: 400 });
  }

  const file = await ensureRecommendations(jobId);
  if (!file) return NextResponse.json({ error: 'No recommendations for this job.' }, { status: 404 });

  if (format === 'csv') {
    return new Response(recommendationCsvStream(file.recommendations), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename(manifest, 'csv', 'price-change')}"`,
      },
    });
  }

  const buffer = await recommendationXlsxBuffer(manifest, file.recommendations, {
    accountName: file.accountName,
    generatedAt: file.generatedAt,
    summary: file.summary,
  });

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${exportFilename(manifest, 'xlsx', 'price-change')}"`,
      'Content-Length': String(buffer.length),
    },
  });
}
