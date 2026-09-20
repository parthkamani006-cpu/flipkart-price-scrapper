/**
 * Job identifiers.
 *
 * Kept in the app's own format rather than switching to uuid: the id is already
 * chronologically sortable, already appears in every dashboard URL, and the
 * database keys on it as text (supabase/migrations/0001_schema.sql).
 */

/**
 * Job ids arrive from route params, so they are user input.
 *
 * They no longer name a directory, but they still reach the database as a
 * literal, and a narrow character set keeps them from carrying anything
 * surprising into a filter or a Realtime channel name.
 */
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isJobId(jobId: string): boolean {
  return JOB_ID_PATTERN.test(jobId);
}

export function assertJobId(jobId: string): string {
  if (!isJobId(jobId)) {
    throw new Error(`Invalid job id: ${JSON.stringify(jobId)}`);
  }
  return jobId;
}

/**
 * A sortable, collision-resistant job id.
 *
 * Time-prefixed so `order by id` is chronological, with a random suffix because
 * two uploads in the same millisecond are entirely possible.
 */
export function newJobId(): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `job_${stamp}_${random}`;
}
