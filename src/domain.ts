import type { Category, Env, Membership, Report, TgUser } from './types.js';

// ttl is how long a report stays active, counted from when the location was sent.
export const CATEGORIES: Record<Category, { label: string; ttl: number; color: string }> = {
  accident: { label: 'Accident', ttl: 2 * 3600, color: '#db4853' },
  traffic: { label: 'Traffic jam', ttl: 60 * 60, color: '#dc8e22' },
  closure: { label: 'Road closed', ttl: 12 * 3600, color: '#b751ac' },
  roadworks: { label: 'Roadworks', ttl: 24 * 3600, color: '#367cdc' },
  hazard: { label: 'Hazard', ttl: 2 * 3600, color: '#cf7337' },
  weather: { label: 'Weather / flooding', ttl: 3 * 3600, color: '#3a9da1' }
};
export const DEFAULT_TIME_ZONE = 'Europe/Rome';
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
export function category(value: unknown): Category | null {
  return typeof value === 'string' && Object.hasOwn(CATEGORIES, value) ? value as Category : null;
}
export function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}
export function groupId(env: Env): number {
  const id = Number(env.ALLOWED_CHAT_ID);
  if (!Number.isSafeInteger(id) || id >= 0) throw new Error('CONFIG_GROUP');
  return id;
}
export function timeZone(env: Env): string {
  const zone = env.TIME_ZONE || DEFAULT_TIME_ZONE;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); return zone; }
  catch { return DEFAULT_TIME_ZONE; }
}
export function coordinates(lat: unknown, lon: unknown): boolean {
  return typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat)
    && Number.isFinite(lon) && lat >= -85.05112878 && lat <= 85.05112878 && lon >= -180 && lon <= 180;
}
/** Strips control and bidi override characters and trims the length. HTML escaping happens on output. */
export function cleanText(value: string, max = 500): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max);
}
export function nameOf(user: TgUser): string { return cleanText(user.first_name || 'Member', 70); }
export function html(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
export function isMember(member: Membership): boolean {
  return ['creator', 'administrator', 'member'].includes(member.status)
    || (member.status === 'restricted' && member.is_member === true);
}
export function isAdmin(member: Membership): boolean { return ['creator', 'administrator'].includes(member.status); }
export function statusAt(report: Pick<Report, 'status' | 'expires_at'>, now: number): Report['status'] {
  return report.status === 'active' && report.expires_at <= now ? 'expired' : report.status;
}
export function mapLink(env: Env, reportId?: number): string {
  const username = env.BOT_USERNAME.replace(/^@/, '');
  if (!/^[a-zA-Z0-9_]{5,32}$/.test(username)) throw new Error('CONFIG_USERNAME');
  return `https://t.me/${username}?startapp=${reportId ? `event_${reportId}` : 'map'}`;
}
export function chatMessageLink(chatId: number, messageId: number | null): string | null {
  const text = String(chatId);
  return messageId && text.startsWith('-100') ? `https://t.me/c/${text.slice(4)}/${messageId}` : null;
}
export function dateTime(timestamp: number, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(timestamp * 1000);
}
