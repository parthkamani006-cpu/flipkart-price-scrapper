/**
 * GET /api/jobs/:jobId/export?format=csv|xlsx
 *
 * Accepts the same filter params as the rows endpoint, so "export" means
 * exactly what the user can see on screen rather than silently something else.
 *
 * Unlike the rows endpoint this one is not paginated — an export is the whole
 * match set by definition — so it pages through the query internally.
 */

import { NextResponse } from 'next/server';
import { csvStream, exportFilename, xlsxBuffer } from '@/lib/services/exportService';
import { parseRowFilters } from '@/lib/services/rowFilters';
import { getAllRows, getJob } from '@/lib/store/jobStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { jobId } = await params;
  const manifest = await getJob(jobId);
  if (!manifest) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  const url = new URL(request.url);
  const format = (url.searchParams.get('format') ?? 'csv').toLowerCase();

  if (format !== 'csv' && format !== 'xlsx') {
    return NextResponse.json({ error: 'format must be csv or xlsx.' }, { status: 400 });
  }

  const rows = await getAllRows(jobId, parseRowFilters(url.searchParams));

  if (format === 'csv') {
    return new Response(csvStream(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename(manifest, 'csv')}"`,
      },
    });
  }

  const buffer = await xlsxBuffer(manifest, rows);
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${exportFilename(manifest, 'xlsx')}"`,
      'Content-Length': String(buffer.length),
    },
  });
}
