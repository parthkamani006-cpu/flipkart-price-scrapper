/**
 * Running one batch.
 *
 * This is the port of `JobRunner.execute()`. The scraping logic underneath is
 * untouched — same `scrapeProducts`, same options, same pool — because the
 * point of the migration was to move where the work happens and where its
 * output goes, not to change what it does.
 *
 * What is different is every edge:
 *
 *  - Pending work comes from a LEFT JOIN, not a journal file.
 *  - A result is an INSERT, not an appended NDJSON line.
 *  - Progress is a throttled column write, not an in-process event.
 *  - Logs go to stdout only, which in GitHub Actions means the run's console
 *    log. There is no job_logs table.
 *  - Stop and Pause come from a polled column, not a field on an object the
 *    API route could reach.
 *  - No screenshots. The runner's filesystem does not outlive the run.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { scrapeProducts } from '@/scraper/scraper';
import { setVerbose } from '@/scraper/utils';
import type { ScrapeInput } from '@/scraper/types';
import { generateRecommendations } from '@/lib/services/recommendations';
import { countPending, pendingInputs, prepareForRun, recordResult } from '@/lib/store/jobStore';
import type { JobManifest, JobState, LiveProgress } from '@/types/dashboard';
import { startControlLoop } from './control';
import { ProgressReporter } from './progress';
import type { WorkerEnv } from './env';

export interface RunOutcome {
  state: JobState;
  error: string | null;
  completed: number;
  pendingAtStart: number;
}

export async function runBatch(
  db: SupabaseClient,
  manifest: JobManifest,
  env: WorkerEnv,
): Promise<RunOutcome> {
  const jobId = manifest.id;

  // BLOCKED describes the bot wall, not the product, so it was never an answer.
  // Dropping those results turns the rows back into pending ones — the same
  // rule the CLI's --resume applies when it heals a journal.
  const retried = await prepareForRun(jobId);
  if (retried > 0) console.log(`[worker] retrying ${retried} product(s) that ended BLOCKED`);

  const pending = await pendingInputs(jobId);
  if (pending.length === 0) {
    return { state: 'completed', error: null, completed: 0, pendingAtStart: 0 };
  }

  const options = manifest.options;
  const concurrency = Math.max(1, Math.min(options.concurrency || 1, env.maxConcurrency));
  if (concurrency < options.concurrency) {
    console.log(
      `[worker] batch asks for ${options.concurrency} workers; capping at ${concurrency} ` +
        `(WORKER_MAX_CONCURRENCY). A pool wider than the runner retires fewer products per ` +
        `second, not more.`,
    );
  }

  console.log(
    `[worker] ${pending.length} product(s) to scrape of ${manifest.total}, ${concurrency} worker(s), ` +
      `up to ${env.maxRequestsPerSecond} req/s pool-wide` +
      (env.proxy ? ', through a proxy' : ''),
  );

  const progress = new ProgressReporter(db, jobId);
  const control = startControlLoop(db, jobId, env.owner, (message) => console.log(`[worker] ${message}`));

  // The scraper hands `onStep` the input object it was given, so identity is
  // the join back to the uploaded row position. `onResult` gets the index into
  // this same array, which is the other half of the same mapping.
  const inputs: ScrapeInput[] = pending.map((entry) => entry.input);
  const idxOf = new Map<ScrapeInput, number>(pending.map((entry) => [entry.input, entry.idx]));

  let completed = 0;
  let failure: string | null = null;

  // Verbose console output, no sink: the sink existed to feed the dashboard's
  // log viewer, and there is no longer a log table for it to write to. Straight
  // to stdout is what makes the GitHub Actions console log the run's narrative.
  setVerbose(true);

  try {
    await scrapeProducts(
      inputs,
      {
        delayMs: options.delayMs,
        delayJitterMs: options.delayJitterMs,
        timeout: options.timeout,
        blockBackoffMs: options.blockBackoffMs,
        blockRetries: options.blockRetries,
        concurrency,
        // Pool-wide, and the setting that actually paces a batch now that a
        // product is one request rather than three page loads. See
        // WorkerEnv.maxRequestsPerSecond.
        maxRequestsPerSecond: env.maxRequestsPerSecond,
        blockResources: options.blockResources,
        useNetworkCapture: options.useNetworkCapture,
        // `headed` is a local convenience for watching the browser work. There
        // is no display on a runner, so it is ignored rather than honoured.
        headless: true,
        verbose: true,
        proxy: env.proxy,
        // Deliberately unset: see the note on ScraperOptions.screenshotOnFailureDir.
        screenshotOnFailureDir: undefined,
        signal: control.signal,
        shouldStop: () => control.intent() !== 'run',
        onStep: (step, input, workerId) => {
          const idx = idxOf.get(input);
          if (idx === undefined) return;

          const previous = progress.snapshot().find((entry) => entry.workerId === workerId);
          const live: LiveProgress = {
            jobId,
            workerId,
            rowIndex: idx,
            sku: input.sku,
            fsn: input.fsn,
            targetSeller: input.targetSeller,
            productUrl: input.productUrl,
            step,
            startedAt: previous?.rowIndex === idx ? previous.startedAt : new Date().toISOString(),
            browserStatus: 'scraping',
          };
          progress.set(workerId, live);
        },
      },
      async (result, index) => {
        const idx = pending[index]?.idx;
        if (idx === undefined) return;

        // One row, written before the next product starts. This is the only
        // durable output of the run and the reason an interrupted batch loses
        // nothing but whatever was mid-flight.
        await recordResult(jobId, idx, result);
        completed += 1;

        // The worker that produced this result now holds nothing.
        const holder = progress.snapshot().find((entry) => entry.rowIndex === idx);
        if (holder) progress.clear(holder.workerId);
      },
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error(`[worker] run failed: ${failure}`);
  } finally {
    control.stop();
    await progress.finish();
  }

  const remaining = await countPending(jobId);
  const state = finalState({
    remaining,
    intent: control.intent(),
    leaseLost: control.leaseLost(),
    failed: failure !== null,
  });

  // Recommendations are written once, when a run ends, so that viewing an old
  // batch reads them back rather than re-deciding anything. Worth attempting
  // even on a partial run: the rows that did complete are scoreable.
  if (completed > 0) {
    try {
      const file = await generateRecommendations(jobId);
      if (file) console.log(`[worker] recommendations ready — ${file.summary}`);
    } catch (error) {
      // A failed recommendation write must not turn a completed scrape into a
      // failed batch; the results are already safe and the dashboard will
      // generate them on first view.
      console.warn(
        `[worker] could not write recommendations: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  return { state, error: failure, completed, pendingAtStart: pending.length };
}

/**
 * What state the batch ends in.
 *
 * Order matters. A lost lease means something else owns this batch now, so this
 * worker must not claim to have finished it. A user's Stop or Pause outranks a
 * scrape that also happened to fail, because that failure is usually the abort
 * itself. Everything left with pending work is `stopped` rather than
 * `completed` — the honest description of a run that gave up with work
 * remaining, and one the dashboard offers Resume from.
 */
function finalState(input: {
  remaining: number;
  intent: 'run' | 'pause' | 'stop';
  leaseLost: boolean;
  failed: boolean;
}): JobState {
  if (input.leaseLost) return 'interrupted';
  if (input.remaining === 0) return 'completed';
  if (input.intent === 'pause') return 'paused';
  if (input.intent === 'stop') return 'stopped';
  // Neither asked for: the scraper gave up on its own, which in practice means
  // it hit the bot wall and stopped rather than burn the rest of the batch
  // against it. Resumable, once the block has passed.
  return 'stopped';
}
