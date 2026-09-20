-- 0006_source_api.sql — allow 'api' as a result's seller-list source.
--
-- The scraper now reads the seller list from the endpoint the /sellers page
-- itself calls, rather than rendering that page and scraping its cards. A row
-- produced that way records source='api', which the original CHECK constraint
-- would reject — and a rejected insert is a lost result, not a slow one, so
-- this has to be applied BEFORE a worker running the new scraper is started.
--
-- 'network' and 'dom' stay valid: 'dom' is still what the fallback path
-- records for products the API could not answer, and old rows keep their value.

alter table public.job_results
  drop constraint if exists job_results_source_check;

alter table public.job_results
  add constraint job_results_source_check
  check (source is null or source in ('network', 'dom', 'api'));
