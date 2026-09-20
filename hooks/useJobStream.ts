'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { supabaseBrowser } from '@/lib/supabase/client';
import type { JobRow, JobState, JobStats, LiveProgress } from '@/types/dashboard';

export interface JobStream {
  connected: boolean;
  state: JobState | null;
  stats: JobStats | null;
  progress: LiveProgress[];
}

/**
 * Subscribe to a batch's live changes.
 *
 * This used to be an EventSource onto /api/jobs/:id/events, backed by an
 * in-process event bus the runner published to. Both ends of that only worked
 * because the scraper and the dashboard were the same Node process. The scraper
 * is in GitHub Actions now, so the two share nothing but the database — and the
 * database is what the browser subscribes to.
 *
 * Two channels, mirroring the two events that mattered:
 *
 *  - `jobs` filtered to this id → state, stats and the worker's progress
 *    snapshot. One row UPDATE carries all three, which is why the worker writes
 *    them together.
 *  - `job_results` filtered to this id → one INSERT per product as it lands.
 *
 * Realtime has no equivalent of the old route's priming frames, which pushed
 * state and progress the instant a tab connected. So the hook fetches once on
 * subscribe; without that, opening a tab mid-run would show nothing until the
 * next product finished.
 */
export function useJobStream(jobId: string | null): JobStream {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<JobState | null>(null);
  const [stats, setStats] = useState<JobStats | null>(null);
  const [progress, setProgress] = useState<LiveProgress[]>([]);

  // Held in a ref so the Realtime callbacks never re-subscribe the channel.
  const jobIdRef = useRef(jobId);
  jobIdRef.current = jobId;

  /**
   * Pull the authoritative counts.
   *
   * The worker maintains a stats snapshot on the batch row, but the counts the
   * dashboard shows are recomputed from job_results by job_stats_v — the
   * snapshot can lag its own results by up to a second. So a change *notifies*;
   * this is what says what the numbers actually are.
   */
  const refreshStats = useCallback(async (id: string) => {
    try {
      const detail = await api.getJob(id);
      setState(detail.job.state);
      setStats(detail.stats);
      setProgress(detail.progress);
    } catch {
      // A failed refresh leaves the last known figures on screen, which is
      // better than blanking them; the next change will try again.
    }
  }, []);

  useEffect(() => {
    if (!jobId) return;

    const supabase = supabaseBrowser();
    if (!supabase) {
      // Not configured. The page still renders from its React Query fetches;
      // it simply will not update on its own.
      setConnected(false);
      return;
    }

    void refreshStats(jobId);

    // Coalesced: a 20-wide pool can land several results within a second, and
    // each one would otherwise trigger its own stats fetch.
    let pendingRefresh: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = (): void => {
      if (pendingRefresh) return;
      pendingRefresh = setTimeout(() => {
        pendingRefresh = null;
        const id = jobIdRef.current;
        if (id) void refreshStats(id);
      }, 750);
    };

    const channel = supabase
      .channel(`job:${jobId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'jobs', filter: `id=eq.${jobId}` },
        (payload) => {
          const row = payload.new as { state?: JobState; progress?: LiveProgress[] };
          if (row.state) setState(row.state);
          if (Array.isArray(row.progress)) setProgress(row.progress);

          // The manifest changed shape (timestamps, state); let the detail and
          // list queries refetch so the header and the batch list agree.
          queryClient.invalidateQueries({ queryKey: ['job', jobId] });
          queryClient.invalidateQueries({ queryKey: ['jobs'] });
          scheduleRefresh();
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'job_results', filter: `job_id=eq.${jobId}` },
        (payload) => {
          const row = rowFromResult(payload.new as ResultPayload);
          if (!row) return;

          patchRowCaches(queryClient, jobId, row);
          scheduleRefresh();
        },
      )
      .subscribe((status) => {
        setConnected(status === 'SUBSCRIBED');
      });

    return () => {
      if (pendingRefresh) clearTimeout(pendingRefresh);
      void supabase.removeChannel(channel);
      setConnected(false);
    };
  }, [jobId, queryClient, refreshStats]);

  return { connected, state, stats, progress };
}

/** The columns a job_results INSERT carries over the wire. */
interface ResultPayload {
  job_id: string;
  idx: number;
  fsn: string;
  sku: string;
  product_url: string;
  seller_name: string | null;
  buybox_seller_name: string | null;
  main_listing_is_account_seller: boolean | null;
  main_price: number | null;
  seller_price: number | null;
  difference: number | null;
  is_price_different: boolean;
  status: string;
  message: string | null;
  sellers_scanned: number | null;
  show_more_clicks: number | null;
  source: string | null;
  duration_ms: number | null;
  attempts: number | null;
  finished_at: string;
}

/**
 * Build a partial JobRow from a result INSERT.
 *
 * Realtime delivers the changed table's row, not the joined view, so the input
 * half (target seller, settlement figures) is not in the payload. That is fine
 * for what this feeds: an in-place patch of a cached row that already carries
 * those fields. The patch below merges rather than replaces, so nothing is lost.
 */
function rowFromResult(payload: ResultPayload): Partial<JobRow> & { index: number } | null {
  if (typeof payload?.idx !== 'number') return null;

  const result = {
    fsn: payload.fsn,
    sku: payload.sku,
    sellerName: payload.seller_name,
    buyboxSellerName: payload.buybox_seller_name,
    mainListingIsAccountSeller: payload.main_listing_is_account_seller ?? undefined,
    mainPrice: payload.main_price,
    sellerPrice: payload.seller_price,
    difference: payload.difference,
    isPriceDifferent: payload.is_price_different,
    productUrl: payload.product_url,
    status: payload.status,
    message: payload.message ?? undefined,
    sellersScanned: payload.sellers_scanned ?? undefined,
    showMoreClicks: payload.show_more_clicks ?? undefined,
    source: payload.source ?? undefined,
    durationMs: payload.duration_ms ?? undefined,
    attempts: payload.attempts ?? undefined,
    finishedAt: payload.finished_at,
  } as JobRow['result'];

  return {
    index: payload.idx,
    key: `${payload.job_id}#${payload.idx}`,
    sku: payload.sku,
    fsn: payload.fsn,
    productUrl: payload.product_url,
    status: payload.status === 'OK' ? 'success' : 'failed',
    result,
    durationMs: payload.duration_ms ?? undefined,
    attempts: payload.attempts ?? undefined,
    message: payload.message ?? undefined,
    finishedAt: payload.finished_at,
  };
}

/**
 * Splice an updated row into every cached rows query for this batch.
 *
 * Patching beats invalidating: a 1000-row batch finishing a product every few
 * seconds would otherwise refetch the entire table on every completion.
 *
 * Two rules carried over deliberately. It merges rather than replaces, because
 * a Realtime result payload has no input columns and overwriting would blank
 * the seller and settlement cells. And a row whose index is not already in the
 * cache is left alone: a filtered view showing only failures should not gain a
 * row because something elsewhere finished — the next refetch decides that.
 */
function patchRowCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  jobId: string,
  patch: Partial<JobRow> & { index: number },
): void {
  queryClient.setQueriesData<{ rows: JobRow[]; total: number; matched: number }>(
    { queryKey: ['rows', jobId] },
    (previous) => {
      if (!previous) return previous;
      const index = previous.rows.findIndex((candidate) => candidate.index === patch.index);
      if (index === -1) return previous;

      const rows = [...previous.rows];
      rows[index] = { ...rows[index], ...patch };
      return { ...previous, rows };
    },
  );
}
