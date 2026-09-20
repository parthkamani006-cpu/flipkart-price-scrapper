/**
 * The database's row shapes, hand-written.
 *
 * These are the wire format between Postgres and the mappers in
 * lib/store/mappers.ts — snake_case, nullable where the column is nullable, and
 * deliberately separate from the app's own types so a schema change surfaces as
 * a compile error in one file instead of silently reshaping a component prop.
 *
 * Regenerate rather than edit by hand once the project exists:
 *   npx supabase gen types typescript --project-id <ref> > lib/supabase/types.ts
 * Keep the exported names below if you do — the mappers import them.
 */

import type { JobOptions, JobState, LiveProgress, OrdersWindow, RowStatus, ScrapeStatus } from '@/types/dashboard';
import type { RecommendationStatus } from '@/lib/recommendation';

/** What the dashboard last asked for, independent of what is actually happening. */
export type RequestedAction = 'RUN' | 'PAUSE' | 'STOP';

export interface JobRowDb {
  id: string;
  name: string;
  account_name: string;
  state: JobState;
  requested_action: RequestedAction;
  options: JobOptions;
  orders_window: OrdersWindow | null;
  total: number;
  progress: LiveProgress[];
  stats: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  upload_time: string | null;
  started_at: string | null;
  finished_at: string | null;
  interrupted_at: string | null;
  error: string | null;
  error_at: string | null;
  recommendation_summary: string | null;
  recommendations_generated_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
}

export interface JobInputDb {
  job_id: string;
  idx: number;
  sku: string;
  fsn: string;
  target_seller: string;
  product_url: string;
  current_bank_settlement: number | null;
  bank_settlement_threshold: number | null;
  benchmark_price: number | null;
  stock_count: number | null;
  listing_price: number | null;
  lowest_listing_file: number | null;
}

export interface JobResultDb {
  job_id: string;
  idx: number;
  fsn: string;
  sku: string;
  product_url: string;
  seller_name: string | null;
  buybox_seller_name: string | null;
  main_listing_is_account_seller: boolean | null;
  main_price: number | null;
  seller_price: number | null;
  difference: number | null;
  is_price_different: boolean;
  status: ScrapeStatus;
  message: string | null;
  sellers_scanned: number | null;
  show_more_clicks: number | null;
  source: 'network' | 'dom' | 'api' | null;
  duration_ms: number | null;
  attempts: number | null;
  finished_at: string;
}

/** One row of job_rows_v — the input/result left join the UI actually renders. */
export interface JobRowViewDb {
  job_id: string;
  idx: number;
  sku: string;
  fsn: string;
  target_seller: string;
  product_url: string;
  current_bank_settlement: number | null;
  bank_settlement_threshold: number | null;
  benchmark_price: number | null;
  stock_count: number | null;
  listing_price: number | null;
  lowest_listing_file: number | null;
  status: Extract<RowStatus, 'pending' | 'success' | 'failed'>;
  result_status: ScrapeStatus | null;
  message: string | null;
  duration_ms: number | null;
  attempts: number | null;
  finished_at: string | null;
  is_price_different: boolean | null;
  /** The assembled JournalRow, or null while the product is still pending. */
  result: Record<string, unknown> | null;
}

/** One row of job_stats_v. successRate and the ETA are derived in lib/store/stats.ts. */
export interface JobStatsViewDb {
  job_id: string;
  total: number;
  succeeded: number;
  failed: number;
  completed: number;
  running: number;
  average_ms: number | null;
}

export interface RecommendationDb {
  job_id: string;
  idx: number;
  sku: string;
  fsn: string;
  diff_amount: number | null;
  status: RecommendationStatus;
  final_bank_settlement: number | null;
  reason: string | null;
  generated_at: string;
}

export interface FsnIntelligenceDb {
  account_slug: string;
  fsn: string;
  account_name: string;
  /** An FsnIntelligence value. Kept as unknown here so the engine owns its shape. */
  record: unknown;
  champion: string | null;
  accuracy_pct: number | null;
  average_error: number | null;
  observations_count: number;
  updated_at: string;
}
