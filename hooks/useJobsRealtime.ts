'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';

/**
 * Keep the batch list current without polling for it.
 *
 * The list used to poll every five seconds, with a comment explaining that the
 * heavy live updates came over SSE on the batch page and this was just so a
 * batch started in another tab turned up. Both halves of that have changed: the
 * SSE route is gone, and the scraper is on a machine this browser has no
 * connection to at all — a state change can arrive at any time, from a runner
 * nobody has a page open for.
 *
 * So the list subscribes to the `jobs` table. Any insert, update or delete
 * invalidates the query and it refetches once. The caller keeps a slow poll as
 * a fallback for the case where the socket cannot be established — a blocked
 * WebSocket, or Supabase not configured yet — because a list that silently
 * stops updating is worse than one that updates late.
 */
export function useJobsRealtime(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const supabase = supabaseBrowser();
    if (!supabase) return;

    const channel = supabase
      .channel('jobs:list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, () => {
        queryClient.invalidateQueries({ queryKey: ['jobs'] });
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);
}
