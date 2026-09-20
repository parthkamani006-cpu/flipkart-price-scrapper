import { cn } from '@/lib/utils';
import type { JobState, RowStatus } from '@/types/dashboard';

/**
 * One colour per meaning, everywhere.
 *
 * Row statuses and job states share a palette on purpose: "running" should look
 * the same whether it describes a product or a batch.
 */
const ROW_STYLES: Record<RowStatus, string> = {
  pending: 'bg-status-pending/15 text-status-pending ring-status-pending/30',
  running: 'bg-status-running/15 text-status-running ring-status-running/30',
  success: 'bg-status-success/15 text-status-success ring-status-success/30',
  failed: 'bg-status-failed/15 text-status-failed ring-status-failed/30',
  paused: 'bg-status-paused/15 text-status-paused ring-status-paused/30',
  cancelled: 'bg-status-cancelled/15 text-status-cancelled ring-status-cancelled/30',
};

const JOB_STYLES: Record<JobState, string> = {
  draft: ROW_STYLES.pending,
  queued: ROW_STYLES.pending,
  running: ROW_STYLES.running,
  pausing: ROW_STYLES.paused,
  paused: ROW_STYLES.paused,
  stopping: ROW_STYLES.failed,
  stopped: ROW_STYLES.cancelled,
  completed: ROW_STYLES.success,
  interrupted: ROW_STYLES.failed,
};

const JOB_LABELS: Record<JobState, string> = {
  draft: 'Draft',
  queued: 'Queued',
  running: 'Running',
  pausing: 'Pausing…',
  paused: 'Paused',
  stopping: 'Stopping…',
  stopped: 'Stopped',
  completed: 'Completed',
  interrupted: 'Interrupted',
};

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function RowStatusBadge({ status, className }: { status: RowStatus; className?: string }) {
  return (
    <Pill className={cn(ROW_STYLES[status], className)}>
      {status === 'running' && (
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
      )}
      {status}
    </Pill>
  );
}

export function JobStateBadge({ state, className }: { state: JobState; className?: string }) {
  const live = state === 'running' || state === 'pausing' || state === 'stopping';
  return (
    <Pill className={cn(JOB_STYLES[state], className)}>
      {live && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {JOB_LABELS[state]}
    </Pill>
  );
}
