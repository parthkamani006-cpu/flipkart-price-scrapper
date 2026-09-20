/**
 * Typed fetch helpers for the dashboard.
 *
 * Every call funnels through `request` so a failed API call surfaces the
 * server's own error message instead of a bare "Failed to fetch".
 */

import type {
  JobManifest,
  JobOptions,
  JobRow,
  JobState,
  JobStats,
  LiveProgress,
  ScrapeInput,
} from '@/types/dashboard';
import type { ValidationReport } from '@/lib/validation/uploadSchema';
import type { OrdersReport } from '@/lib/demand';
// Type-only, so the server modules these live in are never pulled into the bundle.
import type { AccountSummary } from '@/lib/store/jobStore';
import type { RecommendationFile } from '@/lib/services/recommendations';
import { supabaseBrowser } from '@/lib/supabase/client';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON content-type for string bodies. A FormData body MUST set
  // its own `multipart/form-data; boundary=…` header — forcing application/json
  // here strips the boundary and the server can no longer parse the upload.
  const isJsonBody = typeof init?.body === 'string';

  const response = await fetch(url, {
    ...init,
    headers: {
      ...(isJsonBody ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const text = await response.text();
  const body = text ? safeParse(text) : null;

  if (!response.ok) {
    const message =
      (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : null) ?? `Request failed with ${response.status}`;
    throw new ApiError(message, response.status, body);
  }

  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type JobSummary = JobManifest & { stats: JobStats };

// Re-exported so client components get these shapes from one place and never
// reach into a server-only module themselves.
export type { AccountSummary, RecommendationFile, OrdersReport };

export const api = {
  listJobs: () => request<{ jobs: JobSummary[]; activeJobId: string | null }>('/api/jobs'),

  getJob: (jobId: string) =>
    request<{
      job: JobManifest;
      stats: JobStats;
      progress: LiveProgress[];
      isActive: boolean;
      activeJobId: string | null;
    }>(`/api/jobs/${jobId}`),

  createJob: (payload: {
    name: string;
    accountName: string;
    rows: ScrapeInput[];
    options?: Partial<JobOptions>;
    /** Whatever validateUpload parsed out of the orders report, or null. */
    orders?: OrdersReport | null;
  }) =>
    request<{ job: JobManifest; stats: JobStats }>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  listAccounts: () => request<{ accounts: AccountSummary[] }>('/api/accounts'),

  recommendations: (jobId: string) =>
    request<{ job: JobManifest; recommendations: RecommendationFile }>(
      `/api/jobs/${jobId}/recommendations`,
    ),

  regenerateRecommendations: (jobId: string) =>
    request<{ job: JobManifest; recommendations: RecommendationFile }>(
      `/api/jobs/${jobId}/recommendations`,
      { method: 'POST' },
    ),

  deleteJob: (jobId: string) => request<{ deleted: boolean }>(`/api/jobs/${jobId}`, { method: 'DELETE' }),

  /**
   * Ask for a state change.
   *
   * None of these actions performs the thing itself any more — the scraper is
   * in GitHub Actions. Start queues the batch and pokes a runner; Pause and
   * Stop record what the user wants and the worker acts on it when it next
   * looks. `note` is the plain-language version of that gap, meant to be shown.
   *
   * `dispatched: false` on a start is not a failure: the batch is queued either
   * way, and the twice-daily scheduled run will pick it up. It only means the
   * runner was not woken early.
   */
  control: (jobId: string, action: 'start' | 'resume' | 'pause' | 'stop') =>
    request<{
      ok: true;
      pending?: number;
      queued?: boolean;
      dispatched?: boolean;
      state?: JobState;
      note?: string;
      stats: JobStats;
    }>(`/api/jobs/${jobId}/control`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),

  rows: (jobId: string, params: URLSearchParams) =>
    request<{ rows: JobRow[]; total: number; matched: number; offset: number; limit: number }>(
      `/api/jobs/${jobId}/rows?${params.toString()}`,
    ),

  analytics: (jobId: string) => request<AnalyticsPayload>(`/api/jobs/${jobId}/analytics`),

  validateUpload: async (file: File, minimumFile: File, targetSeller: string) => {
    const prepared = await request<{
      bucket: string;
      uploads: { path: string; token: string }[];
    }>('/api/upload/sign', {
      method: 'POST',
      body: JSON.stringify({ files: [file, minimumFile].map(({ name, type }) => ({ name, contentType: type })) }),
    });
    const client = supabaseBrowser();
    if (!client) throw new Error('Supabase browser settings are missing.');

    await Promise.all(prepared.uploads.map(async (upload, index) => {
      const source = index === 0 ? file : minimumFile;
      const { error } = await client.storage.from(prepared.bucket).uploadToSignedUrl(upload.path, upload.token, source, {
        contentType: source.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      if (error) throw new Error(error.message);
    }));

    return request<{ filename: string; report: ValidationReport }>('/api/upload', {
      method: 'POST',
      body: JSON.stringify({ filePath: prepared.uploads[0]?.path, minimumFilePath: prepared.uploads[1]?.path, targetSeller }),
    });
  },

  retryRows: (jobId: string, indexes: number[]) =>
    request<{ requeued: number; state: JobState; stats: JobStats }>(`/api/jobs/${jobId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ indexes }),
    }),
};

export interface AnalyticsPayload {
  outcome: { name: string; value: number }[];
  failureReasons: { reason: string; count: number }[];
  sellers: { seller: string; total: number; succeeded: number; failed: number }[];
  perHour: { hour: string; completed: number; succeeded: number; failed: number }[];
  durations: { bucket: string; count: number }[];
  averageMs: number | null;
  medianMs: number | null;
}
