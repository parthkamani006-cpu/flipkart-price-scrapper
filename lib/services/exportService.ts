/**
 * CSV and XLSX export.
 *
 * Both formats emit the same columns from the same builder, so the two exports
 * can never disagree about what a batch contained. Every scraper field is
 * included — the point of the dashboard is that nobody has to convert JSON by
 * hand afterwards.
 */

// Type-only, so exceljs itself is still loaded lazily by the two writers below.
import type { Workbook } from 'exceljs';
import type { Recommendation } from '@/lib/recommendation';
import { computeSettlement, SETTLEMENT_CATEGORY_LABEL, sellerListingUrl } from '@/lib/settlement';
import type { JobManifest, JobRow } from '@/types/dashboard';

/** Generic over the row type so the queue and the recommendations share one writer. */
interface Column<T = JobRow> {
  header: string;
  width: number;
  value: (row: T) => string | number | Date | null;
  /** Excel number format, for columns that are not plain text. */
  numFmt?: string;
}

/** A stored timestamp as a real Date, so XLSX gets a sortable date cell. Null when absent or unparseable. */
function toDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Round to two decimals for export, keeping null as an empty cell. */
function round2(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

const COLUMNS: Column[] = [
  { header: 'Index', width: 8, value: (row) => row.index + 1 },
  { header: 'SKU', width: 18, value: (row) => row.sku },
  { header: 'FSN', width: 20, value: (row) => row.fsn },
  { header: 'Target Seller', width: 22, value: (row) => row.targetSeller },
  { header: 'Matched Seller', width: 22, value: (row) => row.result?.sellerName ?? null },
  // The seller holding the buy box. Empty for rows scraped before this was captured.
  { header: 'Winning Seller Name', width: 22, value: (row) => row.result?.buyboxSellerName ?? null },
  { header: 'Status', width: 12, value: (row) => row.status },
  { header: 'Scrape Status', width: 22, value: (row) => row.result?.status ?? null },
  { header: 'Flipkart Price', width: 14, value: (row) => row.result?.mainPrice ?? null },
  { header: 'My Price', width: 12, value: (row) => row.result?.sellerPrice ?? null },
  // YES when the winning seller is our own seller. Empty when no winner was read.
  {
    header: 'Buybox',
    width: 10,
    value: (row) => {
      const hasBuybox = computeSettlement(row).hasBuybox;
      return hasBuybox === null ? null : hasBuybox ? 'YES' : 'NO';
    },
  },
  // Difference here is the dashboard's direction (current − seller), matching the
  // settlement view and the queue's Diff column, not the journal's stored sign.
  { header: 'Difference', width: 12, value: (row) => computeSettlement(row).difference },
  { header: 'Difference %', width: 12, value: (row) => round2(computeSettlement(row).differencePct) },
  { header: 'Current Bank Settlement', width: 20, value: (row) => row.currentBankSettlement ?? null },
  { header: 'Minimum Bank Settlement', width: 22, value: (row) => row.bankSettlementThreshold ?? null },
  { header: 'Final Bank Settlement', width: 20, value: (row) => round2(computeSettlement(row).finalBankSettlement) },
  { header: 'Settlement List', width: 16, value: (row) => SETTLEMENT_CATEGORY_LABEL[computeSettlement(row).category] },
  // Only the "Needs review" rows carry a reason; everything else exports empty.
  { header: 'Settlement Reason', width: 24, value: (row) => computeSettlement(row).reason },
  {
    header: 'Price Different',
    width: 14,
    value: (row) => (row.result ? (row.result.isPriceDifferent ? 'YES' : 'NO') : null),
  },
  { header: 'Sellers Scanned', width: 14, value: (row) => row.result?.sellersScanned ?? null },
  { header: 'Show More Clicks', width: 16, value: (row) => row.result?.showMoreClicks ?? null },
  { header: 'Source', width: 10, value: (row) => row.result?.source ?? null },
  { header: 'Duration (ms)', width: 14, value: (row) => row.durationMs ?? null },
  { header: 'Attempts', width: 10, value: (row) => row.attempts ?? null },
  // Stamped when a row succeeds or fails, so this is the scrape's completion time.
  { header: 'Finished At', width: 22, value: (row) => toDate(row.finishedAt), numFmt: 'dd/mm/yyyy hh:mm:ss' },
  { header: 'Message', width: 48, value: (row) => row.message ?? null },
  // No Screenshot column: the worker runs on a GitHub Actions runner whose
  // filesystem is destroyed when the job ends, so failure screenshots are no
  // longer captured. `Message` carries what they were being consulted for.
  { header: 'Product URL', width: 60, value: (row) => row.productUrl },
  // The Seller Hub listing deep link a settlement row opens when clicked, so the
  // export lands on the same page the dashboard does. Empty without an FSN.
  { header: 'Seller Link', width: 60, value: (row) => (row.fsn ? sellerListingUrl(row.fsn) : null) },
];

export function exportFilename(manifest: JobManifest, extension: string, suffix?: string): string {
  const safe = manifest.name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const stamp = manifest.createdAt.slice(0, 10);
  return `${safe || manifest.id}${suffix ? `-${suffix}` : ''}-${stamp}.${extension}`;
}

/* --------------------------------------------------------------------- CSV */

/**
 * Quote a CSV field.
 *
 * A leading =, +, - or @ is prefixed with a quote so spreadsheets treat it as
 * text: a seller literally named "=cmd" should never become a formula in
 * someone's Excel.
 */
function csvCell(value: string | number | Date | null): string {
  if (value === null || value === undefined) return '';

  // A number is never a formula, so a negative price stays a negative number
  // rather than becoming the text "'-7". The injection guard is for text only.
  if (typeof value === 'number') return String(value);

  // CSV has no date type, so timestamps stay ISO — unambiguous and sortable as text.
  if (value instanceof Date) return value.toISOString();

  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Generate CSV incrementally so a large batch never sits in memory as one string. */
export function* csvLinesFor<T>(rows: T[], columns: Column<T>[]): Generator<string> {
  // BOM so Excel opens UTF-8 (₹, seller names) correctly instead of as mojibake.
  yield `﻿${columns.map((column) => csvCell(column.header)).join(',')}\r\n`;

  for (const row of rows) {
    yield `${columns.map((column) => csvCell(column.value(row))).join(',')}\r\n`;
  }
}

export function* csvLines(rows: JobRow[]): Generator<string> {
  yield* csvLinesFor(rows, COLUMNS);
}

function streamFor<T>(rows: T[], columns: Column<T>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = csvLinesFor(rows, columns);

  return new ReadableStream({
    pull(controller) {
      const next = iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
  });
}

export function csvStream(rows: JobRow[]): ReadableStream<Uint8Array> {
  return streamFor(rows, COLUMNS);
}

/* -------------------------------------------------------------------- XLSX */

/**
 * Build an XLSX workbook.
 *
 * exceljs is imported lazily: it is a heavy dependency and only this one route
 * needs it, so loading it at module scope would tax every other request.
 */
/**
 * One worksheet, written the way every sheet in this app is written: bold frozen
 * header, real column widths, and an autofilter over the populated range so the
 * file is usable the instant it opens.
 */
function addSheet<T>(workbook: Workbook, name: string, columns: Column<T>[], rows: T[]): void {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });

  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.header,
    width: column.width,
    ...(column.numFmt ? { style: { numFmt: column.numFmt } } : {}),
  }));
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    sheet.addRow(columns.map((column) => column.value(row)));
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: rows.length + 1, column: columns.length },
  };
}

