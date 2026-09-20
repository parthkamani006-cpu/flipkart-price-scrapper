/**
 * GET /api/accounts — the Flipkart accounts that have uploads.
 *
 * Derived from the batches, so there is no account registry to keep in step
 * with them. A brand-new account simply gets typed on the upload screen and
 * appears here once its first batch exists.
 */

import { NextResponse } from 'next/server';
import { listAccounts } from '@/lib/store/jobStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ accounts: await listAccounts() });
}
