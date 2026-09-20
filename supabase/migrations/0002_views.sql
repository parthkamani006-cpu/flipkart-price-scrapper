-- 0002_views.sql — the read side.
--
-- Everything here replaces work that used to happen in Node over a fully
-- materialised row array: lib/services/rowFilters.ts (filterRows), the
-- per-job computeStats() call that GET /api/jobs made once per job, and all of
-- lib/services/analytics.ts.
--
-- `security_invoker = on` matters: without it a view runs with its owner's
-- rights and quietly bypasses the RLS defined in 0003.

-- ────────────────────────────────────────────────────────────── job_rows_v

-- The left join that lib/store/jobStore.ts buildRecord() used to do in memory:
-- every uploaded input, plus its result once it has one, in upload order.
--
-- `status` reproduces statusForResult(): no result is pending, status 'OK' is
-- success, anything else is failed. The old in-memory 'running' status is gone
-- from here on purpose — with the worker in another process, "running right
-- now" lives in jobs.progress, which is a live snapshot rather than a row fact.
create or replace view public.job_rows_v
with (security_invoker = on) as
select
  i.job_id,
  i.idx,
  i.sku,
  i.fsn,
  i.target_seller,
  i.product_url,
  i.current_bank_settlement,
  i.bank_settlement_threshold,
  i.benchmark_price,
  i.stock_count,
  i.listing_price,
  i.lowest_listing_file,

  case
    when r.job_id is null then 'pending'
    when r.status = 'OK'  then 'success'
    else 'failed'
  end as status,

  r.status      as result_status,
  r.message,
  r.duration_ms,
  r.attempts,
  r.finished_at,
  r.is_price_different,

  -- Assembled here so the API can hand the client a JournalRow without a second
  -- pass. Column-for-column the old results.ndjson line, minus screenshotPath.
  --
  -- Two halves, and the split is deliberate. The first is what JournalRow
  -- declares as required-but-nullable (`mainPrice: number | null`), so a null
  -- has to arrive as JSON null: stripping it would hand the client `undefined`
  -- where its own type says `null`, and every `x === null` test downstream
  -- would quietly stop matching. The second half is genuinely optional
  -- (`message?: string`), so a null there is just absence and is stripped.
  case when r.job_id is null then null else
    jsonb_build_object(
      'fsn',                        r.fsn,
      'sku',                        r.sku,
      'sellerName',                 r.seller_name,
      'mainPrice',                  r.main_price,
      'sellerPrice',                r.seller_price,
      'difference',                 r.difference,
      'isPriceDifferent',           r.is_price_different,
      'productUrl',                 r.product_url,
      'status',                     r.status
    )
    || jsonb_strip_nulls(jsonb_build_object(
      'buyboxSellerName',           r.buybox_seller_name,
      'mainListingIsAccountSeller', r.main_listing_is_account_seller,
      'message',                    r.message,
      'sellersScanned',             r.sellers_scanned,
      'showMoreClicks',             r.show_more_clicks,
      'source',                     r.source,
      'durationMs',                 r.duration_ms,
      'attempts',                   r.attempts,
      'finishedAt',                 r.finished_at
    ))
  end as result,

  -- The free-text `search` box's haystack. Matches the old joined string in
  -- rowFilters.ts: sku, fsn, targetSeller, productUrl, row status, result
  -- status, seller name, message.
  i.search_text || ' ' ||
    case when r.job_id is null then 'pending' when r.status = 'OK' then 'success' else 'failed' end || ' ' ||
    coalesce(r.search_text, '') as search_text
from public.job_inputs i
left join public.job_results r
  on r.job_id = i.job_id and r.idx = i.idx;

-- ───────────────────────────────────────────────────────────── job_stats_v

-- One row per job. Replaces the N+1 that GET /api/jobs made by calling
-- computeStats() once per job, each of which re-read that job's whole journal.
--
-- `success_rate` and `estimated_remaining_ms` are NOT computed here: the ETA
-- depends on startingPoolWidth() from scraper/utils.ts, which is the same
-- adaptive width the scraper itself will run at. Duplicating that curve in SQL
-- would be two implementations to keep in step, so the API derives those two
-- fields from these counts (lib/store/stats.ts).
create or replace view public.job_stats_v
with (security_invoker = on) as
select
  j.id as job_id,
  (select count(*) from public.job_inputs i where i.job_id = j.id)::int as total,
  (select count(*) from public.job_results r where r.job_id = j.id and r.status = 'OK')::int as succeeded,
  (select count(*) from public.job_results r where r.job_id = j.id and r.status <> 'OK')::int as failed,
  (select count(*) from public.job_results r where r.job_id = j.id)::int as completed,
  -- "Running" is whatever the worker last reported as in flight. It is a live
  -- snapshot, not a row fact, which is why it comes off jobs.progress.
  case when jsonb_typeof(j.progress) = 'array' then jsonb_array_length(j.progress) else 0 end as running,
  (select avg(r.duration_ms)
     from public.job_results r
    where r.job_id = j.id and r.duration_ms is not null) as average_ms
