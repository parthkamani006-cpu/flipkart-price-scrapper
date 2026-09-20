import * as XLSX from 'xlsx';
import type { ScrapeInput } from '@/scraper/types';

/** Flipkart's listing export carries no link column; the pid link redirects to the product page. */
const PRODUCT_URL_PREFIX = 'https://www.flipkart.com/product/p/itme?pid=';

const SKU_HEADERS = ['seller sku id', 'sku seller id', 'seller sku', 'sku'];
const FSN_HEADERS = ['flipkart serial number', 'fsn'];
const CURRENT_SETTLEMENT_HEADERS = ['bank settlement', 'current bank settlement'];
const MINIMUM_SETTLEMENT_HEADERS = ['minimum bank settlement price', 'minimum bank settlement'];

/** Sheet 1 — listing data: SKU Seller Id, FSN, Current Bank Settlement. */
export function spreadsheetToScrapeRows(
  buffer: ArrayBuffer,
  targetSeller: string,
  minimumBySku: Map<string, string>,
): ScrapeInput[] {
  const table = readTable(buffer);
  const headerIndex = table.findIndex((row) => {
    const headers = row.map(normalize);
    return hasAny(headers, SKU_HEADERS) && hasAny(headers, FSN_HEADERS) && hasAny(headers, CURRENT_SETTLEMENT_HEADERS);
  });
  if (headerIndex < 0) return [];
  const headers = table[headerIndex].map(normalize);
  const sku = findColumn(headers, SKU_HEADERS);
  const fsn = findColumn(headers, FSN_HEADERS);
  const current = findColumn(headers, CURRENT_SETTLEMENT_HEADERS);
  const link = headers.indexOf('flipkart link');

  return table.slice(headerIndex + 1).flatMap((row) => {
    const skuValue = cellText(row[sku]);
    const fsnValue = cellText(row[fsn]);
    if (!skuValue && !fsnValue) return [];
    // Flipkart's export puts a row of column descriptions directly under the headers.
    if (isDescriptionRow(skuValue, fsnValue)) return [];
    const productUrl = link >= 0 ? cellText(row[link]) : '';
    const minimum = minimumBySku.get(skuValue);
    return [
      {
        productUrl: productUrl || `${PRODUCT_URL_PREFIX}${encodeURIComponent(fsnValue)}`,
        targetSeller,
        fsn: fsnValue,
        sku: skuValue,
        currentBankSettlement: toNumber(cellText(row[current])),
        // Left off entirely when sheet 2 has no line for this SKU, so the
        // validator can tell "not supplied" from "supplied and unreadable".
        ...(minimum === undefined ? {} : { bankSettlementThreshold: toNumber(minimum) }),
      },
    ];
  });
}

/** Sheet 2 — SKU-wise Minimum Bank Settlement, keyed by SKU Seller Id. */
export function minimumSettlementBySku(buffer: ArrayBuffer): Map<string, string> {
  const table = readTable(buffer);
  const headerIndex = table.findIndex((row) => {
    const headers = row.map(normalize);
    return hasAny(headers, SKU_HEADERS) && hasAny(headers, MINIMUM_SETTLEMENT_HEADERS);
  });
  if (headerIndex < 0) return new Map();
  const headers = table[headerIndex].map(normalize);
  const sku = findColumn(headers, SKU_HEADERS);
  const minimum = findColumn(headers, MINIMUM_SETTLEMENT_HEADERS);

  const values = new Map<string, string>();
  for (const row of table.slice(headerIndex + 1)) {
    const skuValue = cellText(row[sku]);
    const minimumValue = cellText(row[minimum]);
    if (skuValue && minimumValue) values.set(skuValue, minimumValue);
  }
  return values;
}

function readTable(buffer: ArrayBuffer): unknown[][] {
  const workbook = XLSX.read(Buffer.from(buffer), { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false });
}

function findColumn(headers: string[], names: readonly string[]): number {
  for (const name of names) {
    const index = headers.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

function hasAny(headers: string[], names: readonly string[]): boolean {
  return names.some((name) => headers.includes(name));
}

function isDescriptionRow(sku: string, fsn: string): boolean {
  return sku.toLowerCase().includes('identifier for a product') || fsn.toLowerCase().includes('identifier of the product');
}

/** Empty is "not a number" here, not zero — a blank settlement cell is a missing value. */
function toNumber(value: string): number {
  return value === '' ? Number.NaN : Number(value);
}

function cellText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
