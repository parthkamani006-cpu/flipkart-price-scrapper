/**
 * Display formatting. Kept in one place so a duration reads the same way in the
 * stat cards, the queue table, the log viewer and the export.
 */

/** `1m 04s`, `3.2s`, `840ms`. Compact enough for a table cell. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);

  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Coarser than formatDuration, for estimates.
 *
 * An ETA of "about 4 hours" is honest; "4h 02m 17s" implies a precision that a
 * rate-limited scrape simply does not have.
 */
export function formatEta(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms) || ms <= 0) return '—';

  const minutes = ms / 60_000;
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `about ${Math.round(minutes)} min`;

  const hours = minutes / 60;
  if (hours < 10) return `about ${hours.toFixed(1)} hours`;
  return `about ${Math.round(hours)} hours`;
}

/** Indian rupee, no decimals — Flipkart prices are whole rupees. */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/** Signed difference, so an increase and a decrease are distinguishable at a glance. */
export function formatDifference(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}₹${Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`.replace('₹-', '-₹');
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value}%`;
}

/** Signed percentage at fixed precision, so a small move still reads clearly: `+4.00%`, `-3.75%`. */
export function formatDifferencePercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

/** A settlement figure — a plain grouped number, up to two decimals. Not a price, so no ₹. */
export function formatSettlement(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** Signed plain number, no currency: `+4`, `-12`, `0`. For the settlement lists' Difference column. */
export function formatSignedNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-IN', { hour12: false });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', { hour12: false });
}

/** Elapsed time since an ISO timestamp, formatted as a duration. */
export function elapsedSince(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return '—';
  return formatDuration(Math.max(0, now - started));
}

/** Middle-truncate a URL so both the domain and the tail stay readable. */
export function shortenUrl(url: string, max = 48): string {
  if (url.length <= max) return url;
  const keep = Math.floor((max - 1) / 2);
  return `${url.slice(0, keep)}…${url.slice(-keep)}`;
}