export async function xlsxBuffer(manifest: JobManifest, rows: JobRow[]): Promise<Buffer> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();

  workbook.creator = 'Flipkart Scraper Dashboard';
  workbook.created = new Date(manifest.createdAt);

  addSheet(workbook, 'Results', COLUMNS, rows);

  const summary = workbook.addWorksheet('Summary');
  const succeeded = rows.filter((row) => row.result?.status === 'OK').length;
  const failed = rows.filter((row) => row.result && row.result.status !== 'OK').length;

  summary.columns = [
    { header: 'Field', key: 'field', width: 24 },
    { header: 'Value', key: 'value', width: 44 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.addRows([
    ['Batch', manifest.name],
    ['Job ID', manifest.id],
    ['Created', manifest.createdAt],
    ['Started', manifest.startedAt ?? '—'],
    ['Finished', manifest.finishedAt ?? '—'],
    ['State', manifest.state],
    ['Total products', manifest.total],
    ['Exported rows', rows.length],
    ['Succeeded', succeeded],
    ['Failed', failed],
    ['Still pending', rows.length - succeeded - failed],
    ['Delay between products (ms)', manifest.options.delayMs],
  ]);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/* ---------------------------------------------------------- recommendations */

/**
 * The recommendation export.
 *
 * Only the first tab — Price change (Diff) — is exported. It is the actionable
 * list, and its columns are the ones the tab itself shows, so what the user saw
 * on screen is what lands in the file.
 */
const RECOMMENDATION_COLUMNS: Column<Recommendation>[] = [
  // Matches the queue export's Index: the upload's own row number, 1-based.
  { header: 'Index', width: 8, value: (item) => item.index + 1 },
  { header: 'SKU', width: 18, value: (item) => item.sku },
  { header: 'FSN', width: 20, value: (item) => item.fsn },
  { header: 'Diff Amount', width: 16, value: (item) => round2(item.diffAmount) },
  { header: 'Status', width: 28, value: (item) => item.status },
  { header: 'Final Bank Settlement', width: 22, value: (item) => round2(item.finalBankSettlement) },
  // Why a row is Need Review / Threshold Missing. Empty for rows that were scored.
  { header: 'Reason', width: 40, value: (item) => item.reason },
];

export function recommendationCsvStream(rows: Recommendation[]): ReadableStream<Uint8Array> {
  return streamFor(rows, RECOMMENDATION_COLUMNS);
}

export async function recommendationXlsxBuffer(
  manifest: JobManifest,
  rows: Recommendation[],
  meta: { accountName: string; generatedAt: string; summary: string },
): Promise<Buffer> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();

  workbook.creator = 'Flipkart Scraper Dashboard';
  workbook.created = new Date(manifest.createdAt);

  addSheet(workbook, 'Recommendations', RECOMMENDATION_COLUMNS, rows);

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [
    { header: 'Field', key: 'field', width: 24 },
    { header: 'Value', key: 'value', width: 60 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.addRows([
    ['Account', meta.accountName],
    ['Upload', manifest.name],
    ['Job ID', manifest.id],
    ['Recommendations generated', meta.generatedAt],
    ['Rows exported', rows.length],
    ['Overall', meta.summary],
  ]);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
