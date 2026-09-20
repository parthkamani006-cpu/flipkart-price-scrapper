'use client';

import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { RowStatus, ScrapeStatus } from '@/types/dashboard';

export interface QueueFilters {
  search: string;
  status: RowStatus[];
  reason: ScrapeStatus[];
  sku: string;
  fsn: string;
  seller: string;
  url: string;
  from: string;
  to: string;
  minDuration: string;
  maxDuration: string;
}

export const EMPTY_FILTERS: QueueFilters = {
  search: '',
  status: [],
  reason: [],
  sku: '',
  fsn: '',
  seller: '',
  url: '',
  from: '',
  to: '',
  minDuration: '',
  maxDuration: '',
};

const STATUSES: RowStatus[] = ['pending', 'running', 'success', 'failed', 'paused', 'cancelled'];

const REASONS: ScrapeStatus[] = [
  'PRODUCT_UNAVAILABLE',
  'NO_SELLER_LINK',
  'SELLER_LIST_LOAD_FAILED',
  'SELLER_NOT_FOUND',
  'MAIN_PRICE_NOT_FOUND',
  'SELLER_PRICE_NOT_FOUND',
  'BLOCKED',
  'ERROR',
];

interface Props {
  filters: QueueFilters;
  onChange: (filters: QueueFilters) => void;
  matched: number;
  total: number;
  /** Rendered on the right — usually the export buttons. */
  actions?: React.ReactNode;
}

export function FilterBar({ filters, onChange, matched, total, actions }: Props) {
  const set = <K extends keyof QueueFilters>(key: K, value: QueueFilters[K]) =>
    onChange({ ...filters, [key]: value });

  const toggle = <K extends 'status' | 'reason'>(key: K, value: QueueFilters[K][number]) => {
    const current = filters[key] as string[];
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    onChange({ ...filters, [key]: next as QueueFilters[K] });
  };

  const dirty = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.search}
            onChange={(event) => set('search', event.target.value)}
            placeholder="Search SKU, FSN, seller, URL, status or failure reason…"
            className="pl-8"
          />
        </div>

        {actions}

        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_FILTERS)}>
            <X /> Clear
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {STATUSES.map((status) => (
          <Chip
            key={status}
            active={filters.status.includes(status)}
            onClick={() => toggle('status', status)}
          >
            {status}
          </Chip>
        ))}
      </div>

      <details className="group">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          More filters
        </summary>

        <div className="mt-3 space-y-3 rounded-md border p-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Labelled label="SKU">
              <Input value={filters.sku} onChange={(event) => set('sku', event.target.value)} />
            </Labelled>
            <Labelled label="FSN">
              <Input value={filters.fsn} onChange={(event) => set('fsn', event.target.value)} />
            </Labelled>
            <Labelled label="Seller">
              <Input value={filters.seller} onChange={(event) => set('seller', event.target.value)} />
            </Labelled>
            <Labelled label="Product URL">
              <Input value={filters.url} onChange={(event) => set('url', event.target.value)} />
            </Labelled>
            <Labelled label="Finished from">
              <Input type="date" value={filters.from} onChange={(event) => set('from', event.target.value)} />
            </Labelled>
            <Labelled label="Finished to">
              <Input type="date" value={filters.to} onChange={(event) => set('to', event.target.value)} />
            </Labelled>
            <Labelled label="Min duration (ms)">
              <Input
                type="number"
                value={filters.minDuration}
                onChange={(event) => set('minDuration', event.target.value)}
              />
            </Labelled>
            <Labelled label="Max duration (ms)">
              <Input
                type="number"
                value={filters.maxDuration}
                onChange={(event) => set('maxDuration', event.target.value)}
              />
            </Labelled>
          </div>

          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">Failure reason</p>
            <div className="flex flex-wrap gap-1.5">
              {REASONS.map((reason) => (
                <Chip
                  key={reason}
                  active={filters.reason.includes(reason)}
                  onClick={() => toggle('reason', reason)}
                >
                  {reason}
                </Chip>
              ))}
            </div>
          </div>
        </div>
      </details>

      <p className="tabular text-xs text-muted-foreground">
        {matched === total ? `${total} products` : `${matched} of ${total} products match`}
      </p>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md border px-2 py-0.5 text-xs transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
