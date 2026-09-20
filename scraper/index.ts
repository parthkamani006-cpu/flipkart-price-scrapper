/**
 * Public entry point + CLI.
 *
 *   npm run scrape -- --url "<productUrl>" --seller "AYANSHENTERPRISEE" --sku SKU1 --fsn FSN1
 *   npm run scrape -- --file inputs.json --out results.json --headed
 *
 * `inputs.json` is an array of { productUrl, targetSeller, sku, fsn }.
 *
 * Batch runs stream every result to an NDJSON journal as it completes, so a
 * crash mid-run loses nothing and `--resume` can pick up where it stopped.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  appendJournal,
  defaultJournalPath,
  loadResumableJournal,
  readJournal,
  resultKey,
} from './journal';
import { scrapeProduct, scrapeProducts } from './scraper';
import type { ScrapeInput, ScrapeResult, ScraperOptions } from './types';

export { scrapeProduct, scrapeProducts } from './scraper';
export * from './types';
export * from './journal';
export { comparePrice, parsePrice, normalizeSellerName, sellerNamesMatch } from './parser';
export { setLogSink, setVerbose, type LogLevel, type LogSink } from './utils';

/* -------------------------------------------------------------------- CLI */

interface CliArgs {
  url?: string;
  seller?: string;
  sku?: string;
  fsn?: string;
  file?: string;
  out?: string;
  headed: boolean;
  quiet: boolean;
  timeout?: number;
  maxShowMore?: number;
  network: boolean;
  concurrency?: number;
  noBlockResources: boolean;
  screenshotDir?: string;
  delay?: number;
  jitter?: number;
  blockBackoff?: number;
  blockRetries?: number;
  journal?: string;
  resume: boolean;
  noHuman: boolean;
  noBuyboxProbe: boolean;
  noSellerApi: boolean;
  rps?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    headed: false,
    quiet: false,
    network: false,
    noBlockResources: false,
    resume: false,
    noHuman: false,
    noBuyboxProbe: false,
    noSellerApi: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => argv[++i];

    switch (flag) {
      case '--url': args.url = next(); break;
      case '--seller': args.seller = next(); break;
      case '--sku': args.sku = next(); break;
      case '--fsn': args.fsn = next(); break;
      case '--file': args.file = next(); break;
      case '--out': args.out = next(); break;
      case '--headed': args.headed = true; break;
      case '--quiet': args.quiet = true; break;
      case '--timeout': args.timeout = Number(next()); break;
      case '--max-show-more': args.maxShowMore = Number(next()); break;
      case '--network': args.network = true; break;
      case '--concurrency': args.concurrency = Number(next()); break;
      case '--no-block-resources': args.noBlockResources = true; break;
      case '--screenshot-dir': args.screenshotDir = next(); break;
      case '--delay': args.delay = Number(next()); break;
      case '--jitter': args.jitter = Number(next()); break;
      case '--block-backoff': args.blockBackoff = Number(next()); break;
      case '--block-retries': args.blockRetries = Number(next()); break;
      case '--journal': args.journal = next(); break;
      case '--resume': args.resume = true; break;
      case '--no-human': args.noHuman = true; break;
      case '--no-buybox-probe': args.noBuyboxProbe = true; break;
      case '--no-seller-api': args.noSellerApi = true; break;
      case '--rps': args.rps = Number(next()); break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (flag.startsWith('--')) {
          console.error(`Unknown flag: ${flag}`);
          printUsage();
          process.exit(2);
        }
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`
Flipkart seller price comparison

  Single product:
    npm run scrape -- --url "<productUrl>" --seller "<sellerName>" --sku "<sku>" --fsn "<fsn>"

  Batch:
    npm run scrape -- --file inputs.json [--out results.json]

  Large batch (recommended for hundreds of products):
    npm run scrape -- --file inputs.json --out results.json --delay 1500 --resume

  Options:
    --headed              Run with a visible browser (useful for debugging).
    --quiet               Suppress progress logs; print only the JSON result.
    --timeout <ms>        Per-action timeout. Default 20000.
    --max-show-more <n>   Runaway guard on "Show More" clicks. Default 40.
    --network             Opt into seller network-payload capture. Off by default:
                          it resolved 0 of 1010 recorded products and costs a
                          buffered JSON body per seller-ish response.
    --screenshot-dir <d>  Write a screenshot here when a product fails.

  Speed:
    --concurrency <n>     Products scraped at once, each in its own context.
                          Default 3. Use 1 for strictly sequential behaviour.
    --no-block-resources  Load images, media and fonts too. They are dropped by
                          default; nothing the scraper reads comes from them.
    --no-seller-api       Render the /sellers page instead of reading the seller
                          list from the endpoint that page itself calls. The API
                          is on by default and is the batch's single biggest
                          saving: one request returns the headline price, the
                          buy-box listing and the complete seller list, so a
                          product needs no browser page at all — no PDP, no
                          hydration wait, no "Show More" paging. Turning it off
                          restores the old rendered pipeline exactly.
    --no-buybox-probe     Render every product page instead of first reading the
                          buy-box holder and price out of its raw HTML. Only ever
                          reached for products the seller API could not answer.

  Batch pacing and recovery:
    --rps <n>             Requests per second for the WHOLE pool, not per worker.
                          Default 3. Flipkart meters its seller endpoint per IP:
                          a large opening allowance, then a refill of about 4-5/s
                          and HTTP 429 past it — which is why a fast run feels
                          great for the first hundred products and then stalls.
                          The scraper halves this on any 429 and wins it back on a
                          clean streak, so it is a starting rate, not a promise.
    --delay <ms>          Pause between products. Default 0. Use ~1500 for 1000+ items.
    --jitter <ms>         Random extra pause, 0..n, on top of --delay. Default 400.
    --block-backoff <ms>  First pause after a captcha/rate-limit. Default 60000, doubling.
    --block-retries <n>   Back-offs before abandoning the run. Default 3.
    --journal <path>      NDJSON progress log. Default <out> with an .ndjson extension.
    --resume              Skip products already in the journal instead of clearing it.
    --no-human            Skip the ~0.5-3s of idle mouse/scroll activity between products.
`);
}

