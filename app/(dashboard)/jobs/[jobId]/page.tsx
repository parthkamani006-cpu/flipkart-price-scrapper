'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Lightbulb, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { AnalyticsCharts } from '@/components/charts/AnalyticsCharts';
import { ControlBar } from '@/components/dashboard/ControlBar';
import { LiveProgressPanel } from '@/components/dashboard/LiveProgressPanel';
import { StatGrid } from '@/components/dashboard/StatGrid';
import { JobStateBadge } from '@/components/dashboard/StatusBadge';
import { FailedProducts } from '@/components/failed/FailedProducts';
import { EMPTY_FILTERS, FilterBar, type QueueFilters } from '@/components/queue/FilterBar';
import { ExportButtons } from '@/components/queue/ExportButtons';
import { QueueTable } from '@/components/queue/QueueTable';
import { SettlementView } from '@/components/settlement/SettlementView';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useJobRows, filtersToParams } from '@/hooks/useJobRows';
import { useJobStream } from '@/hooks/useJobStream';
import { api } from '@/lib/api';
import { ACTIVE_STATES } from '@/types/dashboard';

export default function JobDetailPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;
  const router = useRouter();

  const [banner, setBanner] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filters, setFilters] = useState<QueueFilters>(EMPTY_FILTERS);

  // Snapshot from the server; the Realtime subscription keeps state, stats and
  // progress current from there.
  const detail = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.getJob(jobId),
  });

  const stream = useJobStream(jobId);
  const rowsQuery = useJobRows(jobId, filters);

  const manifest = detail.data?.job;
  const state = stream.state ?? manifest?.state ?? 'queued';
  const stats = stream.stats ?? detail.data?.stats ?? null;
  const isRunning = ACTIVE_STATES.includes(state);
  const blockedBy = detail.data?.activeJobId && detail.data.activeJobId !== jobId ? detail.data.activeJobId : null;

  const rowParams = useMemo(() => filtersToParams(filters), [filters]);
  const rows = rowsQuery.data?.rows ?? [];

  if (detail.isLoading || !manifest || !stats) {
    return (
      <div className="w-full space-y-4 p-4 xl:p-5">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="w-full p-4 xl:p-5">
        <Alert variant="destructive">
          <AlertTitle>Could not load this batch</AlertTitle>
          <AlertDescription>{(detail.error as Error).message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="w-full space-y-5 p-4 xl:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/" aria-label="Back to batches">
              <ArrowLeft />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">{manifest.name}</h1>
              <JobStateBadge state={state} />
            </div>
            <p className="tabular text-xs text-muted-foreground">{jobId}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Recommendations exist once anything has been scraped; they are
              generated when the run ends, so this is a link, not an action. */}
          {stats.completed > 0 && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/recommendations/${jobId}`}>
                <Lightbulb /> Recommendations
              </Link>
            </Button>
          )}
          <ControlBar
            jobId={jobId}
            state={state}
            stats={stats}
            blockedBy={blockedBy}
            onError={setBanner}
            onNotice={setNotice}
          />
          {!isRunning && (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-status-failed"
              onClick={async () => {
                if (!confirm('Delete this batch and everything it wrote?')) return;
                await api.deleteJob(jobId).catch(() => undefined);
                router.push('/');
              }}
              aria-label="Delete batch"
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </div>

      {banner && (
        <Alert variant="destructive">
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{banner}</AlertDescription>
        </Alert>
      )}

      {notice && !banner && (
        <Alert>
          <AlertTitle>Request sent</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {state === 'queued' && stats.pending > 0 && (
        <Alert>
          <AlertTitle>Waiting for a runner</AlertTitle>
          <AlertDescription>
            The scraper runs on GitHub Actions, not in this browser or on this server. A runner has
            to start up and install Chromium before it picks this batch up, which usually takes a
            minute or two. This page updates itself when it does — nothing needs to stay open.
          </AlertDescription>
        </Alert>
      )}

      {state === 'interrupted' && (
        <Alert variant="warning">
          <AlertTitle>This batch was interrupted</AlertTitle>
          <AlertDescription>
            The worker stopped reporting mid-run — a cancelled workflow, or a runner that ran out of
            memory or time. All {stats.completed} completed products are saved; press Resume to
            scrape the remaining {stats.pending}. The products that were in flight were never
            recorded, so they are still pending.
          </AlertDescription>
        </Alert>
      )}

      <StatGrid stats={stats} />

      <LiveProgressPanel progress={stream.progress} stats={stats} isRunning={isRunning} />

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="settlement">Settlement</TabsTrigger>
          <TabsTrigger value="failed">
            Failed{stats.failed > 0 ? ` (${stats.failed})` : ''}
          </TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="space-y-3">
          <FilterBar
            filters={filters}
            onChange={setFilters}
            matched={rowsQuery.data?.matched ?? rows.length}
            total={rowsQuery.data?.total ?? stats.total}
            actions={
              <ExportButtons jobId={jobId} params={rowParams} matched={rowsQuery.data?.matched ?? rows.length} />
            }
          />
          <QueueTable rows={rows} />
          {(rowsQuery.data?.matched ?? 0) > rows.length && (
            <p className="text-center text-xs text-muted-foreground">
              Showing the first {rows.length} of {rowsQuery.data?.matched}. Narrow the filters or export
              to see everything.
            </p>
          )}
        </TabsContent>

        <TabsContent value="settlement">
          <SettlementView jobId={jobId} />
        </TabsContent>

        <TabsContent value="failed">
          <FailedProducts jobId={jobId} canRetry={!isRunning} />
        </TabsContent>

        <TabsContent value="analytics">
          <AnalyticsCharts jobId={jobId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
