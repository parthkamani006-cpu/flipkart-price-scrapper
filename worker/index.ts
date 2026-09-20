/**
 * The scraper worker.
 *
 * Runs as a standalone Node process — in GitHub Actions on a schedule, or
 * locally against the same database for testing. It is the only part of the
 * system that opens a browser, and it never runs inside a web request: a batch
 * takes about half an hour, which is orders of magnitude past any serverless
 * timeout and is the reason the scraper left the Next.js app.
 *
 *   npm run worker              # take the oldest queued batch
 *   npm run worker -- --job X   # take a specific one
 *
 * Exit codes: 0 for "did the work, or found none to do"; 1 only for a failure
 * a person needs to look at. An idle scheduled run with an empty queue is a
 * green tick, not a red one.
 */

// First, and for its side effect: it loads a local .env before anything else in
// the graph is evaluated. See the note in that file for why it is not just a
// `dotenv.config()` call at the top of this one.
import './dotenv';

import { createClient } from '@supabase/supabase-js';
import { claimJob, LEASE_SECONDS, reapStaleJobs, releaseJob } from '@/lib/store/lease';
import { readEnv } from './env';
import { runBatch } from './run';

async function main(): Promise<number> {
  const env = readEnv();

  // The service-role client. Everything in lib/store reaches for this same
  // client through supabaseAdmin(), which reads the same two variables, so
  // setting them is all the wiring the store layer needs.
  const db = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Before claiming anything, notice batches whose worker died. This is the
  // moment that matters for recovery: a previous run that was cancelled or ran
  // out of memory left its row saying `running` with a lease nobody is
  // extending, and without this the batch could never be claimed again.
  const reaped = await reapStaleJobs();
  if (reaped > 0) console.log(`[worker] marked ${reaped} stale batch(es) as interrupted`);

  const manifest = await claimJob(env.jobId, env.owner, LEASE_SECONDS);

  if (!manifest) {
    // Two ways to get here, both fine. A scheduled run found an empty queue, or
    // another runner claimed the batch first — the conditional UPDATE behind
    // claimJob is what makes the second case safe rather than a double scrape.
    console.log(
      env.jobId
        ? `[worker] nothing to do: ${env.jobId} is not queued, or another runner already claimed it.`
        : '[worker] nothing to do: no batch is queued.',
    );
    return 0;
  }

  console.log(`[worker] claimed ${manifest.id} — "${manifest.name}" (${manifest.accountName ?? 'no account'})`);
  const startedAt = Date.now();

  try {
    const outcome = await runBatch(db, manifest, env);

    await releaseJob(manifest.id, env.owner, outcome.state, outcome.error);

    const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
    console.log(
      `[worker] ${manifest.id} finished as ${outcome.state}: ` +
        `${outcome.completed} of ${outcome.pendingAtStart} product(s) in ${minutes} min`,
    );

    // A failed scrape is worth a red run even though the batch state already
    // records it — a workflow that is always green is a workflow nobody checks.
    return outcome.error ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[worker] ${manifest.id} failed: ${message}`);

    // Best effort: hand the batch back so it is resumable rather than stuck
    // holding a lease until the next run reaps it. If even this fails, the
    // reaper is the backstop.
    await releaseJob(manifest.id, env.owner, 'interrupted', message).catch(() => undefined);
    return 1;
  }
}

/**
 * Signals.
 *
 * GitHub sends SIGTERM when a workflow is cancelled or times out. There is no
 * useful cleanup to do — every completed product is already a committed row,
 * and the lease expiring is exactly how the next run learns this one died — so
 * the honest response is to say so and leave, rather than to pretend a graceful
 * shutdown that would need database writes the runner may not be alive for.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(
      `[worker] received ${signal}. Completed products are already saved; the batch will be ` +
        `marked interrupted once its lease expires, and can be resumed from the dashboard.`,
    );
    process.exit(130);
  });
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[worker] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
