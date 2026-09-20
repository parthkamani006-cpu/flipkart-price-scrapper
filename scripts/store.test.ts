/**
 * The store's pure layer: mapping, stats arithmetic and filter translation.
 *
 * This replaces scripts/pool.test.ts, which proved that a result arriving out
 * of order still landed on the row that produced it. With a worker pool the
 * journal was written in completion order, and the join back to upload order
 * was a Map keyed on a NUL-joined `sku + productUrl` string — real bookkeeping,
 * and worth a test.
 *
 * That join no longer exists. A result is written under `(job_id, idx)`, which
 * is the primary key, so landing on the wrong row is not a bug the code can
 * have any more: it is a constraint violation. What is left to get wrong is
 * everything around it — the DB-to-app mapping, the ETA arithmetic that used to
 * live inside computeStats, and the translation of the filter bar into a query.
 * Those are what this covers.
 *
 * Nothing here touches Supabase. The filter test asserts against a recording
 * stub, which is the point: it pins the exact predicates without a database.
 *
 * Run: npm run test:store
 */

import assert from 'node:assert/strict';

import { toJobRow, toManifest, toScrapeInput, resultToColumns } from '@/lib/store/mappers';
import { statsFromView, EMPTY_STATS } from '@/lib/store/stats';
import { applyRowFilters, parseRowFilters, type FilterableQuery } from '@/lib/services/rowFilters';
import { buildRecommendation } from '@/lib/recommendation';
import { DEFAULT_JOB_OPTIONS } from '@/types/dashboard';
import type { JobRowViewDb, JobRowDb, JobInputDb } from '@/lib/supabase/types';
import type { JournalRow } from '@/types/dashboard';

