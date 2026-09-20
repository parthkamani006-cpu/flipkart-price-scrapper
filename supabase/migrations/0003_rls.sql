-- 0003_rls.sql — row level security.
--
-- The posture, deliberately chosen: the dashboard has no login, so the browser
-- holds only the anon key and RLS grants that key SELECT and nothing else.
-- There is no INSERT/UPDATE/DELETE policy for any role, which means the only
-- writers are the service_role key — held by the GitHub Actions worker and by
-- Vercel's server-side routes — because service_role bypasses RLS entirely.
--
-- Consequence worth stating plainly: anyone holding the anon key (it ships in
-- the client bundle) and the project URL can read every batch, SKU, FSN, seller
-- name and price. Nothing here protects the data from being read; it only
-- protects it from being written. If that changes, swap the `to anon` in each
-- policy for `to authenticated` and add a login.

alter table public.jobs                        enable row level security;
alter table public.job_inputs                  enable row level security;
alter table public.job_results                 enable row level security;
alter table public.recommendations             enable row level security;
alter table public.fsn_intelligence            enable row level security;
alter table public.intelligence_processed_jobs enable row level security;

-- ─────────────────────────────────────────────────────────── read policies

drop policy if exists jobs_read on public.jobs;
create policy jobs_read on public.jobs
  for select to anon, authenticated using (true);

drop policy if exists job_inputs_read on public.job_inputs;
create policy job_inputs_read on public.job_inputs
  for select to anon, authenticated using (true);

drop policy if exists job_results_read on public.job_results;
create policy job_results_read on public.job_results
  for select to anon, authenticated using (true);

drop policy if exists recommendations_read on public.recommendations;
create policy recommendations_read on public.recommendations
  for select to anon, authenticated using (true);

drop policy if exists fsn_intelligence_read on public.fsn_intelligence;
create policy fsn_intelligence_read on public.fsn_intelligence
  for select to anon, authenticated using (true);

-- intelligence_processed_jobs is bookkeeping for the sync job. Nothing in the
-- UI reads it, so it gets no policy at all and stays service-role-only.

-- ────────────────────────────────────────────────────────────────── grants

-- Supabase's default privileges usually cover these; stated explicitly so the
-- schema is self-contained if it is ever applied to a plain Postgres.
grant usage on schema public to anon, authenticated;

grant select on
  public.jobs,
  public.job_inputs,
  public.job_results,
  public.recommendations,
  public.fsn_intelligence,
  public.job_rows_v,
  public.job_stats_v
to anon, authenticated;

revoke all on public.intelligence_processed_jobs from anon, authenticated;

grant execute on function public.job_analytics(text, text) to anon, authenticated;

-- ──────────────────────────────────────────────────────────────── realtime

-- What the dashboard subscribes to in place of the old in-process SSE bus:
-- `jobs` carries state / stats / progress, `job_results` carries each product
-- as it lands. Realtime honours the SELECT policies above, so the anon key sees
-- exactly what it can already read over REST.
--
-- Guarded because adding a table twice is an error, and migrations are re-run.
do $do$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jobs'
  ) then
    alter publication supabase_realtime add table public.jobs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'job_results'
  ) then
    alter publication supabase_realtime add table public.job_results;
  end if;
end
$do$;
