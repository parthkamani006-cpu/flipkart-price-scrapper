/**
 * Everything the worker reads from its environment, in one place.
 *
 * The worker is the only process holding the service-role key, so it is worth
 * being explicit about what it expects and failing with a sentence a person can
 * act on rather than a stack trace from three modules deep.
 */

import { hostname } from 'node:os';
import type { ScraperOptions } from '@/scraper/types';

/**
 * A ceiling on browser contexts, applied on top of whatever the batch asked for.
 *
 * A batch created in the dashboard defaults to 20 workers, a number chosen for
 * a desktop with cores and memory to match. A GitHub Actions runner is four
 * cores and 16 GB shared with Chromium itself, and the README's own measurement
 * is that a pool wider than the host retires *fewer* products per second while
 * stretching each one — which is how machine load turns into
 * SELLER_LIST_LOAD_FAILED rows rather than into speed.
 *
 * So the batch's setting is honoured up to this, and clamped past it. Changing
 * the ceiling is one line of workflow YAML; it needs no code change and no
 * migration of existing batches.
 */
const DEFAULT_MAX_CONCURRENCY = 8;

/**
 * Requests per second the pool may make, across all its workers.
 *
 * Flipkart meters the seller endpoint per IP, and a runner is an Azure
 * datacentre address, which is metered harder than a home connection: the same
 * batch that ran clean for 200 products locally was refused after 70-80 there.
 * The limiter adapts down from this on its own when a 429 arrives, so this is a
 * starting rate rather than a promise — but starting low on a host known to be
 * treated harshly is free, and starting high costs a stall.
 *
 * Change this line, or the WORKER_MAX_RPS variable in the workflow, not the code.
 */
const DEFAULT_MAX_RPS = 2.5;

export interface WorkerEnv {
  supabaseUrl: string;
  serviceRoleKey: string;
  /** The specific batch to run, or null to take the oldest queued one. */
  jobId: string | null;
  maxConcurrency: number;
  /** Pool-wide request ceiling. See DEFAULT_MAX_RPS. */
  maxRequestsPerSecond: number;
  proxy: ScraperOptions['proxy'];
  /**
   * Who holds the lease. Identifies this run in the batch row, so a stale lease
   * can be told apart from a live one and a person can find the workflow run
   * that wrote it.
   */
  owner: string;
}

class MissingEnv extends Error {
  constructor(name: string) {
    super(
      `${name} is not set. The worker needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; ` +
        `in GitHub Actions those come from repository secrets, and locally from a .env file ` +
        `(see .env.example).`,
    );
    this.name = 'MissingEnv';
  }
}

export function readEnv(argv: string[] = process.argv.slice(2)): WorkerEnv {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) throw new MissingEnv('SUPABASE_URL');

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) throw new MissingEnv('SUPABASE_SERVICE_ROLE_KEY');

  return {
    supabaseUrl,
    serviceRoleKey,
    jobId: readJobId(argv),
    maxConcurrency: readMaxConcurrency(),
    maxRequestsPerSecond: readMaxRps(),
    proxy: readProxy(),
    owner: readOwner(),
  };
}

/**
 * `--job <id>` beats `JOB_ID`, and either beats "whatever is queued".
 *
 * The workflow sets JOB_ID from the repository_dispatch payload or the manual
 * input, and leaves it empty on a scheduled run — which is why an empty string
 * has to read as "unset", not as a job id of "".
 */
function readJobId(argv: string[]): string | null {
  const flagIndex = argv.indexOf('--job');
  if (flagIndex !== -1 && argv[flagIndex + 1]) return argv[flagIndex + 1];

  const inline = argv.find((arg) => arg.startsWith('--job='));
  if (inline) return inline.slice('--job='.length) || null;

  return process.env.JOB_ID?.trim() || null;
}

function readMaxConcurrency(): number {
  const raw = Number(process.env.WORKER_MAX_CONCURRENCY);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_CONCURRENCY;
  return Math.min(Math.trunc(raw), 20);
}

function readMaxRps(): number {
  const raw = Number(process.env.WORKER_MAX_RPS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_RPS;
  // Capped: above Flipkart's own refill rate the limiter would just spend the
  // batch discovering the ceiling by being refused at it.
  return Math.min(raw, 8);
}

function readProxy(): ScraperOptions['proxy'] {
  const server = process.env.PROXY_URL?.trim();
  if (!server) return undefined;

  return {
    server,
    username: process.env.PROXY_USERNAME?.trim() || undefined,
    password: process.env.PROXY_PASSWORD || undefined,
  };
}

/**
 * A lease owner that means something when read back.
 *
 * In Actions this is the run and attempt, so a stuck lease points straight at
 * the workflow run that left it. Locally it is host and pid, which is enough to
 * tell two terminals apart.
 */
function readOwner(): string {
  const runId = process.env.GITHUB_RUN_ID;
  if (runId) {
    const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
    return `gh-actions:${runId}:${attempt}`;
  }
  return `local:${hostname()}:${process.pid}`;
}
