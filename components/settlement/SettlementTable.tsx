'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { sellerListingUrl, type Settlement } from '@/lib/settlement';
import { cn } from '@/lib/utils';
import type { JobRow } from '@/types/dashboard';

/**
 * A virtualized settlement list.
 *
 * Same virtualization strategy as the queue table — only the visible slice is in
 * the DOM — generalized over a column set so every settlement list shares one
 * implementation. The columns are wider than the page, so the list scrolls both
 * ways inside a single container: one scrollbar pair, header and rows always in
 * step. The header is sticky so it survives the vertical scroll, and the content
 * is sized to the grid's real width (tracks + gaps) via `w-max`.
 *
 * A column that declares `sortValue` gets a clickable header that cycles
 * ascending → descending → back to the incoming order. The sort is local to one
 * table instance, so each settlement tab keeps its own choice, and rows with no
 * value sort last in either direction.
 *
 * Every row is a link to the product's Flipkart Seller Hub listing, opened in a
 * new tab.
 */

const ROW_HEIGHT = 40;
const OVERSCAN = 12;

export interface SettlementRow {
  row: JobRow;
  settlement: Settlement;
}

export interface SettlementColumn {
  key: string;
  header: string;
  /** Track width in rem. Summed to give the grid its horizontal-scroll min width. */
  width: number;
  align?: 'left' | 'right';
  cell: (entry: SettlementRow) => React.ReactNode;
  /** Present makes the header sortable. Null sorts last, whichever direction. */
  sortValue?: (entry: SettlementRow) => number | null;
}

interface Sort {
  key: string;
  direction: 'asc' | 'desc';
}

interface Props {
  rows: SettlementRow[];
  columns: SettlementColumn[];
  emptyMessage: string;
}

export function SettlementTable({ rows, columns, emptyMessage }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<Sort | null>(null);

  const sortedRows = useMemo(() => {
    const sortValue = sort ? columns.find((column) => column.key === sort.key)?.sortValue : undefined;
    if (!sort || !sortValue) return rows;

    const factor = sort.direction === 'asc' ? 1 : -1;
    // A copy: the incoming array is the caller's memoized bucket, and clearing
    // the sort has to give the original order back.
    return [...rows].sort((a, b) => {
      const left = sortValue(a);
      const right = sortValue(b);
      if (left === null || right === null) {
        if (left === right) return 0;
        return left === null ? 1 : -1;
      }
      return (left - right) * factor;
    });
  }, [rows, columns, sort]);

  const virtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const template = columns.map((column) => `${column.width}rem`).join(' ');
  const items = virtualizer.getVirtualItems();

  const open = (fsn: string) => window.open(sellerListingUrl(fsn), '_blank', 'noopener,noreferrer');

  const toggleSort = (key: string) => {
    setSort((current) => {
      if (current?.key !== key) return { key, direction: 'asc' };
      return current.direction === 'asc' ? { key, direction: 'desc' } : null;
    });
    // Re-sorting under a scrolled viewport would otherwise leave you in the
    // middle of a list whose top you never saw.
    parentRef.current?.scrollTo({ top: 0 });
  };

  return (
    <div className="overflow-hidden rounded-lg border">
      {/* One scroll container for both axes, so there is a single scrollbar pair
          and the header can never drift out of step with the rows. */}
      <div ref={parentRef} className="max-h-[28rem] overflow-auto scrollbar-thin">
        <div className="w-max min-w-full">
          <div
            className="sticky top-0 z-10 grid items-center gap-2 border-b bg-muted px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            style={{ gridTemplateColumns: template }}
          >
            {columns.map((column) => {
              const active = sort && sort.key === column.key ? sort : null;
              return (
                <span key={column.key} className={cn('truncate', column.align === 'right' && 'text-right')}>
                  {column.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className={cn(
                        'inline-flex max-w-full items-center gap-1 transition-colors hover:text-foreground',
                        // Keeps the label hard against the column's right edge,
                        // with the indicator on its inner side.
                        column.align === 'right' && 'flex-row-reverse',
                        active && 'text-foreground',
                      )}
                      title={
                        active === null
                          ? `Sort by ${column.header}, ascending`
                          : active.direction === 'asc'
                            ? `Sort by ${column.header}, descending`
                            : `Clear the ${column.header} sort`
                      }
                    >
                      <span className="truncate">{column.header}</span>
                      {active === null ? (
                        <ArrowUpDown className="size-3 shrink-0 opacity-50" />
                      ) : active.direction === 'asc' ? (
                        <ArrowUp className="size-3 shrink-0" />
                      ) : (
                        <ArrowDown className="size-3 shrink-0" />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </span>
              );
            })}
          </div>

          {sortedRows.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {items.map((item) => {
                const entry = sortedRows[item.index];
                return (
                  <div
                    key={entry.row.key}
                    role="button"
                    tabIndex={0}
                    className="absolute left-0 top-0 grid w-full cursor-pointer items-center gap-2 border-b px-3 text-sm outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/60"
                    style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)`, gridTemplateColumns: template }}
                    onClick={() => open(entry.row.fsn)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        open(entry.row.fsn);
                      }
                    }}
                    title={`Open listing ${entry.row.fsn} in Flipkart Seller Hub`}
                  >
                    {columns.map((column) => (
                      <span
                        key={column.key}
                        className={cn('truncate', column.align === 'right' && 'text-right tabular')}
                      >
                        {column.cell(entry)}
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
