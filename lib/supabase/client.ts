/**
 * The browser client. Anon key only.
 *
 * Its single job is the Realtime socket that replaced the old SSE route: RLS
 * (supabase/migrations/0003_rls.sql) grants this key SELECT and nothing else,
 * so it cannot write even if someone lifts it out of the bundle — which they
 * can, and which is expected. Every mutation still goes through a Vercel route
 * holding the service-role key.
 *
 * Data reads stay on the existing /api routes rather than moving here. That
 * keeps one place where a response shape is decided, and keeps the filter,
 * sort and pagination logic on the server where the SQL lives.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

/**
 * Null when the app has not been configured yet, rather than throwing: a fresh
 * checkout with no .env.local should still render the dashboard shell and say
 * what is missing, not white-screen on a module-level throw.
 */
export function supabaseBrowser(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  if (!cached) {
    cached = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: {
        // The worker writes a progress snapshot at most once a second and a
        // result row roughly once a second at a 20-wide pool. Ten is headroom,
        // not a target.
        params: { eventsPerSecond: 10 },
      },
    });
  }

  return cached;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
