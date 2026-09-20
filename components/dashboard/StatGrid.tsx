'use client';

import {
  Activity,
  CheckCircle2,
  Clock,
  Hourglass,
  ListChecks,
  ListTodo,
  Package,
  Percent,
  XCircle,
} from 'lucide-react';
import { StatCard } from './StatCard';
import { formatDuration, formatEta, formatPercent } from '@/lib/format';
import type { JobStats } from '@/types/dashboard';

/** The nine cards from the spec, in one responsive grid. */
export function StatGrid({ stats }: { stats: JobStats }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatCard label="Total" value={stats.total} icon={Package} />
      <StatCard label="Pending" value={stats.pending} icon={ListTodo} tone="pending" />
      <StatCard label="Running" value={stats.running} icon={Activity} tone="running" />
      <StatCard label="Completed" value={stats.completed} icon={ListChecks} />
      <StatCard label="Succeeded" value={stats.succeeded} icon={CheckCircle2} tone="success" />
      <StatCard label="Failed" value={stats.failed} icon={XCircle} tone="failed" />
      <StatCard label="Success rate" value={formatPercent(stats.successRate)} icon={Percent} />
      <StatCard label="Average time" value={formatDuration(stats.averageMs)} icon={Clock} />
      <StatCard label="Est. remaining" value={formatEta(stats.estimatedRemainingMs)} icon={Hourglass} />
      <StatCard label="Queue length" value={stats.queueLength} icon={ListTodo} tone="pending" />
    </div>
  );
}
