import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  /** Ties the figure to the status palette, so "failed" is red wherever it appears. */
  tone?: 'default' | 'pending' | 'running' | 'success' | 'failed' | 'paused';
}

const TONES: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'text-foreground',
  pending: 'text-status-pending',
  running: 'text-status-running',
  success: 'text-status-success',
  failed: 'text-status-failed',
  paused: 'text-status-paused',
};

export function StatCard({ label, value, hint, icon: Icon, tone = 'default' }: StatCardProps) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {Icon && <Icon className={cn('size-4 shrink-0', TONES[tone])} aria-hidden />}
      </div>
      <p className={cn('tabular mt-2 text-2xl font-semibold leading-none', TONES[tone])}>{value}</p>
      {hint && <p className="mt-1.5 truncate text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}
