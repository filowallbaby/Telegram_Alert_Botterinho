/** The subset of the D1 API used by the project, typed by hand to avoid pulling in workers-types. */
export interface DbResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes: number; last_row_id?: number; rows_read?: number; rows_written?: number };
}
export interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DbResult<T>>;
  run(): Promise<DbResult>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch<T = Record<string, unknown>>(statements: Statement[]): Promise<DbResult<T>[]>;
}
export interface Env {
  DB: Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  BOT_USERNAME: string;
  ALLOWED_CHAT_ID: string;
  APP_TITLE: string;
  MAP_CENTER_LAT: string;
  MAP_CENTER_LON: string;
  MAP_ZOOM: string;
  TIME_ZONE?: string;
  GROUP_THREAD_ID?: string;
  MAX_REPORTS_PER_HOUR?: string;
  COMMUNITY_RESOLVE_VOTES?: string;
}
export interface Context { waitUntil(promise: Promise<unknown>): void }
export interface TgUser { id: number; is_bot?: boolean; first_name: string; username?: string }
export interface TgMessage {
  message_id: number;
  date?: number;
  chat: { id: number; type: string; title?: string };
  from?: TgUser;
  sender_chat?: { id: number };
  text?: string;
  location?: { latitude: number; longitude: number; live_period?: number };
  venue?: { location: { latitude: number; longitude: number }; title?: string };
  reply_to_message?: { message_id: number; text?: string };
  message_thread_id?: number;
  is_topic_message?: boolean;
}
export interface TgCallback { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback }
export type Category = 'accident' | 'traffic' | 'closure' | 'roadworks' | 'hazard' | 'weather';
export type ReportStatus = 'active' | 'resolved' | 'expired' | 'removed';
export interface Draft {
  id: string; user_id: number; input_chat_id: number; input_message_id: number;
  prompt_message_id: number | null; latitude: number; longitude: number;
  category: Category | null; description: string; created_at: number;
  observed_at: number; expires_at: number; published_report_id: number | null;
}
export interface Report {
  id: number; draft_id: string; chat_id: number; user_id: number;
  latitude: number; longitude: number; category: Category; description: string;
  status: ReportStatus; created_at: number; observed_at: number; expires_at: number;
  updated_at: number; last_confirmed_at: number | null; resolved_at: number | null;
  message_id: number | null; revision: number; dirty: number;
  delivery_lock_until: number; retry_at: number; delivery_attempts: number;
  display_name?: string; confirmations?: number; clear_votes?: number;
}
export interface Membership { status: string; is_member?: boolean }
export type InlineButton = { text: string; callback_data?: string; url?: string };