function toOptions(args: CliArgs): ScraperOptions {
  return {
    headless: !args.headed,
    verbose: !args.quiet,
    timeout: args.timeout,
    maxShowMoreClicks: args.maxShowMore,
    useNetworkCapture: args.network,
    concurrency: args.concurrency,
    blockResources: !args.noBlockResources,
    screenshotOnFailureDir: args.screenshotDir,
    delayMs: args.delay,
    delayJitterMs: args.jitter,
    blockBackoffMs: args.blockBackoff,
    blockRetries: args.blockRetries,
    humanLikeBehavior: !args.noHuman,
    buyboxProbe: !args.noBuyboxProbe,
    sellerApi: !args.noSellerApi,
    maxRequestsPerSecond: args.rps,
  };
}

function loadInputs(path: string): ScrapeInput[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON array of { productUrl, targetSeller, sku, fsn }.`);
  }
  return parsed as ScrapeInput[];
}

/* ------------------------------------------------------------------ journal */

/* The journal format, resume filter and healing rewrite live in ./journal.ts,
 * shared verbatim with the dashboard. There is one implementation of resume. */

/** Batch mode: journal-backed, resumable. Returns every row, old and new. */
async function runBatch(args: CliArgs, options: ScraperOptions): Promise<ScrapeResult[]> {
  const inputs = loadInputs(args.file as string);
  const journalPath = args.journal ?? defaultJournalPath(args.out);

  let done: ScrapeResult[] = [];

  if (args.resume) {
    const resumed = loadResumableJournal(journalPath);
    done = resumed.done;

    if (resumed.retrying > 0 && !args.quiet) {
      console.log(`Retrying ${resumed.retrying} product(s) that were blocked last run.`);
    }
  } else if (existsSync(journalPath)) {
    // Without --resume the journal describes a different run; keeping it would
    // silently merge two runs into one output file.
    console.warn(`  ! ${journalPath} exists and --resume was not passed — starting over. Pass --resume to continue it.`);
    rmSync(journalPath);
  }

  const seen = new Set(done.map(resultKey));
  const pending = inputs.filter((input) => !seen.has(resultKey(input)));

  if (!args.quiet) {
    console.log(`${inputs.length} input(s): ${done.length} already done, ${pending.length} to scrape.`);
    console.log(`Journalling to ${journalPath}`);
  }
  if (pending.length === 0) return done;

  await scrapeProducts(pending, options, (result) => appendJournal(journalPath, result));

  // Re-read rather than concatenating in memory: the journal is the record of
  // truth, and it is exactly what a later --resume will see.
  //
  // Sorted back into input order before it becomes the output file. The journal
  // is written in completion order, which under a worker pool is no longer input
  // order, and `--out` has always been "the inputs, with results attached". The
  // journal file itself is deliberately left as-is: its order is its append
  // history, and resume matches on key rather than position.
  const all = inInputOrder(readJournal(journalPath), inputs);
  if (!args.quiet) summarize(all, inputs.length, journalPath);
  return all;
}

/**
 * Order results the way the inputs file lists them.
 *
 * Rows the inputs no longer mention keep their relative order and follow at the
 * end, so a journal carrying results from an edited inputs file loses nothing.
 */
function inInputOrder(results: ScrapeResult[], inputs: ScrapeInput[]): ScrapeResult[] {
  const rank = new Map(inputs.map((input, index) => [resultKey(input), index]));
  return results
    .map((result, index) => ({ result, index, rank: rank.get(resultKey(result)) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.result);
}

/** Batch tail: what landed, and the command to finish the rest. */
function summarize(results: ScrapeResult[], inputCount: number, journalPath: string): void {
  const ok = results.filter((r) => r.status === 'OK').length;
  const unprocessed = inputCount - results.length;

  console.log(`\n${results.length}/${inputCount} processed — ${ok} OK, ${results.length - ok} failed.`);
  if (unprocessed > 0) {
    console.log(`${unprocessed} product(s) not reached. Resume with --resume (journal: ${journalPath}).`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const options = toOptions(args);
  let results: ScrapeResult[];

  if (args.file) {
    results = await runBatch(args, options);
  } else if (args.url && args.seller) {
    const input: ScrapeInput = {
      productUrl: args.url,
      targetSeller: args.seller,
      sku: args.sku ?? '',
      fsn: args.fsn ?? '',
    };
    results = [await scrapeProduct(input, options)];
  } else {
    printUsage();
    process.exit(2);
    return;
  }

  const json = JSON.stringify(args.file ? results : results[0], null, 2);
  if (args.out) {
    writeFileSync(args.out, json, 'utf8');
    if (!args.quiet) console.log(`\nWrote ${results.length} result(s) to ${args.out}`);
  } else {
    console.log(`\n${json}`);
  }

  // Non-zero exit when nothing succeeded, so CI and shell callers can branch.
  process.exit(results.some((r) => r.status === 'OK') ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
