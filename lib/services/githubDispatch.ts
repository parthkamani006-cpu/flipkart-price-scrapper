/**
 * Waking the scraper.
 *
 * Pressing Start used to launch Chromium inside the request that handled the
 * click. It cannot any more: the run takes half an hour and lives in GitHub
 * Actions. So Start does two things instead — queue the batch in Postgres, then
 * poke GitHub so a runner comes and takes it.
 *
 * The poke is a `repository_dispatch`, which needs a token. That token is a
 * fine-grained PAT scoped to this one repository with Contents: read and
 * Actions: write, it lives in Vercel's server-side environment, and it is used
 * only from this module — never sent to the browser, never in a NEXT_PUBLIC_
 * variable.
 *
 * Failing to dispatch is not failing to start. The batch is already queued, and
 * the twice-daily scheduled run drains the queue regardless, so a missing token
 * or a GitHub outage delays a batch rather than losing it. Callers surface that
 * distinction to the user instead of showing an error.
 */

export type DispatchOutcome =
  | { dispatched: true }
  | { dispatched: false; reason: string };

const EVENT_TYPE = 'run-scraper';

export function isDispatchConfigured(): boolean {
  return Boolean(process.env.GITHUB_DISPATCH_TOKEN && process.env.GITHUB_REPO);
}

export async function dispatchScraperRun(jobId: string): Promise<DispatchOutcome> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO;

  if (!token || !repo) {
    return {
      dispatched: false,
      reason:
        'GITHUB_DISPATCH_TOKEN or GITHUB_REPO is not set, so the batch is queued for the next scheduled run.',
    };
  }

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { dispatched: false, reason: `GITHUB_REPO must look like "owner/repo", not ${JSON.stringify(repo)}.` };
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ event_type: EVENT_TYPE, client_payload: { job_id: jobId } }),
      // A dispatch is a fire-and-forget poke; a slow GitHub must not hold the
      // click open, because the queue write that matters has already happened.
      signal: AbortSignal.timeout(8_000),
    });

    // 204 is the documented success. Anything else is worth reporting verbatim:
    // 403 usually means the token lacks Actions: write, 404 that it cannot see
    // the repository at all, and both are configuration mistakes a user can fix.
    if (response.status === 204) return { dispatched: true };

    const detail = (await response.text().catch(() => '')).slice(0, 200);
    return {
      dispatched: false,
      reason: `GitHub returned ${response.status}${detail ? `: ${detail}` : ''}.`,
    };
  } catch (error) {
    return {
      dispatched: false,
      reason: error instanceof Error ? error.message : 'Could not reach GitHub.',
    };
  }
}
