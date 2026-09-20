'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api';
import type { QueueFilters } from '@/components/queue/FilterBar';

/** Translate the UI's filter state into the query string the rows API expects. */
export function filtersToParams(filters: QueueFilters): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.search) params.set('search', filters.search);
  if (filters.status.length) params.set('status', filters.status.join(','));
  if (filters.reason.length) params.set('reason', filters.reason.join(','));
  if (filters.sku) params.set('sku', filters.sku);
  if (filters.fsn) params.set('fsn', filters.fsn);
  if (filters.seller) params.set('seller', filters.seller);
  if (filters.url) params.set('url', filters.url);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.minDuration) params.set('minDuration', filters.minDuration);
  if (filters.maxDuration) params.set('maxDuration', filters.maxDuration);

  return params;
}

export function useJobRows(jobId: string, filters: QueueFilters, limit = 5_000) {
  const params = useMemo(() => {
    const next = filtersToParams(filters);
    next.set('limit', String(limit));
    return next;
  }, [filters, limit]);

  return useQuery({
    queryKey: ['rows', jobId, params.toString()],
    queryFn: () => api.rows(jobId, params),
    // Keeps the old page visible while a filter change is in flight, so the
    // table doesn't blank out on every keystroke.
    placeholderData: keepPreviousData,
  });
}
