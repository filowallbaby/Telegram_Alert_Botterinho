import { writeFile } from 'node:fs/promises';
import { ask, config, secrets, telegram, die } from './local.mjs';

function validTimeZone(zone) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); return true; } catch { return false; }
}

try {
  const credentials = await secrets();
  const me = await telegram(credentials.BOT_TOKEN, 'getMe');
  if (!me.is_bot || !me.username) throw new Error("This token doesn't belong to a bot with a username.");
  console.log(`Bot found: @${me.username}. The token is kept in .dev.vars only.`);
  const file = await config();
  const name = await ask('Cloudflare Worker name', file.name);
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) throw new Error('Worker names are 3-63 characters: lowercase letters, digits and dashes.');
  const currentId = file.d1_databases[0].database_id;
  const databaseId = await ask('database_id printed by wrangler d1 create', /^0{8}-/.test(currentId) ? '' : currentId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)) throw new Error('database_id must be a UUID.');
  const input = await ask('Group ID (negative number, run npm run telegram:discover to find it)');
  const group = Number(input);
  if (!Number.isSafeInteger(group) || group >= 0) throw new Error('Invalid group ID.');
  const chat = await telegram(credentials.BOT_TOKEN, 'getChat', { chat_id: group });
  if (!['group', 'supergroup'].includes(chat.type)) throw new Error('The bot works with groups and supergroups, not channels.');
  const botMember = await telegram(credentials.BOT_TOKEN, 'getChatMember', { chat_id: group, user_id: me.id });
  if (botMember.status !== 'administrator') throw new Error('Make the bot an admin of the group first. It does not need the permission to ban users.');
  console.log(`Group found: ${chat.title}.`);
  const title = await ask('Map title', chat.title || 'Road alerts');
  const centerLat = Number(await ask('Initial map center, latitude (the map zooms to the reports once there are some)', String(file.vars.MAP_CENTER_LAT)));
  const centerLon = Number(await ask('Initial map center, longitude', String(file.vars.MAP_CENTER_LON)));
  if (!Number.isFinite(centerLat) || Math.abs(centerLat) > 85.05112878 || !Number.isFinite(centerLon) || Math.abs(centerLon) > 180) throw new Error('Invalid map center.');
  const zoom = Number(await ask('Initial zoom (6 for a whole country, 12 for a city)', String(file.vars.MAP_ZOOM)));
  if (!Number.isInteger(zoom) || zoom < 3 || zoom > 18) throw new Error('Zoom must be a whole number between 3 and 18.');
  const zone = await ask('Time zone (IANA name, e.g. Europe/London)', file.vars.TIME_ZONE || 'Europe/Rome');
  if (!validTimeZone(zone)) throw new Error(`Unknown time zone: ${zone}`);
  const threadId = Number(await ask('Topic ID for the bot (0 if the group has no topics or for General)', '0'));
  if (!Number.isSafeInteger(threadId) || threadId < 0) throw new Error('Invalid topic ID.');
  file.name = name;
  file.d1_databases[0].database_id = databaseId;
  file.vars = { ...file.vars, BOT_USERNAME: me.username, ALLOWED_CHAT_ID: String(group), APP_TITLE: title.slice(0, 80),
    MAP_CENTER_LAT: String(centerLat), MAP_CENTER_LON: String(centerLon), MAP_ZOOM: String(zoom),
    TIME_ZONE: zone, GROUP_THREAD_ID: String(threadId) };
  await writeFile('wrangler.jsonc', JSON.stringify(file, null, 2) + '\n');
  console.log('\nSaved to wrangler.jsonc. Next: npm run db:remote, npm run deploy, npm run secrets:upload.');
  console.log(`The D1 database must be named ${file.d1_databases[0].database_name}.`);
} catch (error) { die(error); }
