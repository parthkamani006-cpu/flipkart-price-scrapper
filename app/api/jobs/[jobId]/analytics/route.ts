/** GET /api/jobs/:jobId/analytics — chart data for one batch. */

import { NextResponse } from 'next/server';
import { computeAnalytics } from '@/lib/services/analytics';
import { getJob } from '@/lib/store/jobStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { jobId } = await params;
  if (!(await getJob(jobId))) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  try {
    return NextResponse.json(await computeAnalytics(jobId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not compute analytics.' },
      { status: 500 },
    );
  }
}
