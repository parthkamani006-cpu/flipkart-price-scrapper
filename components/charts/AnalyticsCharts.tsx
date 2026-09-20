'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { CHART, CHART_INK } from './palette';

/** Shared tooltip styling so every chart's hover layer matches the app surface. */
const TOOLTIP_STYLE = {
  contentStyle: {
    background: CHART_INK.surface,
    border: `1px solid ${CHART_INK.grid}`,
    borderRadius: 8,
    fontSize: 12,
    color: CHART_INK.text,
  },
  labelStyle: { color: CHART_INK.text },
} as const;

export function AnalyticsCharts({ jobId }: { jobId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', jobId],
    queryFn: () => api.analytics(jobId),
    refetchInterval: 10_000,
  });

  if (isLoading || !data) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-64 w-full" />
        ))}
      </div>
    );
  }

  const totalOutcome = data.outcome.reduce((sum, slice) => sum + slice.value, 0);
  const outcomeColors = [CHART.good, CHART.critical, CHART.pending];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <ChartCard title="Outcome" subtitle={`${totalOutcome} products`}>
        {totalOutcome === 0 ? (
          <Empty />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie
                data={data.outcome.filter((slice) => slice.value > 0)}
                dataKey="value"
                nameKey="name"
                innerRadius={55}
                outerRadius={85}
                paddingAngle={2}
                // Direct label on every slice — the secondary encoding that lets
                // the green/red pair be read without relying on hue.
                label={({ name, value }) => `${name}: ${value}`}
                labelLine={false}
              >
                {data.outcome
                  .filter((slice) => slice.value > 0)
                  .map((slice) => (
                    <Cell
                      key={slice.name}
                      fill={outcomeColors[data.outcome.findIndex((o) => o.name === slice.name)]}
                      stroke={CHART_INK.surface}
                      strokeWidth={2}
                    />
                  ))}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard
        title="Average scrape time"
        subtitle={data.averageMs ? `avg ${formatDuration(data.averageMs)} · median ${formatDuration(data.medianMs)}` : 'no data yet'}
      >
        {data.durations.every((bucket) => bucket.count === 0) ? (
          <Empty />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data.durations} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: CHART_INK.axis }} tickLine={false} axisLine={{ stroke: CHART_INK.grid }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: CHART_INK.axis }} tickLine={false} axisLine={false} />
              <Tooltip {...TOOLTIP_STYLE} cursor={{ fill: CHART_INK.grid, opacity: 0.3 }} />
              <Bar dataKey="count" fill={CHART.series} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Products per hour" subtitle="throughput over the run">
        {data.perHour.length === 0 ? (
          <Empty message="Throughput appears once products finish." />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.perHour} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <XAxis dataKey="hour" tick={{ fontSize: 10, fill: CHART_INK.axis }} tickLine={false} axisLine={{ stroke: CHART_INK.grid }} tickFormatter={(value: string) => value.slice(11)} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: CHART_INK.axis }} tickLine={false} axisLine={false} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="succeeded" name="Succeeded" stroke={CHART.good} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="failed" name="Failed" stroke={CHART.critical} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Failure reasons" subtitle={`${data.failureReasons.reduce((sum, r) => sum + r.count, 0)} failures`}>
        {data.failureReasons.length === 0 ? (
          <Empty message="No failures — nothing to break down." />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart
              data={data.failureReasons}
              layout="vertical"
              margin={{ top: 4, right: 16, bottom: 0, left: 8 }}
            >
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: CHART_INK.axis }} tickLine={false} axisLine={{ stroke: CHART_INK.grid }} />
              <YAxis type="category" dataKey="reason" width={150} tick={{ fontSize: 10, fill: CHART_INK.axis }} tickLine={false} axisLine={false} />
              <Tooltip {...TOOLTIP_STYLE} cursor={{ fill: CHART_INK.grid, opacity: 0.3 }} />
              <Bar dataKey="count" fill={CHART.critical} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Seller distribution" subtitle="top sellers by product count" className="md:col-span-2">
        {data.sellers.length === 0 ? (
          <Empty />
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(200, data.sellers.length * 34)}>
            <BarChart
              data={data.sellers}
              layout="vertical"
              margin={{ top: 4, right: 16, bottom: 0, left: 8 }}
            >
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: CHART_INK.axis }} tickLine={false} axisLine={{ stroke: CHART_INK.grid }} />
              <YAxis type="category" dataKey="seller" width={160} tick={{ fontSize: 11, fill: CHART_INK.axis }} tickLine={false} axisLine={false} />
              <Tooltip {...TOOLTIP_STYLE} cursor={{ fill: CHART_INK.grid, opacity: 0.3 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {/* Stacked, with a 2px surface gap between segments so succeeded and
                  failed never bleed into one another. Both segments carry a legend. */}
              <Bar dataKey="succeeded" name="Succeeded" stackId="s" fill={CHART.good} stroke={CHART_INK.surface} strokeWidth={2} />
              <Bar dataKey="failed" name="Failed" stackId="s" fill={CHART.critical} stroke={CHART_INK.surface} strokeWidth={2} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Empty({ message = 'No data yet.' }: { message?: string }) {
  return <div className="flex h-60 items-center justify-center text-sm text-muted-foreground">{message}</div>;
}
