/**
 * The service-role client. Bypasses RLS, so it is the only thing in the system
 * that can write.
 *
 * Two callers, and only two: Next.js route handlers running on Vercel, and the
 * scraper worker running in GitHub Actions. It must never reach a browser —
 * hence the window guard below and the deliberate absence of a `NEXT_PUBLIC_`
 * prefix on the key. If you ever see this module in a client bundle, the guard
 * has done its job and something upstream needs an import fixed, not the guard
 * relaxed.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example, fill it in, and set the same values in ` +
        `Vercel's project environment and the repository's GitHub Actions secrets.`,
    );
  }
  return value;
}

export function supabaseAdmin(): SupabaseClient {
  if (typeof window !== 'undefined') {
    throw new Error('supabaseAdmin() was called in the browser. The service-role key is server-only.');
  }
  if (cached) return cached;

  // SUPABASE_URL for the worker, NEXT_PUBLIC_SUPABASE_URL for Vercel, where the
  // same URL is already set for the browser client. The key has no such fallback.
  const url = required('SUPABASE_URL', process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = required('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY);

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Nothing server-side subscribes; the browser owns the Realtime socket.
    global: { headers: { 'x-application-name': 'flipkart-price-scrapper' } },
  });

  return cached;
}

/** True when the service-role credentials are present. Used to fail a route with a clear message. */
export function hasAdminCredentials(): boolean {
  return Boolean(
    (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL) &&
      process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}
