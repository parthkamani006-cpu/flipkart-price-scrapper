'use client';

import { Download, FileSpreadsheet } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { RecommendationTable } from '@/components/recommendations/RecommendationTable';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';

export default function RecommendationsPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const query = useQuery({ queryKey: ['recommendations', jobId], queryFn: () => api.recommendations(jobId) });

  if (query.isLoading) return <div className="w-full space-y-4 p-4 xl:p-5"><Skeleton className="h-8 w-64" /><Skeleton className="h-96 w-full" /></div>;
  if (query.isError || !query.data) {
    return <div className="w-full p-4 xl:p-5"><Alert variant="destructive"><AlertTitle>Could not load output</AlertTitle><AlertDescription>{query.error instanceof Error ? query.error.message : 'No output was generated.'}</AlertDescription></Alert></div>;
  }

  const file = query.data.recommendations;
  return (
    <div className="w-full space-y-5 p-4 xl:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Recommendation output — {file.jobName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{file.summary}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" asChild><Link href={`/jobs/${jobId}`}>Open batch</Link></Button>
          <Button variant="outline" size="sm" asChild><a href={`/api/jobs/${jobId}/recommendations/export?format=csv`} download><Download /> CSV</a></Button>
          <Button variant="outline" size="sm" asChild><a href={`/api/jobs/${jobId}/recommendations/export?format=xlsx`} download><FileSpreadsheet /> XLSX</a></Button>
        </div>
      </div>
      <RecommendationTable rows={file.recommendations} />
    </div>
  );
}
