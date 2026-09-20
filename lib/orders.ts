/**
 * The Flipkart Orders report, folded into per-FSN demand.
 *
 * Seller Hub's "Orders" export is the only place the system can learn whether a
 * listing is actually converting. The pricing rules do not want 1,400 order
 * lines; they want one question answered per FSN — "did this sell in the last
 * 24 hours, and how unusual is the answer?" — so the report is reduced to that
 * here, once, at upload time.
 *
 * Two properties of the real export drive the shape of this file:
 *
 *   * ITS DECLARED RANGE LIES. The supplied report carries ~50,000 populated
 *     cells while `!ref` says `A1:AM1`. SheetJS honours `!ref`, so reading it
 *     the obvious way returns a header row and no orders at all — a silent zero,
 *     which is the most dangerous possible failure for a rule that cuts prices
 *     when it sees zero. The range is rebuilt from the cell addresses instead.
 *
 *   * AN FSN WITH NO ORDERS HAS NO ROWS. Absence from the report is not missing
 *     data, it *is* zero demand, and `demandFor` returns a zeroed record rather
 *     than null so the caller cannot accidentally read "no rows" as "unknown".
 *     Genuinely unknown is a different thing: no report uploaded at all.
 */

import * as XLSX from 'xlsx';
import { emptyDemand, type FsnDemand, type OrdersReport } from '@/lib/demand';

// Re-exported so a caller that already imports the reader does not need a second
// import for the shapes it returns.
export { demandFor, emptyDemand } from '@/lib/demand';
export type { FsnDemand, OrdersReport } from '@/lib/demand';

const MS_PER_DAY = 86_400_000;

/**
 * Read a Seller Hub orders export into per-FSN demand.
 *
 * Returns null when the file holds no readable orders, so the caller can say
 * "that is not an orders report" rather than proceeding with an empty one.
 */
export function parseOrdersReport(buffer: ArrayBuffer): OrdersReport | null {
  const workbook = XLSX.read(Buffer.from(buffer), { type: 'buffer' });
  const sheet = findOrdersSheet(workbook);
  if (!sheet) return null;

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(repairRange(sheet), {
    defval: null,
    raw: false,
  });

  interface Parsed {
    fsn: string;
    at: number;
    units: number;
    status: string;
  }

  const parsed: Parsed[] = [];
  for (const row of rows) {
    const fsn = text(row.fsn ?? row.FSN);
    const at = parseOrderDate(row.order_date ?? row['Order Date']);
    if (!fsn || at === null) continue;

    parsed.push({
      fsn,
      at,
      // A missing quantity on a real order line is one unit, not zero units.
      units: Math.max(1, number(row.quantity ?? row.Quantity) ?? 1),
      status: text(row.order_item_status ?? row['Order Item Status']).toUpperCase(),
    });
  }

  if (parsed.length === 0) return null;

  // The window is the report's own, not the wall clock: a report downloaded
  // yesterday still has a well-defined "last 24 hours of what it contains", and
  // anchoring to `now` would silently empty it as it ages.
  const windowEnd = Math.max(...parsed.map((order) => order.at));
  const windowStart = Math.min(...parsed.map((order) => order.at));
  const last24hStart = windowEnd - MS_PER_DAY;
  const observedDays = (windowEnd - windowStart) / MS_PER_DAY;
  const historyDays = Math.max(1, observedDays - 1);

  const byFsn: Record<string, FsnDemand> = {};
  const activeDays = new Map<string, Set<string>>();

  for (const order of parsed) {
    const demand = (byFsn[order.fsn] ??= emptyDemand(order.fsn, historyDays));

    if (order.at > last24hStart) {
      demand.last24hUnits += order.units;
      demand.last24hOrders += 1;
    } else {
      demand.historyUnits += order.units;
      const days = activeDays.get(order.fsn) ?? new Set<string>();
      days.add(new Date(order.at).toISOString().slice(0, 10));
      activeDays.set(order.fsn, days);
    }

    if (order.status === 'CANCELLED') demand.cancelledUnits += order.units;
    if (order.status === 'RETURNED' || order.status === 'RETURN_REQUESTED') {
      demand.returnedUnits += order.units;
    }
  }

  for (const demand of Object.values(byFsn)) {
    demand.activeDays = activeDays.get(demand.fsn)?.size ?? 0;
    demand.unitsPerDay = demand.historyUnits / demand.historyDays;
  }

  return {
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    last24hStart: new Date(last24hStart).toISOString(),
    observedDays,
    totalOrderItems: parsed.length,
    totalUnits: parsed.reduce((sum, order) => sum + order.units, 0),
    fsnCount: Object.keys(byFsn).length,
    byFsn,
  };
}

/* ---------------------------------------------------------------- reading */

/** The "Orders" sheet by name, falling back to the first sheet that has an FSN column. */
function findOrdersSheet(workbook: XLSX.WorkBook): XLSX.WorkSheet | null {
  const named = workbook.SheetNames.find((name) => name.trim().toLowerCase() === 'orders');
  if (named) return workbook.Sheets[named];

  for (const name of workbook.SheetNames) {
    const sheet = repairRange(workbook.Sheets[name]);
    const header = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, range: 0 })[0] ?? [];
    const normalized = header.map((cell) => text(cell).toLowerCase());
    if (normalized.includes('fsn') && normalized.includes('order_date')) return sheet;
  }

  return null;
}

/**
 * Widen `!ref` to cover every populated cell.
 *
 * Flipkart's export declares a one-row range over a 1,375-row sheet. Nothing is
 * narrowed here — the range is only ever grown — so a well-formed workbook is
 * left exactly as it was.
 */
function repairRange(sheet: XLSX.WorkSheet): XLSX.WorkSheet {
  let maxRow = 0;
  let maxColumn = 0;

  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!')) continue;
    const { r, c } = XLSX.utils.decode_cell(address);
    if (r > maxRow) maxRow = r;
    if (c > maxColumn) maxColumn = c;
  }

  const declared = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
  if (declared && declared.e.r >= maxRow && declared.e.c >= maxColumn) return sheet;

  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxColumn } });
  return sheet;
}

/**
 * `order_date` as an epoch, or null.
 *
 * The export writes `2026-07-31 20:59:26` — space-separated, no zone, which
 * `new Date()` parses as local time on Node but is rejected outright by some
 * engines. Normalising the separator makes it an unambiguous local-time literal
 * everywhere. Only the *difference* between two of these matters downstream, so
 * the choice of zone cannot shift the 24-hour boundary.
 */
function parseOrderDate(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  const raw = text(value);
  if (!raw) return null;

  const time = new Date(raw.replace(' ', 'T')).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * Cell text with Flipkart's quoting removed.
 *
 * SKU and title cells arrive as `"""SKU:PV-KNF-03"""` — a quoted CSV field that
 * was quoted again on the way into the workbook. FSN cells are clean today, but
 * stripping uniformly costs nothing and stops a future quoted FSN from silently
 * failing to join.
 */
function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/^["']+|["']+$/g, '').trim();
}

function number(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Number(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
