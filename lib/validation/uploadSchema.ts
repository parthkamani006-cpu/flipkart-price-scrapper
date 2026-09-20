import { resultKey } from '@/scraper/journal';
import type { ScrapeInput } from '@/scraper/types';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  row: number | null;
  field?: string;
  code: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  total: number;
  rows: ScrapeInput[];
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
}

export function validateUpload(text: string): ValidationReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, '').trim());
  } catch {
    return report([], [{ severity: 'error', row: null, code: 'INVALID_JSON', message: 'The file is not valid JSON.' }], 0);
  }
  if (!Array.isArray(parsed)) return report([], [{ severity: 'error', row: null, code: 'NOT_AN_ARRAY', message: 'The file must contain a JSON array of products.' }], 0);

  const rows: ScrapeInput[] = [];
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  parsed.forEach((value, index) => {
    const row = index + 1;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ severity: 'error', row, code: 'NOT_AN_OBJECT', message: 'Each product must be an object.' });
      return;
    }
    const input = value as Record<string, unknown>;
    const productUrl = typeof input.productUrl === 'string' ? input.productUrl.trim() : '';
    const targetSeller = typeof input.targetSeller === 'string' ? input.targetSeller.trim() : '';
    const fsn = typeof input.fsn === 'string' ? input.fsn.trim() : '';
    const sku = typeof input.sku === 'string' ? input.sku.trim() : '';
    const currentBankSettlement = toNumber(input.currentBankSettlement);
    const bankSettlementThreshold = toNumber(input.bankSettlementThreshold);
    if (!productUrl || !targetSeller || !fsn || !sku || !Number.isFinite(currentBankSettlement)) {
      issues.push({ severity: 'error', row, code: 'FIELD_INVALID', message: 'SKU Seller ID, FSN, Current Bank Settlement, and account are required.' });
      return;
    }
    const item: ScrapeInput = { productUrl, targetSeller, fsn, sku, currentBankSettlement };
    if (Number.isFinite(bankSettlementThreshold)) {
      item.bankSettlementThreshold = bankSettlementThreshold;
    } else {
      issues.push({ severity: 'warning', row, field: 'bankSettlementThreshold', code: 'NO_MINIMUM_SETTLEMENT', message: `No Minimum Bank Settlement for SKU "${sku}" in the second sheet.` });
    }
    const key = resultKey(item);
    if (seen.has(key)) {
      issues.push({ severity: 'error', row, code: 'DUPLICATE', message: 'Duplicate Flipkart Link and SKU Seller ID.' });
      return;
    }
    seen.add(key);
    rows.push(item);
  });
  return report(rows, issues, parsed.length);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value.trim());
  return Number.NaN;
}

function report(rows: ScrapeInput[], issues: ValidationIssue[], total: number): ValidationReport {
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  return { ok: errorCount === 0 && rows.length > 0, total, rows, issues, errorCount, warningCount: issues.length - errorCount };
}
