# Deployment

Three things to set up, in this order: **Supabase**, then **Vercel**, then **GitHub
Actions**. Each depends on values from the one before it.

Nothing here needs your PC to stay on. That is the point of the whole arrangement.

---

## 1. Supabase

### Create the project

1. <https://supabase.com/dashboard> → **New project**.
2. Pick a region close to you — `ap-south-1` (Mumbai) if you are in India. Every dashboard
   read is a round trip to it.
3. Save the database password somewhere; you will not need it for this app, but you will
   need it if you ever use the CLI.

### Apply the schema

Open **SQL Editor** and run the files in `supabase/migrations/` **in order**, one at a
time, checking each succeeds before the next:

| File | What it does |
|---|---|
| `0001_schema.sql` | The tables: `jobs`, `job_inputs`, `job_results`, `recommendations`, `fsn_intelligence`, `intelligence_processed_jobs`. |
| `0002_views.sql` | `job_rows_v` (the input/result join the UI renders), `job_stats_v` (the counts), and `job_analytics()`. |
| `0003_rls.sql` | Row level security, the grants, and adding `jobs` + `job_results` to the Realtime publication. |
| `0004_claim.sql` | `claim_job()`, `heartbeat_job()`, `release_job()`, `reap_stale_jobs()` — the lease. |
| `0005_retention.sql` | The 30-batches-per-account prune. It is the only migration that deletes anything — apply it only once the rest works. |
| `0006_source_api.sql` | Widens the `job_results.source` check to allow `'api'`. **Apply before running a worker built after the seller-API change**, or every result it produces is rejected by the constraint and lost. |
| `0007_upload_staging.sql` | Creates the private, temporary Storage bucket used for direct spreadsheet uploads. **Required before deploying the large-upload change.** |

`0005` no longer schedules anything: the nightly pg_cron entry is commented out and the file
unschedules an existing `prune-jobs` entry if a previous version installed one. Run
`select public.prune_jobs(30);` from the SQL editor when the job list gets long. Retention is
tidy-up, not a correctness rule.

### Collect the keys

**Project Settings → API**:

- **Project URL** → `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_URL`
- **anon / public** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- **service_role** → `SUPABASE_SERVICE_ROLE_KEY`

The service-role key bypasses RLS entirely. It belongs in exactly two places — Vercel's
server-side environment and GitHub Actions secrets — and nowhere else. Never give it a
`NEXT_PUBLIC_` prefix; that prefix is what puts a value in the browser bundle.

### What the anon key can do, and what that means

RLS grants `anon` **SELECT and nothing else**, on `jobs`, `job_inputs`, `job_results`,
`recommendations` and `fsn_intelligence`. Every write goes through a route or the worker
holding the service-role key.

Be clear-eyed about the read half: the anon key ships in the browser bundle and the app has
no login, so **anyone with your Vercel URL can read every batch, SKU, FSN, seller name and
price**. Nothing in this configuration prevents that; the only thing standing between the
data and the world is nobody guessing the URL. This was a deliberate choice for simplicity.

If you later want it private, it is a contained change: add a Supabase Auth login page and
swap `to anon` for `to authenticated` in `0003_rls.sql`.

---

## 2. Vercel

1. <https://vercel.com/new> → import the repository.
2. Framework preset: **Next.js**. Nothing else needs changing — no build command override,
   no output directory.
3. Set the environment variables below for **Production, Preview and Development**.

| Variable | Value | Exposed to browser? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL | Yes, by design |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key | Yes, by design |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key | **No** |
| `GITHUB_DISPATCH_TOKEN` | the PAT from step 3 | **No** |
| `GITHUB_REPO` | `your-user/flipkart-price-scrapper` | No |
| `ANALYTICS_TIMEZONE` | optional, default `Asia/Kolkata` | No |
| `IP_ALLOWLIST` | optional — restricts who can open the app, see below | No |

Playwright is a devDependency, so Vercel's production install never downloads Chromium and
no route imports it. If you see Playwright in a Vercel build log, something has imported the
scraper into the app by accident.

### Large spreadsheet uploads

The dashboard does not send spreadsheets through Vercel. It first asks the app for short-lived
Supabase Storage upload tokens, uploads each selected XLS/XLSX directly to the private
`upload-staging` bucket, and then sends only the two object references to the validation route.
That avoids Vercel's request-body limit (the source of HTTP 413 responses) without changing the
two-file validation or batch-creation flow. The files are deleted as soon as validation finishes.