let passed = 0;
function check(label: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ok  ${label}`);
}

/* ------------------------------------------------------------- mappers */

console.log('mappers');

const jobRowDb: JobRowDb = {
  id: 'job_abc_123',
  name: 'Batch of 3',
  account_name: 'Previx',
  state: 'completed',
  requested_action: 'RUN',
  // Deliberately partial, as a batch created before an option existed would be.
  options: { concurrency: 4 } as JobRowDb['options'],
  orders_window: null,
  total: 3,
  progress: [],
  stats: null,
  created_at: '2026-09-01T10:00:00.000Z',
  updated_at: '2026-09-01T10:30:00.000Z',
  upload_time: null,
  started_at: '2026-09-01T10:05:00.000Z',
  finished_at: '2026-09-01T10:30:00.000Z',
  interrupted_at: null,
  error: null,
  error_at: null,
  recommendation_summary: '3 FSNs',
  recommendations_generated_at: '2026-09-01T10:30:01.000Z',
  lease_owner: null,
  lease_expires_at: null,
  heartbeat_at: null,
};

check('a partial options column is merged over the defaults', () => {
  const manifest = toManifest(jobRowDb);
  assert.equal(manifest.options.concurrency, 4, 'the stored value must win');
  assert.equal(
    manifest.options.delayMs,
    DEFAULT_JOB_OPTIONS.delayMs,
    'a missing key must fall back, not arrive undefined',
  );
  assert.equal(manifest.options.blockRetries, DEFAULT_JOB_OPTIONS.blockRetries);
});

check('a missing upload_time falls back to created_at', () => {
  const manifest = toManifest(jobRowDb);
  assert.equal(manifest.uploadTime, '2026-09-01T10:00:00.000Z');
});

check('numeric columns arriving as strings become numbers', () => {
  // PostgREST serialises `numeric` as a string once it is wide enough, and a
  // settlement figure compared as a string would sort and subtract wrongly.
  const input = toScrapeInput({
    job_id: 'job_abc_123',
    idx: 0,
    sku: 'SKU-0',
    fsn: 'FSN0',
    target_seller: 'Previx',
    product_url: 'https://www.flipkart.com/x/p/itme?pid=FSN0',
    current_bank_settlement: '176' as unknown as number,
    bank_settlement_threshold: 190,
    benchmark_price: null,
    stock_count: null,
    listing_price: null,
    lowest_listing_file: null,
  } satisfies JobInputDb);

  assert.equal(input.currentBankSettlement, 176);
  assert.equal(typeof input.currentBankSettlement, 'number');
  assert.equal(input.benchmarkPrice, undefined, 'a null column must be absent, not null');
});

check('a pending view row maps to a row with no result', () => {
  const row = toJobRow({
    job_id: 'job_abc_123',
    idx: 7,
    sku: 'SKU-7',
    fsn: 'FSN7',
    target_seller: 'Previx',
    product_url: 'https://www.flipkart.com/x/p/itme?pid=FSN7',
    current_bank_settlement: 100,
    bank_settlement_threshold: 90,
    benchmark_price: null,
    stock_count: null,
    listing_price: null,
    lowest_listing_file: null,
    status: 'pending',
    result_status: null,
    message: null,
    duration_ms: null,
    attempts: null,
    finished_at: null,
    is_price_different: null,
    result: null,
  } satisfies JobRowViewDb);

  assert.equal(row.index, 7, 'index is the uploaded position, not the page position');
  assert.equal(row.status, 'pending');
  assert.equal(row.result, undefined);
  assert.equal(row.key, 'job_abc_123#7');
});

check('a screenshot path is never written back to the database', () => {
  // The worker runs on a GitHub Actions runner whose filesystem is gone the
  // moment the job ends, so a stored path could only ever be a dead link.
  const result: JournalRow = {
    fsn: 'FSN1',
    sku: 'SKU-1',
    sellerName: null,
    mainPrice: null,
    sellerPrice: null,
    difference: null,
    isPriceDifferent: false,
    productUrl: 'https://www.flipkart.com/x/p/itme?pid=FSN1',
    status: 'PRODUCT_UNAVAILABLE',
    message: 'Page shows "Out of stock"',
    screenshotPath: '/home/runner/work/x/data/jobs/job_abc_123/screenshots/SKU-1.png',
    finishedAt: '2026-09-01T10:20:00.000Z',
  };

  const columns = resultToColumns('job_abc_123', 1, result) as unknown as Record<string, unknown>;
  assert.ok(!('screenshot_path' in columns), 'no screenshot column should be produced');
  assert.equal(columns.idx, 1);
  assert.equal(columns.status, 'PRODUCT_UNAVAILABLE');
});

/* --------------------------------------------------------------- stats */

console.log('stats');

check('an empty batch reports the empty stats', () => {
  assert.deepEqual(statsFromView(null, DEFAULT_JOB_OPTIONS), EMPTY_STATS);
});

check('counts, success rate and the queue length agree with each other', () => {
  const stats = statsFromView(
    { job_id: 'j', total: 100, succeeded: 30, failed: 10, completed: 40, running: 5, average_ms: 4000 },
    { ...DEFAULT_JOB_OPTIONS, concurrency: 1, delayMs: 0, delayJitterMs: 0 },
  );

  assert.equal(stats.completed, 40);
  assert.equal(stats.running, 5);
  assert.equal(stats.pending, 55, 'total − completed − running');
  assert.equal(stats.queueLength, stats.pending);
  assert.equal(stats.successRate, 75, '30 of 40 finished rows succeeded');
  assert.equal(stats.averageMs, 4000);
});

check('the ETA counts the per-product throttle and divides by the pool width', () => {
  // One worker, no throttle: 60 products left at 4s each is four minutes.
  const sequential = statsFromView(
    { job_id: 'j', total: 100, succeeded: 40, failed: 0, completed: 40, running: 0, average_ms: 4000 },
    { ...DEFAULT_JOB_OPTIONS, concurrency: 1, delayMs: 0, delayJitterMs: 0 },
  );
  assert.equal(sequential.estimatedRemainingMs, 60 * 4000);

  // The throttle is wall-clock time per worker, so it belongs in the estimate.
  const throttled = statsFromView(
    { job_id: 'j', total: 100, succeeded: 40, failed: 0, completed: 40, running: 0, average_ms: 4000 },
    { ...DEFAULT_JOB_OPTIONS, concurrency: 1, delayMs: 1500, delayJitterMs: 400 },
  );
  assert.equal(throttled.estimatedRemainingMs, 60 * (4000 + 1500 + 200));

  // A wider pool retires the queue proportionally faster.
  const pooled = statsFromView(
    { job_id: 'j', total: 100, succeeded: 40, failed: 0, completed: 40, running: 0, average_ms: 4000 },
    { ...DEFAULT_JOB_OPTIONS, concurrency: 8, delayMs: 0, delayJitterMs: 0 },
  );
  assert.ok(
    pooled.estimatedRemainingMs !== null && pooled.estimatedRemainingMs < sequential.estimatedRemainingMs,
    'eight workers must not quote a sequential ETA',
  );
});

check('nothing finished yet means no average and no estimate', () => {
  const stats = statsFromView(
    { job_id: 'j', total: 10, succeeded: 0, failed: 0, completed: 0, running: 0, average_ms: null },
    DEFAULT_JOB_OPTIONS,
  );
  assert.equal(stats.averageMs, null);
  assert.equal(stats.successRate, null);
  assert.equal(stats.estimatedRemainingMs, null, 'an estimate with no measurement would be invented');
});

check('a stale progress snapshot cannot push pending below zero', () => {
  // The worker writes progress and results independently, so a snapshot can
  // briefly claim more in flight than there is work left.
  const stats = statsFromView(
    { job_id: 'j', total: 10, succeeded: 10, failed: 0, completed: 10, running: 4, average_ms: 1000 },
    DEFAULT_JOB_OPTIONS,
  );
  assert.equal(stats.running, 0);
  assert.equal(stats.pending, 0);
});

/* ------------------------------------------------------------- filters */

console.log('filters');

/** Records every predicate applied, so the test can assert on the query itself. */
interface Applied {
  method: string;
  column: string;
  value: unknown;
}

class QueryStub implements FilterableQuery<QueryStub> {
  readonly applied: Applied[] = [];

  private record(method: string, column: string, value: unknown): QueryStub {
    this.applied.push({ method, column, value });
    return this;
  }

  eq(column: string, value: unknown): QueryStub {
    return this.record('eq', column, value);
  }
  in(column: string, values: readonly unknown[]): QueryStub {
    return this.record('in', column, values);
  }
  gte(column: string, value: unknown): QueryStub {
    return this.record('gte', column, value);
  }
  lte(column: string, value: unknown): QueryStub {
    return this.record('lte', column, value);
  }
  ilike(column: string, pattern: string): QueryStub {
    return this.record('ilike', column, pattern);
  }
  not(column: string, operator: string, value: unknown): QueryStub {
    return this.record('not', column, `${operator} ${String(value)}`);
  }

  find(method: string, column: string): Applied | undefined {
    return this.applied.find((entry) => entry.method === method && entry.column === column);
  }
}

function applied(query: string): QueryStub {
  const stub = new QueryStub();
  applyRowFilters(stub, parseRowFilters(new URLSearchParams(query)));
  return stub;
}

check('no filters means no predicates', () => {
  assert.equal(applied('').applied.length, 0, 'an unfiltered queue must not narrow the query');
});

check('a bare to-date covers the whole day', () => {
  // The user picked a date, not a midnight; cutting off at 00:00 would silently
  // drop everything scraped that day.
  const stub = applied('to=2026-09-01');
  assert.equal(stub.find('lte', 'finished_at')?.value, '2026-09-01T23:59:59.999Z');

  const explicit = applied('to=2026-09-01T08:00:00.000Z');
  assert.equal(explicit.find('lte', 'finished_at')?.value, '2026-09-01T08:00:00.000Z');
});

check('a date range excludes rows that never finished', () => {
  const stub = applied('from=2026-09-01');
  assert.ok(stub.find('not', 'finished_at'), 'pending rows have no completion time to be in range');
});

check('a duration bound excludes rows with no duration', () => {
  // Carried over verbatim: the array version substituted -1 for a missing
  // duration on the lower bound and MAX_SAFE_INTEGER on the upper, so a null
  // failed both.
  const min = applied('minDuration=2000');
  assert.ok(min.find('not', 'duration_ms'));
  assert.equal(min.find('gte', 'duration_ms')?.value, 2000);

  const max = applied('maxDuration=9000');
  assert.ok(max.find('not', 'duration_ms'));
  assert.equal(max.find('lte', 'duration_ms')?.value, 9000);
});

check('a failure-reason filter drops pending rows on its own', () => {
  // result_status is null while a product is pending, and null never matches an
  // IN list — which is exactly what the array version achieved by testing
  // `row.result` first.
  const stub = applied('reason=BLOCKED,SELLER_NOT_FOUND');
  assert.deepEqual(stub.find('in', 'result_status')?.value, ['BLOCKED', 'SELLER_NOT_FOUND']);
  assert.ok(!stub.find('in', 'status'), 'the row status must not be constrained too');
});

check('LIKE wildcards inside a search term are escaped', () => {
  // A SKU legitimately containing % or _ must match itself, not act as a pattern.
  const stub = applied('sku=' + encodeURIComponent('AB_1%'));
  assert.equal(stub.find('ilike', 'sku')?.value, '%AB\\_1\\%%');
});

check('free-text search becomes one ILIKE over the view search column', () => {
  const stub = applied('search=' + encodeURIComponent('Previx'));
  assert.equal(stub.find('ilike', 'search_text')?.value, '%Previx%');
});

check('every filter the bar can send is translated', () => {
  const stub = applied(
    'search=x&status=failed&reason=ERROR&sku=a&fsn=b&seller=c&url=d' +
      '&from=2026-09-01&to=2026-09-02&minDuration=1&maxDuration=2&mismatch=true',
  );
  const columns = new Set(stub.applied.map((entry) => entry.column));
  for (const column of [
    'status',
    'result_status',
    'sku',
    'fsn',
    'target_seller',
    'product_url',
    'finished_at',
    'duration_ms',
    'is_price_different',
    'search_text',
  ]) {
    assert.ok(columns.has(column), `${column} was not constrained`);
  }
});

/* ----------------------------------------------------- recommendations */

console.log('recommendations');

check('a mapped row still scores the way the recommendation expects', () => {
  // The mapper is upstream of every settlement decision, so a field it drops
  // would surface here as a silently unscoreable row rather than an error.
  const row = toJobRow({
    job_id: 'job_abc_123',
    idx: 2,
    sku: 'SKU-2',
    fsn: 'FSN2',
    target_seller: 'Previx',
    product_url: 'https://www.flipkart.com/x/p/itme?pid=FSN2',
    current_bank_settlement: 176,
    bank_settlement_threshold: 150,
    benchmark_price: null,
    stock_count: null,
    listing_price: null,
    lowest_listing_file: null,
    status: 'success',
    result_status: 'OK',
    message: null,
    duration_ms: 3200,
    attempts: 1,
    finished_at: '2026-09-01T10:20:00.000Z',
    is_price_different: true,
    result: {
      fsn: 'FSN2',
      sku: 'SKU-2',
      sellerName: 'Previx',
      buyboxSellerName: 'Someone Else',
      mainPrice: 178,
      sellerPrice: 257,
      difference: 79,
      isPriceDifferent: true,
      productUrl: 'https://www.flipkart.com/x/p/itme?pid=FSN2',
      status: 'OK',
      durationMs: 3200,
      attempts: 1,
    },
  } satisfies JobRowViewDb);

  const recommendation = buildRecommendation(row);
  assert.equal(recommendation.index, 2);
  assert.equal(recommendation.sku, 'SKU-2');
  assert.equal(recommendation.fsn, 'FSN2');
  assert.notEqual(recommendation.status, 'Need Review', 'a fully-populated row must be scoreable');
  assert.notEqual(recommendation.status, 'Threshold Missing', 'the threshold column survived the mapping');
});

console.log(`\n${passed} assertions passed.`);
