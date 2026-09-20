'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { ExternalLink } from 'lucide-react';
import { useRef } from 'react';
import { RowStatusBadge } from '@/components/dashboard/StatusBadge';
import { formatDifference, formatDuration, formatPrice, shortenUrl } from '@/lib/format';
import { computeSettlement } from '@/lib/settlement';
import { cn } from '@/lib/utils';
import type { JobRow } from '@/types/dashboard';

/**
 * The queue, virtualized.
 *
 * Only the visible slice is in the DOM, so a 1000-row batch renders the same
 * ~25 rows a 20-row batch does. This is what keeps the page responsive during a
 * long run, when rows are also being patched in live over SSE.
 */

const ROW_HEIGHT = 40;
/** Rows rendered beyond the viewport, so fast scrolling doesn't flash blank. */
const OVERSCAN = 12;

interface Props {
  rows: JobRow[];
  onSelect?: (row: JobRow) => void;
  emptyMessage?: string;
}

const COLUMNS =
  'grid-cols-[3rem_9rem_10rem_8rem_minmax(10rem,1fr)_7rem_6rem_5rem_6rem_2.5rem]';

export function QueueTable({ rows, onSelect, emptyMessage = 'No products match these filters.' }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div className="overflow-hidden rounded-lg border">
      <div
        className={cn(
          'grid items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground',
          COLUMNS,
        )}
      >
        <span>#</span>
        <span>SKU</span>
        <span>FSN</span>
        <span>Seller</span>
        <span>Product URL</span>
        <span>Status</span>
        <span className="text-right">Duration</span>
        <span className="text-right">Retries</span>
        <span className="text-right">Diff</span>
        <span />
      </div>

      {rows.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <div ref={parentRef} className="max-h-[32rem] overflow-auto scrollbar-thin">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((item) => {
              const row = rows[item.index];
              return (
                <div
                  key={row.key}
                  className={cn(
                    'absolute left-0 top-0 grid w-full items-center gap-2 border-b px-3 text-sm transition-colors',
                    COLUMNS,
                    onSelect && 'cursor-pointer hover:bg-accent/40',
                    row.status === 'running' && 'bg-status-running/5',
                  )}
                  style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
                  onClick={() => onSelect?.(row)}
                >
                  <span className="tabular text-muted-foreground">{row.index + 1}</span>
                  <span className="truncate font-medium" title={row.sku}>
                    {row.sku}
                  </span>
                  <span className="tabular truncate text-muted-foreground" title={row.fsn}>
                    {row.fsn}
                  </span>
                  <span className="truncate" title={row.targetSeller}>
                    {row.targetSeller}
                  </span>
                  <span className="truncate text-muted-foreground" title={row.productUrl}>
                    {shortenUrl(row.productUrl, 40)}
                  </span>
                  <span>
                    <RowStatusBadge status={row.status} />
                  </span>
                  <span className="tabular text-right text-muted-foreground">
                    {formatDuration(row.durationMs)}
                  </span>
                  <span className="tabular text-right text-muted-foreground">
                    {row.attempts && row.attempts > 1 ? row.attempts - 1 : '—'}
                  </span>
                  <span
                    className={cn(
                      'tabular text-right',
                      row.result?.isPriceDifferent ? 'font-medium text-status-paused' : 'text-muted-foreground',
                    )}
                    title={
                      row.result
                        ? `page ${formatPrice(row.result.mainPrice)} vs seller ${formatPrice(row.result.sellerPrice)}`
                        : undefined
                    }
                  >
                    {row.result?.status === 'OK' ? formatDifference(computeSettlement(row).difference) : '—'}
                  </span>
                  <span className="flex items-center justify-end gap-1 text-muted-foreground">
                    <a
                      href={row.productUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      onClick={(event) => event.stopPropagation()}
                      className="hover:text-foreground"
                      aria-label="Open product page"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
