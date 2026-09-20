-- 0001_schema.sql — the tables.
--
-- Replaces the per-job directory tree under data/ (job.json, inputs.json,
-- results.ndjson, recommendations.json) and the 32-shard intelligence store.
--
-- Job ids keep the application's existing `job_<base36 ms>_<rand>` format.
-- They are already chronologically sortable, already appear in dashboard URLs,
-- and there is no legacy data to reconcile against, so switching to uuid would
-- buy nothing and break every bookmark.

create extension if not exists pg_trgm;

-- ───────────────────────────────────────────────────────────────────── jobs

create table if not exists public.jobs (
  id           text primary key,
  name         text not null,
  account_name text not null default '',

  -- Mirrors JobState in types/dashboard.ts. `interrupted` is written by
  -- reap_stale_jobs() (0004), never by a healthy worker.
  state text not null default 'queued'
    check (state in ('draft','queued','running','pausing','paused',
                     'stopping','stopped','completed','interrupted')),

  -- The control channel. The dashboard writes this; the worker polls it.
  -- Deliberately separate from `state`: `state` is what IS happening,
  -- `requested_action` is what the user last asked for, and the two are only
  -- reconciled once a worker notices — which across a GitHub Actions boundary
  -- is seconds later, or (for a job no worker holds) not until one claims it.
  requested_action text not null default 'RUN'
    check (requested_action in ('RUN','PAUSE','STOP')),

  options       jsonb not null,   -- JobOptions
  orders_window jsonb,            -- OrdersWindow, when an orders report was supplied
  total         integer not null default 0,

  -- Live snapshots the worker overwrites at most once a second. These exist so
  -- one row UPDATE feeds the whole live UI over Realtime; they are a projection,
  -- never the source of truth. Authoritative counts come from job_stats_v
  -- (0002), which recomputes them from job_results.
  progress jsonb not null default '[]'::jsonb,  -- LiveProgress[]
  stats    jsonb,                               -- JobStats snapshot, may lag

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  upload_time    timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  interrupted_at timestamptz,

  error    text,
  error_at timestamptz,

  recommendation_summary       text,
  recommendations_generated_at timestamptz,

  -- Lease. Held by whichever GitHub Actions run claimed the job; see 0004.
  lease_owner      text,
  lease_expires_at timestamptz,
  heartbeat_at     timestamptz
);

create index if not exists jobs_account_created_idx on public.jobs (account_name, created_at desc);
create index if not exists jobs_created_idx         on public.jobs (created_at desc);
-- Partial: claim_job() only ever looks at queued work.
create index if not exists jobs_queued_idx          on public.jobs (created_at) where state = 'queued';

create or replace function public.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

drop trigger if exists jobs_touch_updated_at on public.jobs;
create trigger jobs_touch_updated_at before update on public.jobs
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────── job_inputs

-- The upload, verbatim: one row per line of what used to be inputs.json.
-- Immutable once written. `idx` is the row's position in the uploaded file and
-- is the join key everywhere. It replaces the old NUL-separated
-- `sku \0 productUrl` string key from scraper/journal.ts, which could collide
-- when a SKU contained the separator.
create table if not exists public.job_inputs (
  job_id        text not null references public.jobs (id) on delete cascade,
  idx           integer not null,
  sku           text not null,
  fsn           text not null,
  target_seller text not null,
  product_url   text not null,

  -- Settlement inputs. The scraper reads none of 1 these; they pass through from
  -- the spreadsheet to the settlement and recommendation views.
  current_bank_settlement   numeric,
  bank_settlement_threshold numeric,
  benchmark_price           numeric,
  stock_count               numeric,
  listing_price             numeric,
  lowest_listing_file       numeric,

  -- What the filter bar's free-text search matches on the input side.
  -- Generated, so it can never drift from the columns it summarises.
  search_text text generated always as (
    sku || ' ' || fsn || ' ' || target_seller || ' ' || product_url
  ) stored,

  primary key (job_id, idx)
);

