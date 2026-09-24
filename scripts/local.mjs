import { readFile, writeFile, chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export async function ask(label, fallback = '') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return ((await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback); }
  finally { rl.close(); }
}
async function hidden(label) {
  if (!process.stdin.isTTY) throw new Error('Run this in an interactive terminal to enter the token, or set the BOT_TOKEN environment variable.');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(`${label}: `); muted = true;
  try { return (await rl.question('')).trim(); }
  finally { rl.close(); process.stdout.write('\n'); }
}
export async function config() { return JSON.parse(await readFile('wrangler.jsonc', 'utf8')); }
export async function secrets(interactive = true) {
  try { process.loadEnvFile('.dev.vars'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let token = process.env.BOT_TOKEN || '';
  if (!token && interactive) token = await hidden('Bot token (input is hidden)');
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('BOT_TOKEN is missing or malformed.');
  const secret = process.env.WEBHOOK_SECRET || randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{24,256}$/.test(secret)) throw new Error('WEBHOOK_SECRET is malformed.');
  await writeFile('.dev.vars', `BOT_TOKEN=${token}\nWEBHOOK_SECRET=${secret}\n`, { mode: 0o600 });
  try { await chmod('.dev.vars', 0o600); } catch { /* Not supported on some Windows filesystems. */ }
  return { BOT_TOKEN: token, WEBHOOK_SECRET: secret };
}
export async function telegram(token, method, payload = {}) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });
  } catch { throw new Error(`Could not reach Telegram (${method}). Check your connection and try again.`); }
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(`Telegram ${method} failed: ${body.error_code || response.status} ${body.description || ''}`.trim());
  return body.result;
}
export function wrangler(args, stdinText) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), ...args], {
      stdio: [stdinText === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], shell: false,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
    });
    if (stdinText !== undefined) child.stdin.end(stdinText);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolvePromise() : reject(new Error(`Wrangler exited with code ${code}.`)));
  });
}
export function die(error) { console.error(`\nError: ${error.message}`); process.exitCode = 1; }