The bucket migration intentionally sets no application-level file-size limit. The effective
ceiling is the Supabase Storage/project plan and the Vercel function memory/time needed to parse
the workbook; no hosted service can promise an unbounded file size. For very large or slow-to-
parse exports, use a Supabase/Vercel plan with sufficient Storage capacity and function resources.

`ANALYTICS_TIMEZONE` decides the buckets on the products-per-hour chart. It has a default
because the old code used the serving machine's local clock, which on Vercel would silently
have become UTC and shifted every bar.

---

## 2b. Restricting access by IP

The dashboard has no login. Anyone with the URL can queue scrape jobs, read competitor
pricing and export it. `IP_ALLOWLIST` is the front door: set it in the Vercel project env
and only those addresses reach the app at all — pages, API routes and JS bundles alike.
Everyone else gets a 403 from `middleware.ts` before any route runs.

**Leave it unset and the gate is open.** The feature is opt-in, so a fresh clone and local
development keep working untouched.

### Setting it

Find the address you want to allow (<https://ifconfig.me>), then in Vercel → Settings →
Environment Variables add `IP_ALLOWLIST`:

```
203.0.113.7, 198.51.100.0/24 # office, 2001:db8::/32
```

IPv4 or IPv6, bare or CIDR, separated by commas or newlines, `#` starts a comment. A bare
address is an exact match (a /32 or /128). Entries that do not parse are logged and skipped
rather than crashing the middleware — one typo costs you that entry, not the whole site.

**Environment variable changes only take effect on the next deployment.** After saving the
variable, redeploy from the Vercel dashboard.

### Do not lock yourself out

Home broadband is usually a *dynamic* address — the ISP can rotate it without warning, and
a bare host entry will then shut you out of your own dashboard. Safer choices, in order:

- a static-IP VPN, or the office's fixed address;
- the ISP's block rather than the single host, e.g. `203.0.113.0/24` — less precise, but it
  survives a rotation;
- a bare address only when you know it is static.

If it does happen, nothing is lost: the Vercel dashboard is not behind the allowlist. Edit
`IP_ALLOWLIST` there and redeploy.

### What it does not cover

- **Vercel only.** The GitHub Actions worker talks to Supabase directly and never calls this
  app, so the allowlist does not affect scraping. Supabase has its own network restrictions
  if you want the same treatment for the database.
- **Not a replacement for keeping the service-role key secret.** An allowed address still
  has full run of the app.
- Loopback (`127.0.0.0/8`, `::1`) is always allowed — that is `next dev` talking to itself.
  A remote client cannot forge it: on Vercel the address comes from the TCP connection via
  `x-vercel-forwarded-for`, not from a header the caller controls.

Run `npm run test:ip` to exercise the matching rules.

---

## 3. GitHub Actions

### Repository secrets

**Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Required | Value |
|---|---|---|
| `SUPABASE_URL` | yes | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase service_role key |
| `PROXY_URL` | no | e.g. `http://user:pass@proxy.example.com:8000` — see below |
| `PROXY_USERNAME` | no | if not embedded in the URL |
| `PROXY_PASSWORD` | no | if not embedded in the URL |

### The dispatch token, so Start works from the dashboard

Without this the dashboard still queues batches — but nothing picks them up on its own now
that the schedule is off, so you would have to start the workflow from the Actions tab. The
response says which happened, so you will not be left guessing.

1. <https://github.com/settings/personal-access-tokens/new> → **Fine-grained token**.
2. **Repository access**: only this repository.
3. **Permissions**: `Contents: Read-only` and `Actions: Read and write`. Nothing else.
4. Set an expiry you will actually notice, and put the token in Vercel as
   `GITHUB_DISPATCH_TOKEN`.

It is used from one server-side module (`lib/services/githubDispatch.ts`) and never reaches
the browser.

### The schedule (off)

There is no automatic run. The `schedule:` trigger in `.github/workflows/scraper.yml` is
commented out — batches only start when the dashboard's Start button dispatches the
workflow, or when you run it yourself from the Actions tab.

To put it back, uncomment the block at the top of that file. It was `30 3,15 * * *` UTC —
09:00 and 21:00 IST, and India has no daylight saving, so those do not drift. Two things
about GitHub's scheduler that are worth knowing before you re-enable it:

- It is best-effort and routinely runs **5–20 minutes late** under load.
- A scheduled workflow in a public repository is **disabled automatically after 60 days**
  with no repository activity. If batches quietly stop running, check this first.

Either way a run does not invent work: it takes the oldest **queued** batch, and exits 0
with "nothing to do" if there is none. An empty run is a green tick.

### Running it by hand

**Actions → Scraper → Run workflow**. The optional `job_id` input targets one batch; leave
it empty to take the oldest queued one.

---

## Local development

```bash
npm install
npx playwright install chromium     # only if you will run the scraper locally
cp .env.example .env.local          # fill in the Supabase values
npm run dev                         # http://localhost:3000
```

`.env.local` needs the two `NEXT_PUBLIC_*` variables and `SUPABASE_SERVICE_ROLE_KEY`. Do not
put `GITHUB_DISPATCH_TOKEN` in it unless you actually want a local Start button to fire a
real GitHub Actions run.

### Running the worker locally

Useful for watching a batch scrape without waiting on a runner. It talks to the same
database, so a batch you queue in the deployed dashboard can be scraped from your desk:

```bash
npm run worker                  # take the oldest queued batch
npm run worker -- --job job_x   # take a specific one
```

It reads `.env.local` then `.env`. It claims a lease exactly as the Actions runner does, so
the two cannot collide — whoever claims first gets the batch.

### The scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | the Next.js app |
| `npm run worker` | the scraper worker |
| `npm run scrape` | the standalone CLI, journal on disk, no database |
| `npm run verify` | 45 selector assertions against the checked-in HTML snapshots |
| `npm run test:store` | mappers, stats arithmetic, filter translation — no database needed |
| `npm run test:recommendation` | the settlement and recommendation maths |
| `npm run test:width` | the pool-width controller |
| `npm run typecheck` / `:worker` / `:scraper` | all three projects |

---

## Verifying it works, end to end

1. **Schema.** In the SQL editor: `select * from public.job_stats_v limit 1;` should return
   no rows and no error.
2. **The app reads.** Open the deployed dashboard. An empty batch list means the anon key
   and RLS are working; an error means one of them is not.
3. **Create a batch.** Upload the two spreadsheets. `select count(*) from job_inputs;`
   should match the row count you were shown.
4. **Start it.** The batch should go to **Queued** and the response should say a runner was
   triggered. Check **Actions** for a run that started within seconds.
5. **Watch it.** Rows should appear in the queue table without refreshing the page. If they
   only appear on refresh, Realtime is not connected — check that `0003_rls.sql`'s
   publication block ran, and that the two `NEXT_PUBLIC_*` values are set.
6. **Pause and Stop.** Both should take effect within a few seconds. Pause leaves the batch
   **Paused** with results saved; Resume should pick up exactly where it left off.
7. **Kill a run.** Cancel the workflow mid-batch. Within 15 minutes the batch should become
   **Interrupted** (or immediately, on the next worker start) and Resume should work.

---

## Known limitations

- **The data is publicly readable.** Covered above under RLS. It is a choice, not an
  oversight, but it is the one thing here most worth revisiting.
- **Flipkart may block the runner's IP.** GitHub's runners are Azure datacentre addresses,
  which e-commerce sites commonly treat as suspect. The symptom is a batch that stops early
  with `BLOCKED` rows; the fix is the `PROXY_URL` secret, which needs no code change. This
  has not been tested against Flipkart from a runner.
- **Start is not instant.** A runner boots and installs Chromium first — a minute or so.
- **Pause and Stop are requests.** The worker checks every three seconds and then has to
  wind down; a page already waiting on Flipkart takes a moment longer to release.
- **No failure screenshots and no stored logs.** Both were deliberately dropped. Log lines
  are in the Actions run's console output, and per-product `status` and `message` are in the
  database.
- **Free-tier limits.** Supabase free tier pauses a project after a week with no activity,
  which would stop a run from finding a database. With the schedule off, nothing keeps the
  project warm on its own — a long quiet period will pause it.
- **Existing local data was not migrated.** The 40 batches under `data/` are untouched and
  are not visible in the deployed dashboard. Supabase starts empty.
