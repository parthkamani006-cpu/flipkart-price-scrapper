/**
 * Queue filtering.
 *
 * Lives in one module because the same predicate has to serve three callers:
 * the rows API, the failed-products page, and the export endpoint. An export
 * that silently ignored the filters the user could see on screen would be a
 * lie, so they all run this.
 *
 * The predicate used to be a JS `.filter()` over every row of the batch, which
 * meant the whole journal was materialised to answer any question about it.
 * It is now applied to the `job_rows_v` query instead, so Postgres does the
 * work and only the page the user is looking at crosses the wire. The rules
 * themselves are unchanged — including the two odd ones documented below,
 * which are preserved deliberately rather than tidied.
 */

import type { RowStatus, ScrapeStatus } from '@/types/dashboard';

export interface RowFilters {
  /** Matched against sku, fsn, seller, url, status and failure message. */
  search?: string;
  status?: RowStatus[];
  failureReason?: ScrapeStatus[];
  sku?: string;
  fsn?: string;
  seller?: string;
  productUrl?: string;
  /** ISO dates, inclusive, against the row's completion time. */
  from?: string;
  to?: string;
  minDurationMs?: number;
  maxDurationMs?: number;
  /** Only rows whose page price differs from the seller price. */
  priceMismatchOnly?: boolean;
}

export function parseRowFilters(params: URLSearchParams): RowFilters {
  const list = (key: string): string[] | undefined => {
    const raw = params.getAll(key).flatMap((value) => value.split(',')).filter(Boolean);
    return raw.length ? raw : undefined;
  };

  const num = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  const text = (key: string): string | undefined => params.get(key)?.trim() || undefined;

  return {
    search: text('search'),
    status: list('status') as RowStatus[] | undefined,
    failureReason: list('reason') as ScrapeStatus[] | undefined,
    sku: text('sku'),
    fsn: text('fsn'),
    seller: text('seller'),
    productUrl: text('url'),
    from: text('from'),
    to: text('to'),
    minDurationMs: num('minDuration'),
    maxDurationMs: num('maxDuration'),
    priceMismatchOnly: params.get('mismatch') === 'true',
  };
}

/** Rebuild the query string these filters came from, for export links. */
export function rowFiltersToParams(filters: RowFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search) params.set('search', filters.search);
  if (filters.status?.length) params.set('status', filters.status.join(','));
  if (filters.failureReason?.length) params.set('reason', filters.failureReason.join(','));
  if (filters.sku) params.set('sku', filters.sku);
  if (filters.fsn) params.set('fsn', filters.fsn);
  if (filters.seller) params.set('seller', filters.seller);
  if (filters.productUrl) params.set('url', filters.productUrl);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.minDurationMs !== undefined) params.set('minDuration', String(filters.minDurationMs));
  if (filters.maxDurationMs !== undefined) params.set('maxDuration', String(filters.maxDurationMs));
  if (filters.priceMismatchOnly) params.set('mismatch', 'true');
  return params;
}

/**
 * The subset of the PostgREST builder this module touches.
 *
 * Structural rather than an import of PostgrestFilterBuilder: those generics
 * change shape between supabase-js minors, and all we need is that each method
 * returns the same builder back.
 */
export interface FilterableQuery<Q> {
  eq(column: string, value: unknown): Q;
  in(column: string, values: readonly unknown[]): Q;
  gte(column: string, value: unknown): Q;
  lte(column: string, value: unknown): Q;
  ilike(column: string, pattern: string): Q;
  not(column: string, operator: string, value: unknown): Q;
}

/** `%` and `_` are LIKE wildcards; a SKU containing one must not become a pattern. */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Apply the filters to a job_rows_v query.
 *
 * Two behaviours carried over verbatim from the array version, because the
 * filter bar was built against them:
 *
 * - A date range excludes rows that never finished. `from`/`to` are read off
 *   the completion timestamp, and a pending row has none, so it cannot be in
 *   any range. A bare `YYYY-MM-DD` in `to` means end of that day, not midnight.
 * - A duration bound also excludes rows with no duration. The old code
 *   substituted -1 for a missing duration when testing the lower bound and
 *   MAX_SAFE_INTEGER when testing the upper one, so a null failed both. (In
 *   principle a negative lower bound would have kept them; the filter bar only
 *   ever sends values >= 0, so that branch was unreachable.)
 */
export function applyRowFilters<Q extends FilterableQuery<Q>>(query: Q, filters: RowFilters): Q {
  let q = query;

  if (filters.status?.length) q = q.in('status', filters.status);
  // A null result_status never matches an IN list, so this drops pending rows
  // on its own — exactly as the array version did by testing `row.result`.
  if (filters.failureReason?.length) q = q.in('result_status', filters.failureReason);

  if (filters.sku) q = q.ilike('sku', likeContains(filters.sku));
  if (filters.fsn) q = q.ilike('fsn', likeContains(filters.fsn));
  if (filters.seller) q = q.ilike('target_seller', likeContains(filters.seller));
  if (filters.productUrl) q = q.ilike('product_url', likeContains(filters.productUrl));

  if (filters.from || filters.to) {
    q = q.not('finished_at', 'is', null);
    if (filters.from) q = q.gte('finished_at', filters.from);
    if (filters.to) {
      const to = filters.to.length <= 10 ? `${filters.to}T23:59:59.999Z` : filters.to;
      q = q.lte('finished_at', to);
    }
  }

  if (filters.minDurationMs !== undefined) {
    q = q.not('duration_ms', 'is', null).gte('duration_ms', filters.minDurationMs);
  }
  if (filters.maxDurationMs !== undefined) {
    q = q.not('duration_ms', 'is', null).lte('duration_ms', filters.maxDurationMs);
  }

  if (filters.priceMismatchOnly) q = q.eq('is_price_different', true);

  // One ILIKE over the view's generated search_text, which concatenates exactly
  // the eight fields the old haystack joined. Backed by a trigram GIN index on
  // each underlying table.
  if (filters.search) q = q.ilike('search_text', likeContains(filters.search));

  return q;
}
