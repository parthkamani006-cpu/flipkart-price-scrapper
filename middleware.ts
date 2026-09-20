/**
 * IP allowlist gate.
 *
 * The dashboard has no login. Anyone holding the Vercel URL can queue scrape
 * jobs, read competitor pricing and export it, so the front door is closed by
 * address instead: set `IP_ALLOWLIST` in the Vercel project env and only those
 * addresses get past this file.
 *
 * The gate is off when `IP_ALLOWLIST` is unset or empty — that keeps local dev
 * and a fresh clone working, and it means the feature is opt-in rather than a
 * lockout waiting to happen. Once the variable holds at least one valid rule
 * the allowlist is enforced for every request that reaches the matcher below.
 *
 * See docs/DEPLOYMENT.md for how to set it and how to get back in if the
 * address you allowed stops being the address you have.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { isIpAllowed, isLoopback, parseIpAllowlist, type AllowRule } from '@/lib/security/ipAllowlist';

/**
 * Parsing is pure string work but it runs on every request, so the result is
 * kept against the raw value that produced it. The env var only changes on
 * redeploy, so in practice this parses once per instance.
 */
let cached: { raw: string; rules: AllowRule[]; invalid: string[] } | null = null;

function allowlist(raw: string): { rules: AllowRule[]; invalid: string[] } {
  if (!cached || cached.raw !== raw) {
    const parsed = parseIpAllowlist(raw);
    cached = { raw, ...parsed };
    if (parsed.invalid.length > 0) {
      console.warn(
        `[ip-allowlist] ignoring ${parsed.invalid.length} unparseable entr` +
          `${parsed.invalid.length === 1 ? 'y' : 'ies'}: ${parsed.invalid.join(', ')}`,
      );
    }
  }
  return cached;
}

/**
 * The caller's address.
 *
 * On Vercel `x-vercel-forwarded-for` is written by the platform from the TCP
 * connection and a client cannot forge it, so it is preferred. `x-real-ip` and
 * `x-forwarded-for` are the fallbacks for other hosts; the leftmost entry of
 * `x-forwarded-for` is the original client.
 */
function clientIp(request: NextRequest): string | null {
  const headers = ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for'];

  for (const header of headers) {
    const value = request.headers.get(header);
    if (!value) continue;
    const first = value.split(',')[0]?.trim();
    if (first) return first;
  }
  return null;
}

/** 403, as JSON for the API and as a page for everything else. */
function forbidden(request: NextRequest, ip: string | null): NextResponse {
  const seen = ip ?? 'unknown';

  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'Forbidden', reason: 'ip_not_allowed', ip: seen },
      { status: 403 },
    );
  }

  // Self-contained: the matcher gates static assets too, so this page cannot
  // rely on fetching anything.
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Access denied</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0a0a0b; color:#e5e5e7; font:14px/1.6 ui-sans-serif,system-ui,sans-serif; padding:24px }
  main { max-width:26rem }
  h1 { font-size:1.125rem; margin:0 0 .5rem; font-weight:600 }
  p { margin:0 0 1rem; color:#9b9ba1 }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.875rem;
         background:#18181b; border:1px solid #27272a; border-radius:6px; padding:.15rem .4rem; color:#e5e5e7 }
</style></head>
<body><main>
  <h1>Access denied</h1>
  <p>This dashboard is restricted to approved networks. Your address is not one of them.</p>
  <p>Your IP address is <code>${seen.replace(/[<>&"]/g, '')}</code>. Add it to
  <code>IP_ALLOWLIST</code> to get in.</p>
</main></body></html>`;

  return new NextResponse(page, {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function middleware(request: NextRequest): NextResponse {
  const { rules } = allowlist(process.env.IP_ALLOWLIST ?? '');

  // Nothing configured — the gate is open. Also covers the case where every
  // entry was malformed, which would otherwise lock everyone out on a typo.
  if (rules.length === 0) return NextResponse.next();

  const ip = clientIp(request);

  if (ip) {
    // The machine talking to itself, i.e. `next dev`.
    if (isLoopback(ip)) return NextResponse.next();
    if (isIpAllowed(ip, rules)) return NextResponse.next();
    return forbidden(request, ip);
  }

  // No address to judge. In production that means a misconfigured proxy and the
  // safe answer is no; locally there are simply no forwarding headers.
  if (process.env.NODE_ENV !== 'production') return NextResponse.next();
  return forbidden(request, null);
}

export const config = {
  /**
   * Everything except the favicon and Next's image optimiser. The JS bundles
   * under `_next/static` are deliberately gated as well — they describe the
   * app's routes and API shape, and there is no reason to hand them to someone
   * who cannot use them.
   */
  matcher: ['/((?!_next/image|favicon.ico).*)'],
};