from public.jobs j;

-- ─────────────────────────────────────────────────────────── job_analytics

-- The whole AnalyticsPayload in one round trip.
--
-- The timezone is an explicit argument because the Node version bucketed on
-- server-local getHours(). That was the developer's own clock; on Vercel it
-- would silently become UTC and shift every bar on the throughput chart. Pass
-- the same value the app passes (ANALYTICS_TIMEZONE, default Asia/Kolkata).
create or replace function public.job_analytics(p_job_id text, p_tz text default 'Asia/Kolkata')
returns jsonb
language sql
stable
set search_path = ''
as $fn$
with rows_all as (
  select * from public.job_rows_v where job_id = p_job_id
),
finished as (
  select * from rows_all where result is not null
)
select jsonb_build_object(
  'outcome', jsonb_build_array(
    jsonb_build_object('name', 'Succeeded', 'value', (select count(*) from finished where status = 'success')),
    jsonb_build_object('name', 'Failed',    'value', (select count(*) from finished where status = 'failed')),
    jsonb_build_object('name', 'Pending',   'value', (select count(*) from rows_all where result is null))
  ),

  'failureReasons', coalesce((
    select jsonb_agg(jsonb_build_object('reason', reason, 'count', n) order by n desc, reason)
    from (
      select coalesce(result_status, 'ERROR') as reason, count(*) as n
      from finished where status = 'failed'
      group by 1
    ) t
  ), '[]'::jsonb),

  'sellers', coalesce((
    select jsonb_agg(jsonb_build_object(
             'seller', seller, 'total', total, 'succeeded', succeeded, 'failed', failed)
           order by total desc, seller)
    from (
      select
        case when target_seller = '' then '(none)' else target_seller end as seller,
        count(*)::int as total,
        count(*) filter (where status = 'success')::int as succeeded,
        count(*) filter (where status = 'failed')::int  as failed
      from rows_all
      group by 1
      order by count(*) desc
      limit 20
    ) t
  ), '[]'::jsonb),

  'perHour', coalesce((
    select jsonb_agg(jsonb_build_object(
             'hour', hour, 'completed', completed, 'succeeded', succeeded, 'failed', failed)
           order by hour)
    from (
      select
        to_char(finished_at at time zone p_tz, 'YYYY-MM-DD HH24:00') as hour,
        count(*)::int as completed,
        count(*) filter (where status = 'success')::int as succeeded,
        count(*) filter (where status = 'failed')::int  as failed
      from finished
      where finished_at is not null
      group by 1
    ) t
  ), '[]'::jsonb),

  -- Fixed buckets, emitted in order and including the empty ones, because the
  -- chart draws a fixed six-bar histogram and a missing bucket would shift it.
  'durations', (
    select jsonb_agg(jsonb_build_object('bucket', b.label, 'count', coalesce(c.n, 0)) order by b.ord)
    from (values
      (1, '<2s',    2000),
      (2, '2–5s',   5000),
      (3, '5–10s',  10000),
      (4, '10–20s', 20000),
      (5, '20–60s', 60000),
      (6, '>60s',   null)
    ) as b(ord, label, max_ms)
    left join (
      select
        case
          when duration_ms < 2000  then 1
          when duration_ms < 5000  then 2
          when duration_ms < 10000 then 3
          when duration_ms < 20000 then 4
          when duration_ms < 60000 then 5
          else 6
        end as ord,
        count(*)::int as n
      from finished
      where duration_ms is not null
      group by 1
    ) c on c.ord = b.ord
  ),

  'averageMs', (select round(avg(duration_ms)) from finished where duration_ms is not null),
  'medianMs',  (select round(percentile_cont(0.5) within group (order by duration_ms))
                  from finished where duration_ms is not null)
);
$fn$;
