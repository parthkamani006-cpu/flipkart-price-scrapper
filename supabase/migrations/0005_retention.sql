-- 0005_retention.sql — keep the newest 30 batches per account.
--
-- Apply this LAST, and only once you are happy the rest works: it is the only
-- migration that deletes anything.
--
-- What it deletes: jobs beyond the newest 30 for an account, ordered by
-- created_at, and by cascade their inputs, results and recommendations.
--
-- What it never touches: fsn_intelligence and intelligence_processed_jobs.
-- That is the whole point of those two tables having no foreign key to jobs.
-- Before this migration existed, the intelligence store could be thrown away
-- and rebuilt by replaying every job folder on disk. Once batches are being
-- pruned that replay is lossy, so the learning has to be authoritative in its
-- own right and outlive the batch it came from.

create or replace function public.prune_jobs(p_keep integer default 30)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_count integer;
begin
  with ranked as (
    select id,
           row_number() over (partition by account_name order by created_at desc) as rn
      from public.jobs
     -- Never prune work that is queued or in flight. A batch waiting for the
     -- next worker has not run yet; deleting it would silently drop an upload.
     where state not in ('queued', 'running', 'pausing', 'stopping')
  )
  delete from public.jobs j
   using ranked
   where j.id = ranked.id
     and ranked.rn > p_keep;

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

revoke execute on function public.prune_jobs(integer) from anon, authenticated, public;

-- ─────────────────────────────────────────────────── schedule (DISABLED)
--
-- Retention no longer runs on a timer. Pruning is a manual step now, same as
-- the scraper batches: run
--
--     select public.prune_jobs(30);
--
-- from the Supabase SQL editor whenever the job list gets long. prune_jobs()
-- itself is untouched above — only its trigger is gone.
--
-- The block below removes the pg_cron entry if a previous version of this file
-- installed one. It is guarded twice: the `where exists` skips a database that
-- never had the job, and the exception handler covers a project where pg_cron
-- is not installed at all, so this is safe to apply to a fresh database and
-- safe to re-run on an existing one.

do $do$
begin
  perform cron.unschedule('prune-jobs')
    where exists (select 1 from cron.job where jobname = 'prune-jobs');

  raise notice 'prune-jobs cron entry removed (if it existed). Run select public.prune_jobs(30); by hand.';
exception
  when others then
    raise notice 'pg_cron not available (%); nothing to unschedule.', sqlerrm;
end
$do$;

-- The original daily schedule, kept for reference. Uncomment
-- this block (and drop the unschedule above) to put retention back on a timer.
-- 19:00 UTC = 00:30 IST, i.e. after both daily batches would have finished.
--
-- do $do$
-- begin
--   create extension if not exists pg_cron;
--
--   perform cron.unschedule('prune-jobs')
--     where exists (select 1 from cron.job where jobname = 'prune-jobs');
--
--   perform cron.schedule('prune-jobs', '0 19 * * *', $cron$select public.prune_jobs(30);$cron$);
--
--   raise notice 'prune_jobs(30) scheduled daily at 19:00 UTC (00:30 IST).';
-- exception
--   when others then
--     raise notice 'pg_cron not available (%). Run select public.prune_jobs(30); yourself.', sqlerrm;
-- end
-- $do$;
