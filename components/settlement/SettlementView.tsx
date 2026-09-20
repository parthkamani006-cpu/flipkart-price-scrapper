'use client';

import { CircleCheck, CircleHelp, Equal, FileSpreadsheet, List, Search, TrendingDown, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { RowStatusBadge } from '@/components/dashboard/StatusBadge';
import { EMPTY_FILTERS } from '@/components/queue/FilterBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useJobRows } from '@/hooks/useJobRows';
import {
  formatDateTime,
  formatDifferencePercent,
  formatDuration,
  formatSettlement,
  formatSignedNumber,
} from '@/lib/format';
import { computeSettlement, SETTLEMENT_CATEGORY_LABEL } from '@/lib/settlement';
import { cn } from '@/lib/utils';
import { SettlementTable, type SettlementColumn, type SettlementRow } from './SettlementTable';

/**
 * The settlement view.
 *
 * Reads the same unfiltered rows query the queue tab uses, so the SSE row-patch
 * keeps every list live during a run without any extra plumbing. Every row is
 * bucketed once into Main (clears the threshold), Below Threshold (falls short),
 * No Difference (prices match) or Needs Review (can't be evaluated yet), and each
 * bucket renders the same column set — the review list adds a Reason column. The
 * All list is the unbucketed set, with both a List and a Reason column so the
 * mixed rows still explain themselves.
 */

const BASE_COLUMNS: SettlementColumn[] = [
  { key: 'sellerPrice', header: 'My Price', width: 6, align: 'right', cell: ({ settlement }) => formatSettlement(settlement.sellerPrice) },
  { key: 'currentPrice', header: 'Flipkart Price', width: 7, align: 'right', cell: ({ settlement }) => formatSettlement(settlement.currentPrice) },
  // You hold the buy box when the winning seller is you. A dash means the page
  // never named a winner, which is not the same as No.
  {
    key: 'buybox',
    header: 'Buybox',
    width: 5,
    cell: ({ settlement }) =>
      settlement.hasBuybox === null ? (
        <span className="text-muted-foreground">—</span>
      ) : settlement.hasBuybox ? (
        <span className="font-medium">Yes</span>
      ) : (
        <span className="text-muted-foreground">No</span>
      ),
  },
  { key: 'fsn', header: 'FSN', width: 9, cell: ({ row }) => <span title={row.fsn}>{row.fsn}</span> },
  { key: 'seller', header: 'Seller', width: 9, cell: ({ row }) => <span title={row.targetSeller}>{row.targetSeller}</span> },
  {
    key: 'buyboxSeller',
    header: 'Winning Seller Name',
    width: 10,
    cell: ({ row }) => {
      const winner = row.result?.buyboxSellerName ?? null;
      return winner ? <span title={winner}>{winner}</span> : <span className="text-muted-foreground">—</span>;
    },
  },
  { key: 'status', header: 'Status', width: 6, cell: ({ row }) => <RowStatusBadge status={row.status} /> },
  { key: 'duration', header: 'Duration', width: 5, align: 'right', cell: ({ row }) => formatDuration(row.durationMs) },
  // When the scrape finished — set the moment a row succeeds or fails, so a row
  // still queued or running shows a dash.
  {
    key: 'finishedAt',
    header: 'Finished At',
    width: 11,
    cell: ({ row }) => (
      <span className="tabular text-muted-foreground" title={row.finishedAt ?? undefined}>
        {formatDateTime(row.finishedAt)}
      </span>
    ),
  },
  {
    key: 'difference',
    header: 'Difference',
    width: 6,
    align: 'right',
    // Sortable in every list — a null difference (a row that can't be
    // evaluated) always sorts to the bottom.
    sortValue: ({ settlement }) => settlement.difference,
    cell: ({ settlement }) => <span className={signClass(settlement.difference)}>{formatSignedNumber(settlement.difference)}</span>,
  },
  {
    key: 'differencePct',
    header: 'Diff %',
    width: 6,
    align: 'right',
    cell: ({ settlement }) => <span className={signClass(settlement.difference)}>{formatDifferencePercent(settlement.differencePct)}</span>,
  },
  { key: 'threshold', header: 'Minimum Bank Settlement', width: 11.5, align: 'right', cell: ({ settlement }) => formatSettlement(settlement.bankSettlementThreshold) },
  { key: 'currentBs', header: 'Current Bank Settlement', width: 11.5, align: 'right', cell: ({ settlement }) => formatSettlement(settlement.currentBankSettlement) },
  {
    key: 'finalBs',
    header: 'Final BS',
    width: 6.5,
    align: 'right',
    cell: ({ settlement }) => <span className="font-medium">{formatSettlement(settlement.finalBankSettlement)}</span>,
  },
];

const REASON_COLUMN: SettlementColumn = {
  key: 'reason',
  header: 'Reason',
  width: 14,
  cell: ({ settlement }) => (
    <span className="text-muted-foreground" title={settlement.reason ?? undefined}>
      {settlement.reason ?? '—'}
    </span>
  ),
};

const REVIEW_COLUMNS = [...BASE_COLUMNS, REASON_COLUMN];

/** The bucket a row would land in — only meaningful on the mixed "All" list. */
const CATEGORY_COLUMN: SettlementColumn = {
  key: 'category',
  header: 'List',
  width: 7,
  cell: ({ settlement }) => (
    <span className="text-muted-foreground">{SETTLEMENT_CATEGORY_LABEL[settlement.category]}</span>
  ),
};

const ALL_COLUMNS = [...BASE_COLUMNS, CATEGORY_COLUMN, REASON_COLUMN];

export function SettlementView({ jobId }: { jobId: string }) {
  const rowsQuery = useJobRows(jobId, EMPTY_FILTERS);
  const rows = rowsQuery.data?.rows;
  const [fsnSearch, setFsnSearch] = useState('');

  const { all, main, below, equal, review } = useMemo(() => {
    const all: SettlementRow[] = [];
    const main: SettlementRow[] = [];
    const below: SettlementRow[] = [];
    const equal: SettlementRow[] = [];
    const review: SettlementRow[] = [];

    for (const row of rows ?? []) {
      const entry: SettlementRow = { row, settlement: computeSettlement(row) };
      all.push(entry);
      if (entry.settlement.category === 'main') main.push(entry);
      else if (entry.settlement.category === 'below') below.push(entry);
      else if (entry.settlement.category === 'equal') equal.push(entry);
      else review.push(entry);
    }

    return { all, main, below, equal, review };
  }, [rows]);

  // The All tab's own FSN filter. Comma-separated: each term is matched on its
  // own and a row survives if any term is in its FSN, so pasting a column of
  // FSNs pulls exactly those listings up. An empty box means no filtering at
  // all — the tab stays the full, input-ordered list it was.
  const filteredAll = useMemo(() => {
    const terms = fsnSearch
      .split(',')
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean);
    if (terms.length === 0) return all;
    return all.filter((entry) => {
      const fsn = entry.row.fsn.toLowerCase();
      return terms.some((term) => fsn.includes(term));
    });
  }, [all, fsnSearch]);

  if (rowsQuery.isLoading && !rows) {
    return <Skeleton className="h-96 w-full" />;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Difference is <span className="font-medium text-foreground">Flipkart price − my price</span>; final bank
        settlement is <span className="font-medium text-foreground">current bank settlement + difference</span>. Click
        any row to open its listing in Flipkart Seller Hub.
      </p>

      <Tabs defaultValue="main" className="space-y-3">
        <TabsList>
          <TabsTrigger value="main">
            <CircleCheck className="mr-1.5 size-4" />
            Main list
            <CountBadge value={main.length} />
          </TabsTrigger>
          <TabsTrigger value="below">
            <TrendingDown className="mr-1.5 size-4" />
            Below threshold
            <CountBadge value={below.length} />
          </TabsTrigger>
          <TabsTrigger value="equal">
            <Equal className="mr-1.5 size-4" />
            No difference
            <CountBadge value={equal.length} />
          </TabsTrigger>
          <TabsTrigger value="review">
            <CircleHelp className="mr-1.5 size-4" />
            Needs review
            <CountBadge value={review.length} />
          </TabsTrigger>
          <TabsTrigger value="all">
            <List className="mr-1.5 size-4" />
            All
            <CountBadge value={all.length} />
          </TabsTrigger>
        </TabsList>

        <TabsContent value="main" className="mt-0 space-y-2">
          <p className="text-xs text-muted-foreground">Final bank settlement meets or beats the threshold.</p>
          <SettlementTable rows={main} columns={BASE_COLUMNS} emptyMessage="No listings clear their threshold yet." />
        </TabsContent>

        <TabsContent value="below" className="mt-0 space-y-2">
          <p className="text-xs text-muted-foreground">Final bank settlement falls short of the threshold.</p>
          <SettlementTable rows={below} columns={BASE_COLUMNS} emptyMessage="No listings are below their threshold." />
        </TabsContent>

        <TabsContent value="equal" className="mt-0 space-y-2">
          <p className="text-xs text-muted-foreground">
            Current price equals seller price, so the difference is 0. Excluded from the main and below-threshold lists.
          </p>
          <SettlementTable rows={equal} columns={BASE_COLUMNS} emptyMessage="No listings have a zero difference." />
        </TabsContent>

        <TabsContent value="review" className="mt-0 space-y-2">
          <p className="text-xs text-muted-foreground">
            Can&apos;t be settlement-evaluated — the reason is on each row.
          </p>
          <SettlementTable rows={review} columns={REVIEW_COLUMNS} emptyMessage="Every scraped row could be evaluated." />
        </TabsContent>

        <TabsContent value="all" className="mt-0 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Every row in the job, in input order — the List column says which of the other tabs it belongs to.
            </p>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" asChild>
                  {/* No filter params: the export endpoint's unfiltered response is
                      exactly this list, so the file always matches the tab. */}
                  <a href={`/api/jobs/${jobId}/export?format=xlsx`} download>
                    <FileSpreadsheet /> XLSX
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Downloads all {all.length} row{all.length === 1 ? '' : 's'} as an Excel workbook, with the settlement
                columns and every scraper field.
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-64 flex-1">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={fsnSearch}
                onChange={(event) => setFsnSearch(event.target.value)}
                placeholder="Search FSN — comma-separate to look up several at once…"
                className="pl-8"
              />
            </div>
            {fsnSearch.trim() !== '' && (
              <>
                <span className="tabular text-xs text-muted-foreground">
                  {filteredAll.length} of {all.length}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setFsnSearch('')}>
                  <X /> Clear
                </Button>
              </>
            )}
          </div>
          <SettlementTable
            rows={filteredAll}
            columns={ALL_COLUMNS}
            emptyMessage={fsnSearch.trim() === '' ? 'No rows in this job yet.' : 'No rows match that FSN search.'}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The little count pill shown after each sub-tab label. */
function CountBadge({ value }: { value: number }) {
  return (
    <span className="tabular ml-1.5 rounded-full bg-muted-foreground/15 px-1.5 text-[11px] leading-5 text-muted-foreground">
      {value}
    </span>
  );
}

/** No colour for a flat difference; positive and negative just get emphasis via the sign. */
function signClass(value: number | null): string {
  return cn('tabular', value !== null && value !== 0 && 'font-medium');
}
