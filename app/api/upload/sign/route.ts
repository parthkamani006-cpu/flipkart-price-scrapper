/**
 * Creates one-time Supabase Storage upload tokens.
 *
 * Files are deliberately uploaded by the browser straight to Storage instead
 * of passing through Vercel. Vercel rejects request bodies above its platform
 * limit before a route handler runs, which made the old multipart endpoint
 * unsuitable for real seller exports.
 */

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

const BUCKET = 'upload-staging';
const ALLOWED_EXTENSIONS = /\.(xlsx?|xls)$/i;

type UploadFile = { name?: unknown; contentType?: unknown };

export async function POST(request: Request) {
  let body: { files?: UploadFile[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  if (!Array.isArray(body.files) || body.files.length !== 2) {
    return NextResponse.json({ error: 'Exactly two spreadsheet files are required.' }, { status: 400 });
  }

  try {
    const uploads = await Promise.all(body.files.map(async (file) => {
      const name = typeof file.name === 'string' ? file.name : '';
      if (!name || !ALLOWED_EXTENSIONS.test(name)) {
        throw new Error('Only XLS and XLSX files can be uploaded.');
      }

      // The generated prefix makes a token useful only for the object created
      // for this request; filenames are reduced to a harmless display suffix.
      const suffix = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
      const path = `${crypto.randomUUID()}/${suffix}`;
      const { data, error } = await supabaseAdmin().storage.from(BUCKET).createSignedUploadUrl(path);
      if (error || !data) throw new Error(error?.message ?? 'Could not prepare the upload.');

      return { path, token: data.token };
    }));

    return NextResponse.json({ bucket: BUCKET, uploads });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not prepare the upload.' },
      { status: 500 },
    );
  }
}
