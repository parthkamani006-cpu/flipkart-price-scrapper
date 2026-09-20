/**
 * GET  /api/jobs/:jobId/recommendations — the saved recommendations.
 * POST /api/jobs/:jobId/recommendations — regenerate them from the current data.
 *
 * GET never re-decides anything: it returns the rows written when the run
 * ended, and only generates when the batch has none at all. Regenerating is an
 * explicit action, because a recommendation the user has already acted on
 * should not change under them.
 */

import { NextResponse } from 'next/server';
import { ensureRecommendations, generateRecommendations } from '@/lib/services/recommendations';
import { getJob } from '@/lib/store/jobStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { jobId } = await params;
  const manifest = await getJob(jobId);
  if (!manifest) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  try {
    const recommendations = await ensureRecommendations(jobId);
    if (!recommendations) {
      return NextResponse.json({ error: 'Could not read recommendations for this job.' }, { status: 500 });
    }
    return NextResponse.json({ job: manifest, recommendations });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not read recommendations for this job.' },
      { status: 500 },
    );
  }
}

export async function POST(_request: Request, { params }: Context) {
  const { jobId } = await params;
  const manifest = await getJob(jobId);
  if (!manifest) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });

  try {
    const recommendations = await generateRecommendations(jobId);
    if (!recommendations) {
      return NextResponse.json({ error: 'Could not generate recommendations.' }, { status: 500 });
    }
    return NextResponse.json({ job: manifest, recommendations });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not generate recommendations.' },
      { status: 500 },
    );
  }
}
