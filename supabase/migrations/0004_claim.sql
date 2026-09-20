-- 0004_claim.sql — the lease.
--
-- Replaces `globalThis.__jobRunner.active`, which was a single in-process slot
-- and therefore meaningless the moment the scraper moved to another machine.
--
-- Two GitHub Actions runs can start within seconds of each other (a scheduled
-- run and a repository_dispatch from the dashboard, say). The workflow's
-- `concurrency: scraper` group makes that rare; this makes it impossible. A
-- claim is one conditional UPDATE, so the loser gets zero rows back and exits.
--
-- All four functions are service-role only — no execute grant to anon.

-- ────────────────────────────────────────────────────────────────── claim

-- Claim a specific job, or the oldest queued one when p_job_id is null.
-- Returns the claimed row, or nothing at all when there was nothing to take.
create or replace function public.claim_job(
  p_job_id        text default null,
  p_owner         text default 'unknown',
  p_lease_seconds integer default 900
)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id text;
begin
  -- `for update skip locked` is what makes two simultaneous claims safe: the
  -- second transaction skips the row the first has locked rather than waiting
  -- on it and then overwriting the winner's lease.
  select j.id into v_id
    from public.jobs j
   where j.state = 'queued'
     -- A STOP or PAUSE requested while the job sat in the queue is honoured by
     -- the API without a worker (nothing is running to interrupt), so a worker
     -- should only ever pick up work that is still asking to run.
     and j.requested_action = 'RUN'
     and (j.lease_expires_at is null or j.lease_expires_at < now())
     and (p_job_id is null or j.id = p_job_id)
   order by j.created_at
   limit 1
   for update skip locked;

  if v_id is null then
    return;
  end if;

  return query
  update public.jobs
     set state            = 'running',
         started_at       = coalesce(started_at, now()),
         finished_at      = null,
         interrupted_at   = null,
         error            = null,
         error_at         = null,
         lease_owner      = p_owner,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at     = now()
   where id = v_id
  returning *;
end;
$fn$;

-- ────────────────────────────────────────────────────────────── heartbeat

-- Extends the lease. Returns false when the lease is no longer ours — which
-- means something reaped or re-claimed the job, and the worker should stop
-- writing rather than race whoever holds it now.
create or replace function public.heartbeat_job(
  p_job_id        text,
  p_owner         text,
  p_lease_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_updated integer;
begin
  update public.jobs
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at     = now()
   where id = p_job_id
     and lease_owner = p_owner
     and state in ('running', 'pausing', 'stopping');

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$fn$;

-- ──────────────────────────────────────────────────────────────── release

-- The terminal write. Clears the lease so the row can never look busy after the
-- worker is gone, and resets requested_action so a job stopped once does not
-- refuse to start next time.
create or replace function public.release_job(
  p_job_id text,
  p_owner  text,
  p_state  text,
  p_error  text default null
)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return query
  update public.jobs
     set state            = p_state,
         finished_at      = case when p_state in ('completed','stopped','paused') then now() else finished_at end,
         interrupted_at   = case when p_state = 'interrupted' then now() else interrupted_at end,
         error            = p_error,
         error_at         = case when p_error is null then null else now() end,
         requested_action = 'RUN',
         progress         = '[]'::jsonb,
         lease_owner      = null,
         lease_expires_at = null
   where id = p_job_id
     and (lease_owner = p_owner or lease_owner is null)
  returning *;
end;
$fn$;

-- ───────────────────────────────────────────────────────────────── reaping

-- Crash recovery. Replaces lib/services/recovery.ts, which inferred the same
-- thing from a globalThis flag at process boot.
--
-- A worker that dies mid-batch — an OOM kill, a cancelled workflow, a runner
-- yanked out from under it — leaves the row saying `running` with a lease that
-- then simply stops being extended. Anything past its lease is not running; it
-- is interrupted, and the dashboard already treats `interrupted` as resumable.
-- Results already written are untouched, so resuming picks up exactly where the
-- journal used to let it.
create or replace function public.reap_stale_jobs()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_count integer;
begin
  update public.jobs
     set state          = 'interrupted',
         interrupted_at = now(),
         error          = coalesce(error,
           'Worker stopped reporting. The run was interrupted; resume to finish the remaining products.'),
         error_at       = coalesce(error_at, now()),
         progress       = '[]'::jsonb,
         lease_owner      = null,
         lease_expires_at = null
   where state in ('running', 'pausing', 'stopping')
     and (lease_expires_at is null or lease_expires_at < now());

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- Service-role only. The anon key must not be able to steal or clear a lease.
revoke execute on function public.claim_job(text, text, integer)     from anon, authenticated, public;
revoke execute on function public.heartbeat_job(text, text, integer) from anon, authenticated, public;
revoke execute on function public.release_job(text, text, text, text) from anon, authenticated, public;
revoke execute on function public.reap_stale_jobs()                   from anon, authenticated, public;