create index if not exists job_inputs_search_idx on public.job_inputs using gin (search_text gin_trgm_ops);
create index if not exists job_inputs_fsn_idx    on public.job_inputs (job_id, fsn);

-- ────────────────────────────────────────────────────────────── job_results

-- One result per row — never a blob. The old results.ndjson was read as a whole
-- file, which is precisely what made every filter a full array scan in Node.
create table if not exists public.job_results (
  job_id text not null references public.jobs (id) on delete cascade,
  idx    integer not null,

  -- Denormalised from job_inputs so job_results is independently indexable and
  -- a result row stays self-describing, the way a journal line was.
  fsn         text not null,
  sku         text not null,
  product_url text not null,

  seller_name        text,
  buybox_seller_name text,
  main_listing_is_account_seller boolean,
  main_price         numeric,
  seller_price       numeric,
  difference         numeric,
  is_price_different boolean not null default false,

  status text not null
    check (status in ('OK','PRODUCT_UNAVAILABLE','NO_SELLER_LINK','SELLER_LIST_LOAD_FAILED',
                      'SELLER_NOT_FOUND','MAIN_PRICE_NOT_FOUND','SELLER_PRICE_NOT_FOUND',
                      'BLOCKED','ERROR')),
  message          text,
  sellers_scanned  integer,
  show_more_clicks integer,
  source           text check (source in ('network','dom')),
  duration_ms      integer,
  attempts         integer,

  finished_at timestamptz not null default now(),

  search_text text generated always as (
    status || ' ' || coalesce(seller_name, '') || ' ' || coalesce(message, '')
  ) stored,

  primary key (job_id, idx),
  foreign key (job_id, idx) references public.job_inputs (job_id, idx) on delete cascade
);

create index if not exists job_results_status_idx   on public.job_results (job_id, status);
create index if not exists job_results_finished_idx on public.job_results (job_id, finished_at);
create index if not exists job_results_duration_idx on public.job_results (job_id, duration_ms);
create index if not exists job_results_search_idx   on public.job_results using gin (search_text gin_trgm_ops);

-- ─────────────────────────────────────────────────────────── recommendations

create table if not exists public.recommendations (
  job_id text not null references public.jobs (id) on delete cascade,
  idx    integer not null,
  sku    text not null,
  fsn    text not null,
  diff_amount numeric,
  status text not null
    check (status in ('Safe','Not Safe','Safe but more than 20%','Threshold Missing','Need Review')),
  final_bank_settlement numeric,
  reason       text,
  generated_at timestamptz not null default now(),
  primary key (job_id, idx)
);

create index if not exists recommendations_status_idx on public.recommendations (job_id, status);

-- ───────────────────────────────────────────────────────── fsn_intelligence

-- Authoritative, and deliberately NOT a child of jobs: no foreign key, no
-- cascade. Retention (0005) prunes batches; the learning folded out of them has
-- to survive that, because after a prune there is no journal left to replay.
--
-- `record` is jsonb because FsnIntelligence genuinely is dynamic — observations,
-- generated formulas, and per-predictor stats keyed by predictor id. The scalar
-- columns beside it are denormalised copies so the leaderboard is an ORDER BY
-- rather than loading every record into Node and sorting there.
create table if not exists public.fsn_intelligence (
  account_slug text not null,
  fsn          text not null,
  account_name text not null,
  record       jsonb not null,

  champion           text,
  accuracy_pct       numeric,
  average_error      numeric,
  observations_count integer not null default 0,
  updated_at         timestamptz not null default now(),

  primary key (account_slug, fsn)
);

create index if not exists fsn_intelligence_leaderboard_idx
  on public.fsn_intelligence (account_slug, accuracy_pct desc nulls last);

-- Replaces manifest.processedJobIds. Not FK'd to jobs on purpose: pruning a job
-- must not un-process it and invite a double-count on the next sync.
create table if not exists public.intelligence_processed_jobs (
  account_slug text not null,
  job_id       text not null,
  processed_at timestamptz not null default now(),
  primary key (account_slug, job_id)
);
