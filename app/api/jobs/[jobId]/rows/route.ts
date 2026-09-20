/**
 * GET /api/jobs/:jobId/rows — the queue, filtered and paginated.
 *
 * Filtering, counting and paging all happen in Postgres. The previous version
 * did say "server-side", and it was — but server-side meant a JS `.filter()`
 * over every row of the batch, which had to be materialised first. Now a
 * thousand-row batch answers a filtered request by touching the rows that match.
 */

import { NextResponse } from 'next/server';
import { getRows } from '@/lib/store/jobStore';
import { parseRowFilters } from '@/lib/services/rowFilters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { jobId } = await params;
  const url = new URL(request.url);

  const filters = parseRowFilters(url.searchParams);
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
  const limit = Math.min(5_000, Math.max(1, Number(url.searchParams.get('limit') ?? 500) || 500));

  try {
    // An empty list is legitimate for a job that has not started, so no 404 here.
    const page = await getRows(jobId, filters, { offset, limit });
    return NextResponse.json(page);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not read the queue.' },
      { status: 500 },
    );
  }
}
