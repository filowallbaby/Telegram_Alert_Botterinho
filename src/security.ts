import type { TgUser } from './types.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
/** Compares every character instead of returning at the first mismatch. */
export function equalSecret(a: string, b: string): boolean {
  if (a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(value)));
}
/** Validates Mini App initData as described in the Telegram docs. initDataUnsafe is never trusted. */
export async function verifyInitData(raw: string, token: string, now: number): Promise<TgUser> {
  if (!raw || raw.length > 8192) throw new HttpError(401, 'Open the map from the Telegram bot.');
  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw new HttpError(401, 'Invalid Telegram data.');
  const received = params.get('hash') || '';
  if (!/^[a-f0-9]{64}$/i.test(received)) throw new HttpError(401, 'Missing Telegram signature.');
  params.delete('hash');
  // Only hash is left out of the check string. signature, when present, stays in.
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = await hmac(new TextEncoder().encode('WebAppData'), token);
  const expected = [...await hmac(secret, check)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (!equalSecret(expected, received.toLowerCase())) throw new HttpError(401, 'Invalid Telegram signature.');
  const authDate = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > 3600) {
    throw new HttpError(401, 'Your session has expired. Close the map and open it again from the bot.');
  }
  let user: TgUser;
  try { user = JSON.parse(params.get('user') || 'null') as TgUser; }
  catch { throw new HttpError(401, 'Invalid Telegram user.'); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot || typeof user.first_name !== 'string') {
    throw new HttpError(401, 'Invalid Telegram user.');
  }
  return user;
}
export async function readJson(request: Request, maxBytes = 65536): Promise<unknown> {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > maxBytes) throw new HttpError(413, 'Request too large.');
  if (!request.body) throw new HttpError(400, 'Missing request body.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, 'Request too large.'); }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { joined.set(c, offset); offset += c.length; }
  try { return JSON.parse(new TextDecoder().decode(joined)); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin'
  } });
}
