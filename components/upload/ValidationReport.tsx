'use client';

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { shortenUrl } from '@/lib/format';
import type { ValidationReport as Report } from '@/lib/validation/uploadSchema';

/** Beyond this the list stops being a list and starts being a wall. */
const MAX_ISSUES_SHOWN = 100;
const MAX_PREVIEW_ROWS = 50;

export function ValidationReport({ report }: { report: Report }) {
  const shown = report.issues.slice(0, MAX_ISSUES_SHOWN);
  const hidden = report.issues.length - shown.length;

  return (
    <div className="space-y-4">
      {report.ok ? (
        <Alert variant="success">
          <CheckCircle2 />
          <AlertTitle>
            {report.rows.length} product{report.rows.length === 1 ? '' : 's'} ready to scrape
          </AlertTitle>
          <AlertDescription>
            {report.warningCount > 0
              ? `${report.warningCount} warning${report.warningCount === 1 ? '' : 's'} — review below, then start the batch.`
              : 'No problems found.'}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>
            {report.errorCount} error{report.errorCount === 1 ? '' : 's'} must be fixed first
          </AlertTitle>
          <AlertDescription>
            {report.rows.length} of {report.total} rows are valid. Fix the file and upload it again.
          </AlertDescription>
        </Alert>
      )}

      {report.issues.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b px-4 py-2.5">
            <h3 className="text-sm font-medium">Issues</h3>
          </div>
          <div className="max-h-72 overflow-y-auto scrollbar-thin">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead className="w-20">Row</TableHead>
                  <TableHead className="w-24">Type</TableHead>
                  <TableHead>Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((issue, index) => (
                  <TableRow key={`${issue.row}-${issue.code}-${index}`}>
                    <TableCell className="tabular text-muted-foreground">{issue.row ?? 'file'}</TableCell>
                    <TableCell>
                      <Badge variant={issue.severity === 'error' ? 'destructive' : 'secondary'}>
                        {issue.severity === 'error' ? (
                          <XCircle className="mr-1 size-3" />
                        ) : (
                          <AlertTriangle className="mr-1 size-3" />
                        )}
                        {issue.severity}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{issue.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {hidden > 0 && (
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">
              …and {hidden} more issue{hidden === 1 ? '' : 's'} not shown.
            </p>
          )}
        </Card>
      )}

      {report.rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <h3 className="text-sm font-medium">Products to scrape</h3>
            <span className="text-xs text-muted-foreground">
              showing {Math.min(MAX_PREVIEW_ROWS, report.rows.length)} of {report.rows.length}
            </span>
          </div>
          <div className="max-h-80 overflow-y-auto scrollbar-thin">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>FSN</TableHead>
                  <TableHead>Seller</TableHead>
                  <TableHead className="text-right">Curr. BS</TableHead>
                  <TableHead className="text-right">Threshold</TableHead>
                  <TableHead>URL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.slice(0, MAX_PREVIEW_ROWS).map((row, index) => (
                  <TableRow key={`${row.sku}-${index}`}>
                    <TableCell className="tabular text-muted-foreground">{index + 1}</TableCell>
                    <TableCell className="font-medium">{row.sku}</TableCell>
                    <TableCell className="tabular text-muted-foreground">{row.fsn}</TableCell>
                    <TableCell>{row.targetSeller}</TableCell>
                    <TableCell className="tabular text-right text-muted-foreground">
                      {row.currentBankSettlement ?? '—'}
                    </TableCell>
                    <TableCell className="tabular text-right text-muted-foreground">
                      {row.bankSettlementThreshold ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{shortenUrl(row.productUrl, 42)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}
