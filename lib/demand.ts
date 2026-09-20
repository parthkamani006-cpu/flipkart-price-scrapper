/**
 * Per-FSN order activity, as the pricing rules see it.
 *
 * Pure and dependency-free, exactly like `lib/settlement.ts`. The spreadsheet
 * reader that produces these lives in `lib/orders.ts` and pulls in SheetJS;
 * keeping the shapes and the zero-value here means the rules — which run in the
 * browser as well as on the server — never drag a spreadsheet parser into the
 * client bundle to find out what a demand record looks like.
 */

/** One FSN's order activity over the window an orders report covers. */
export interface FsnDemand {
  fsn: string;
  /** Units ordered inside the trailing 24-hour window. The zero-order test. */
  last24hUnits: number;
  /** Distinct order items in the same window — 3 units on 1 order is 1 here. */
  last24hOrders: number;
  /** Units ordered across the rest of the report. The baseline. */
  historyUnits: number;
  /** Days the baseline covers. Never zero, so the rate below is always safe. */
  historyDays: number;
  /** historyUnits / historyDays — "what this FSN normally does in a day". */
  unitsPerDay: number;
  /** Calendar days in the baseline that saw at least one order. */
  activeDays: number;
  /** Diagnostics. Not subtracted: a cancelled order still proves the price converted. */
  cancelledUnits: number;
  returnedUnits: number;
}

export interface OrdersReport {
  /** Earliest and latest `order_date` in the file, ISO. */
  windowStart: string;
  windowEnd: string;
  /** windowEnd − 24h. Everything after this is "the last 24 hours". */
  last24hStart: string;
  /** How many days the report spans. Drives the confidence damping. */
  observedDays: number;
  totalOrderItems: number;
  totalUnits: number;
  fsnCount: number;
  byFsn: Record<string, FsnDemand>;
}

/**
 * The demand record for an FSN the report never mentions: nothing sold.
 *
 * Flipkart's export has a row per order item, so an FSN with no orders in the
 * window simply has no rows. Absence is therefore *zero demand*, not missing
 * data, and returning a zeroed record rather than null is what stops a caller
 * from reading an idle listing as an unmeasured one. Genuinely unknown is a
 * different state entirely — no orders report uploaded at all.
 */
export function emptyDemand(fsn: string, historyDays: number): FsnDemand {
  return {
    fsn,
    last24hUnits: 0,
    last24hOrders: 0,
    historyUnits: 0,
    historyDays: Math.max(1, historyDays),
    unitsPerDay: 0,
    activeDays: 0,
    cancelledUnits: 0,
    returnedUnits: 0,
  };
}

/** An FSN's demand, zeroed rather than absent when the report does not list it. */
export function demandFor(report: OrdersReport, fsn: string): FsnDemand {
  return report.byFsn[fsn] ?? emptyDemand(fsn, report.observedDays - 1);
}
