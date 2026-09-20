'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, RotateCcw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatDateTime, formatDuration, shortenUrl } from '@/lib/format';

interface Props {
  jobId: string;
  /** Retry deletes results, so it is refused while a worker owns the batch. */
  canRetry: boolean;
}

/**
 * The failures, with what was recorded about each one.
 *
 * There used to be a screenshot thumbnail and a lightbox here. The scraper now
 * runs on a GitHub Actions runner whose filesystem is destroyed when the job
 * ends, so a screenshot would have to be uploaded somewhere to survive — and
 * that was deliberately not built. What is left is what the scraper actually
 * knows: the status it ended on and the message explaining it, which is where
 * the diagnosis lived anyway.
 */
export function FailedProducts({ jobId, canRetry }: Props) {
  const queryClient = useQueryClient();

  // Its own query, filtered in SQL to failures — independent of whatever
  // filters the Queue tab happens to have set.
  const failedQuery = useQuery({
    queryKey: ['rows', jobId, 'status=failed&limit=10000'],
    queryFn: () => api.rows(jobId, new URLSearchParams({ status: 'failed', limit: '10000' })),
  });

  const failed = failedQuery.data?.rows ?? [];

  const retry = useMutation({
    mutationFn: (indexes: number[]) => api.retryRows(jobId, indexes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rows', jobId] });
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    },
  });

  if (failedQuery.isLoading) {
    return <Card className="h-40 animate-pulse" />;
  }

  if (failed.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-2 p-10 text-center">
        <CheckCircle2 className="size-8 text-status-success" aria-hidden />
        <p className="font-medium">No failures</p>
        <p className="text-sm text-muted-foreground">Every product that has run so far succeeded.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {failed.length} product{failed.length === 1 ? '' : 's'} failed.
        </p>
        <Button
          size="sm"
          disabled={!canRetry || retry.isPending}
          onClick={() => retry.mutate(failed.map((row) => row.index))}
        >
          <RotateCcw /> Retry all {failed.length}
        </Button>
      </div>

      {!canRetry && (
        <Alert variant="warning">
          <AlertTitle>Retry is unavailable while the batch is running</AlertTitle>
          <AlertDescription>
            Requeuing deletes those rows&apos; results, and the worker decides what is still pending
            by asking the same question. Pause or stop the batch first.
          </AlertDescription>
        </Alert>
      )}

      {retry.isSuccess && (
        <Alert variant="success">
          <AlertTitle>{retry.data.requeued} product(s) moved back to pending</AlertTitle>
          <AlertDescription>
            The batch now has {retry.data.stats.pending} pending — press Resume at the top of the
            page to scrape them again.
          </AlertDescription>
        </Alert>
      )}

      {retry.isError && (
        <Alert variant="destructive">
          <AlertTitle>Retry failed</AlertTitle>
          <AlertDescription>{(retry.error as Error).message}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        {failed.map((row) => (
          <Card key={row.key} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.sku}</span>
                  <Badge variant="destructive">{row.result?.status ?? 'FAILED'}</Badge>
                  <span className="tabular text-xs text-muted-foreground">{row.fsn}</span>
                </div>

                <p className="mt-1.5 text-sm text-muted-foreground">
                  {row.message ?? 'No further detail was recorded.'}
                </p>

                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Seller: {row.targetSeller}</span>
                  <span>Duration: {formatDuration(row.durationMs)}</span>
                  <span>Attempts: {row.attempts ?? 1}</span>
                  <span>Finished: {formatDateTime(row.finishedAt)}</span>
                </div>

                <a
                  href={row.productUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  {shortenUrl(row.productUrl, 56)} <ExternalLink className="size-3" />
                </a>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canRetry || retry.isPending}
                  onClick={() => retry.mutate([row.index])}
                >
                  <RotateCcw /> Retry
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
