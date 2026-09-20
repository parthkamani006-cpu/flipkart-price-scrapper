'use client';

import { Download, FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  jobId: string;
  /** Current filter query string, so the export matches what is on screen. */
  params: URLSearchParams;
  matched: number;
}

export function ExportButtons({ jobId, params, matched }: Props) {
  const href = (format: 'csv' | 'xlsx') => {
    const next = new URLSearchParams(params);
    next.delete('limit');
    next.set('format', format);
    return `/api/jobs/${jobId}/export?${next.toString()}`;
  };

  const filtered = [...params.keys()].some((key) => key !== 'limit');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={href('csv')} download>
              <Download /> CSV
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={href('xlsx')} download>
              <FileSpreadsheet /> XLSX
            </a>
          </Button>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        Exports the {matched} product{matched === 1 ? '' : 's'} currently
        {filtered ? ' matching your filters' : ' in this batch'}, with every scraper field.
      </TooltipContent>
    </Tooltip>
  );
}
