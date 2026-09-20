/**
 * POST /api/upload — validate an uploaded spreadsheet file.
 *
 * Validation only; nothing is written. The user reviews the report and then
 * POSTs to /api/jobs to actually create the batch. Splitting the two means a
 * file with 40 duplicate rows never leaves a half-made job on disk.
 */

import { NextResponse } from 'next/server';
import { validateUpload } from '@/lib/validation/uploadSchema';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { minimumSettlementBySku, spreadsheetToScrapeRows } from '@/lib/validation/spreadsheetUpload';

export const runtime = 'nodejs';
// Parsing a large workbook can take longer than Vercel's short default.
export const maxDuration = 300;

const BUCKET = 'upload-staging';
const STAGED_PATH = /^[0-9a-f-]{36}\/[a-zA-Z0-9._-]+$/;

export async function POST(request: Request) {
  let body: { filePath?: unknown; minimumFilePath?: unknown; targetSeller?: unknown };

  try {
    body = await request.json();
  } catch (error) {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const targetSeller = typeof body.targetSeller === 'string' ? body.targetSeller.trim() : '';
  const filePath = typeof body.filePath === 'string' ? body.filePath : '';
  const minimumFilePath = typeof body.minimumFilePath === 'string' ? body.minimumFilePath : '';
  if (!targetSeller) return NextResponse.json({ error: 'Target seller is required.' }, { status: 400 });
  if (!STAGED_PATH.test(filePath) || !STAGED_PATH.test(minimumFilePath)) {
    return NextResponse.json({ error: 'Upload references are invalid. Please choose the files again.' }, { status: 400 });
  }

  try {
    const storage = supabaseAdmin().storage.from(BUCKET);
    const [listing, minimum] = await Promise.all([storage.download(filePath), storage.download(minimumFilePath)]);
    if (listing.error || !listing.data) throw new Error(listing.error?.message ?? 'Could not read the listing file.');
    if (minimum.error || !minimum.data) throw new Error(minimum.error?.message ?? 'Could not read the minimum settlement file.');

    const minimumBySku = minimumSettlementBySku(await minimum.data.arrayBuffer());
    if (minimumBySku.size === 0) {
      return NextResponse.json(
        { error: 'Minimum bank settlement file must contain SKU and "Minimum Bank Settlement price" columns.' },
        { status: 400 },
      );
    }

    const rows = spreadsheetToScrapeRows(await listing.data.arrayBuffer(), targetSeller, minimumBySku);
    const report = validateUpload(JSON.stringify(rows));
    return NextResponse.json({ filename: filePath.split('/')[1] || 'upload.xlsx', report });
  } catch (error) {
    return NextResponse.json(
      { error: `Could not read the upload: ${error instanceof Error ? error.message : String(error)}` },
      { status: 400 },
    );
  } finally {
    // They are only a transport bridge. Validation returns the parsed rows and
    // no user file needs to persist after that.
    await supabaseAdmin().storage.from(BUCKET).remove([filePath, minimumFilePath]);
  }
}
