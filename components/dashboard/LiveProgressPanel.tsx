'use client';

import { Chrome, Clock, Hourglass, Package, Store } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { elapsedSince, formatDuration, formatEta, shortenUrl } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { JobStats, LiveProgress, ScrapeStep } from '@/types/dashboard';

/** Human labels, in pipeline order — the order also drives the step meter. */
const STEPS: { key: ScrapeStep; label: string }[] = [
  { key: 'opening', label: 'Opening product' },
  { key: 'reading-page', label: 'Reading page data' },
  { key: 'main-price', label: 'Reading main price' },
  { key: 'opening-sellers', label: 'Opening seller list' },
  { key: 'finding-seller', label: 'Finding the seller' },
  { key: 'comparing', label: 'Comparing prices' },
  { key: 'done', label: 'Done' },
];

interface Props {
  /** Every product in flight, one entry per worker. Empty when nothing is running. */
  progress: LiveProgress[];
  stats: JobStats;
  isRunning: boolean;
}

export function LiveProgressPanel({ progress, stats, isRunning }: Props) {
  // Ticks once a second purely so the elapsed timers move; everything else is
  // event-driven and re-renders only when something actually changes.
  const [, setTick] = useState(0);
  const active = progress.length > 0;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [active]);

  const overallPercent = stats.total ? (stats.completed / stats.total) * 100 : 0;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">Live progress</h2>
        <span
          className={cn(
            'flex items-center gap-1.5 text-xs',
            isRunning ? 'text-status-running' : 'text-muted-foreground',
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              isRunning ? 'animate-pulse bg-status-running' : 'bg-muted-foreground',
            )}
            aria-hidden
          />
          {isRunning ? `Scraping${progress.length > 1 ? ` · ${progress.length} workers` : ''}` : 'Idle'}
        </span>
      </div>

      <div className="space-y-4 p-4">
        <div>
          <div className="mb-1.5 flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">Batch progress</span>
            <span className="tabular font-medium">
              {stats.completed} / {stats.total}
              <span className="ml-2 text-muted-foreground">{stats.pending} remaining</span>
            </span>
          </div>
          <Progress value={overallPercent} />
        </div>

        <div className="flex items-baseline justify-between text-sm">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Hourglass className="size-3.5" aria-hidden />
            Estimated remaining
          </span>
          <span className="tabular font-medium">{formatEta(stats.estimatedRemainingMs)}</span>
        </div>

        {active ? (
          // One card per worker, keyed by worker id so a card belongs to the same
          // worker across renders and does not swap places as products finish.
          // Past three workers the cards go two-up, and past ten three-up:
          // twenty of them stacked is several metres of scrolling, and the
          // point of this panel is to take in the whole pool at a glance.
          <div
            className={cn(
              'grid gap-3',
              progress.length > 3 && 'xl:grid-cols-2',
              progress.length > 10 && '2xl:grid-cols-3',
            )}
          >
            {progress.map((live) => (
              <WorkerCard key={live.workerId} live={live} showLabel={progress.length > 1} />
            ))}
          </div>
        ) : (
          <p className="rounded-md bg-muted/40 p-4 text-center text-sm text-muted-foreground">
            {isRunning ? 'Between products…' : 'Nothing running. Start or resume the batch to begin.'}
          </p>
        )}

        <dl className="grid grid-cols-3 gap-3 border-t pt-3 text-center">
          <Metric label="Average" value={formatDuration(stats.averageMs)} />
          <Metric label="Succeeded" value={stats.succeeded} className="text-status-success" />
          <Metric label="Failed" value={stats.failed} className="text-status-failed" />
        </dl>
      </div>
    </Card>
  );
}

/** One worker's current product. */
function WorkerCard({ live, showLabel }: { live: LiveProgress; showLabel: boolean }) {
  const stepIndex = STEPS.findIndex((step) => step.key === live.step);
  const stepPercent = stepIndex >= 0 ? ((stepIndex + 1) / STEPS.length) * 100 : 0;

  return (
    <div className="space-y-3 rounded-md border p-3">
      {showLabel && (
        <div className="flex items-center justify-between">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Worker {live.workerId + 1}
          </span>
          <span className="tabular text-xs text-muted-foreground">{elapsedSince(live.startedAt)}</span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field icon={Package} label="Current product">
          <span className="font-medium">{live.sku || '—'}</span>
          <span className="ml-2 text-muted-foreground">{live.fsn}</span>
        </Field>
        <Field icon={Store} label="Target seller">
          {live.targetSeller}
        </Field>
        {!showLabel && (
          <Field icon={Clock} label="Elapsed on this product">
            <span className="tabular">{elapsedSince(live.startedAt)}</span>
          </Field>
        )}
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">Current step</span>
          <span className="font-medium">
            {STEPS[stepIndex]?.label ?? live.step}
            <span className="tabular ml-2 text-xs text-muted-foreground">
              {stepIndex + 1}/{STEPS.length}
            </span>
          </span>
        </div>
        <Progress value={stepPercent} className="h-1.5" indicatorClassName="bg-status-running" />
      </div>

      <div className="space-y-1 rounded-md bg-muted/40 p-3 text-xs">
        <div className="flex gap-2">
          <Chrome className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Browser</span>
          <span className="font-medium capitalize">{live.browserStatus}</span>
        </div>
        <p className="break-all text-muted-foreground" title={live.productUrl}>
          {shortenUrl(live.productUrl, 70)}
        </p>
      </div>
    </div>
  );
}

function Field({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Package;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </p>
      <p className="mt-0.5 truncate text-sm">{children}</p>
    </div>
  );
}

function Metric({ label, value, className }: { label: string; value: string | number; className?: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('tabular mt-0.5 font-medium', className)}>{value}</dd>
    </div>
  );
}
