'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pause, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { ACTIVE_STATES, RESUMABLE_STATES, type JobState, type JobStats } from '@/types/dashboard';

interface Props {
  jobId: string;
  state: JobState;
  stats: JobStats;
  /** Another batch holds the scraper, so this one cannot start. */
  blockedBy?: string | null;
  onError?: (message: string) => void;
  /**
   * What actually happened, in words. These actions are requests now — the
   * scraper is on another machine — and the gap between asking and it being
   * true is a real thing the user should be told about rather than left to
   * infer from a button that did nothing visible.
   */
  onNotice?: (message: string) => void;
}

export function ControlBar({ jobId, state, stats, blockedBy, onError, onNotice }: Props) {
  const queryClient = useQueryClient();

  const control = useMutation({
    mutationFn: (action: 'start' | 'resume' | 'pause' | 'stop') => api.control(jobId, action),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      if (result.note) onNotice?.(result.note);
    },
    onError: (error) => onError?.((error as Error).message),
  });

  const active = ACTIVE_STATES.includes(state);
  const resumable = RESUMABLE_STATES.includes(state);
  const nothingLeft = stats.pending === 0 && stats.running === 0;
  const busy = control.isPending;

  // A batch that has been through a run and still has work is resuming, not starting.
  const startLabel = state === 'queued' || state === 'draft' ? 'Start' : 'Resume';
  const startAction = startLabel === 'Start' ? 'start' : 'resume';

  const startDisabled = busy || !resumable || nothingLeft || Boolean(blockedBy);
  const startReason = blockedBy
    ? 'Another batch is running. Only one runs at a time.'
    : nothingLeft
      ? 'Every product in this batch has a result.'
      : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <MaybeTooltip reason={startReason}>
        <Button
          onClick={() => control.mutate(startAction)}
          disabled={startDisabled}
          size="sm"
        >
          {busy && control.variables !== 'pause' && control.variables !== 'stop' ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Play />
          )}
          {startLabel}
          {resumable && !nothingLeft && stats.pending > 0 && (
            <span className="tabular ml-1 rounded bg-primary-foreground/20 px-1.5 py-0.5 text-[11px]">
              {stats.pending}
            </span>
          )}
        </Button>
      </MaybeTooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              onClick={() => control.mutate('pause')}
              disabled={busy || state !== 'running'}
              variant="outline"
              size="sm"
            >
              <Pause /> Pause
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Asks the worker to stop taking new products. It finishes the ones already in flight and
          saves them, so nothing nearly-done is thrown away — usually within a minute.
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              onClick={() => control.mutate('stop')}
              disabled={busy || !active}
              variant="outline"
              size="sm"
              className="text-status-failed hover:text-status-failed"
            >
              <Square /> Stop
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Asks the worker to close its browser contexts. It notices within a few seconds; a page
          already waiting on Flipkart takes a moment longer to let go. Products in flight stay
          pending and are scraped again on resume.
        </TooltipContent>
      </Tooltip>

      {state === 'queued' && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> waiting for a runner…
        </span>
      )}
      {state === 'pausing' && (
        <span className="flex items-center gap-1.5 text-xs text-status-paused">
          <Loader2 className="size-3 animate-spin" /> finishing the products in flight…
        </span>
      )}
      {state === 'stopping' && (
        <span className="flex items-center gap-1.5 text-xs text-status-failed">
          <Loader2 className="size-3 animate-spin" /> stopping…
        </span>
      )}
    </div>
  );
}

function MaybeTooltip({ reason, children }: { reason: string | null; children: React.ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{children}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
