import { ask, config, secrets, telegram, die } from './local.mjs';

try {
  const mode = process.argv[2];
  if (!['discover', 'setup', 'status'].includes(mode)) throw new Error('Usage: node scripts/telegram.mjs discover|setup|status');
  const credentials = await secrets();
  const me = await telegram(credentials.BOT_TOKEN, 'getMe');
  if (mode === 'discover') {
    const webhook = await telegram(credentials.BOT_TOKEN, 'getWebhookInfo');
    if (webhook.url) throw new Error('This bot already has a webhook. Not touching it: get the group ID from the existing setup or use a new bot.');
    console.log(`Add @${me.username} to the group as an admin, then send /id@${me.username} in the group.`);
    await ask('Press Enter once you have sent it');
    const updates = await telegram(credentials.BOT_TOKEN, 'getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message'] });
    const groups = new Map();
    for (const update of updates) {
      const chat = update.message?.chat;
      if (chat && ['group', 'supergroup'].includes(chat.type)) groups.set(chat.id, chat.title || '(no title)');
    }
    if (!groups.size) throw new Error('No groups found. Send the command in the group and run this again.');
    console.log('\nGroups found:');
    for (const [id, title] of groups) console.log(`  ${id}  ${title}`);
    console.log('\nUse the right ID in npm run configure.');
  } else if (mode === 'status') {
    const info = await telegram(credentials.BOT_TOKEN, 'getWebhookInfo');
    console.log(JSON.stringify({ bot: me.username, webhook: info.url || '(not set)',
      pending_updates: info.pending_update_count, last_error_date: info.last_error_date || null,
      last_error_message: info.last_error_message || null }, null, 2));
  } else {
    const file = await config();
    if (file.vars.BOT_USERNAME !== me.username) throw new Error("The token doesn't match BOT_USERNAME in wrangler.jsonc. Run npm run configure first.");
    const entered = await ask('Worker URL printed by npm run deploy');
    const url = new URL(entered);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.username || url.password || url.search || url.hash || !['/', ''].includes(url.pathname)) {
      throw new Error('Use the https://....workers.dev address on its own, without a path, query or fragment.');
    }
    let health;
    try { health = await fetch(`${url.origin}/health`, { signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error("Can't reach the Worker. Check the URL and that the deploy worked."); }
    if (!health.ok || !(await health.json()).ok) throw new Error('Health check failed. Check that the migration ran and both secrets are uploaded.');
    const member = await telegram(credentials.BOT_TOKEN, 'getChatMember', { chat_id: Number(file.vars.ALLOWED_CHAT_ID), user_id: me.id });
    if (member.status !== 'administrator') throw new Error('The bot is not an admin of the configured group.');
    if ((await ask(`Point the webhook and commands of @${me.username} to ${url.origin}? Type yes`)).toLowerCase() !== 'yes') throw new Error('Cancelled.');
    const commands = [
      ['report', 'How to report a problem'], ['map', 'Open the map'],
      ['active', 'Latest active reports'], ['cancel', 'Cancel your draft'],
      ['note', 'Change a note: /note ID text'], ['resolve', 'Close your report: /resolve ID'],
      ['privacy', 'What data is stored'], ['help', 'How the bot works']
    ].map(([command, description]) => ({ command, description }));
    await telegram(credentials.BOT_TOKEN, 'setMyCommands', { commands });
    await telegram(credentials.BOT_TOKEN, 'setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Map', web_app: { url: `${url.origin}/` } }
    });
    await telegram(credentials.BOT_TOKEN, 'setWebhook', {
      url: `${url.origin}/telegram/webhook`, secret_token: credentials.WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'], max_connections: 1, drop_pending_updates: false
    });
    console.log('\nWebhook, commands and the Map button for private chats are set.');
    console.log(`One more step by hand: in @BotFather go to /mybots > @${me.username} > Bot Settings > Configure Mini App and enable the main Mini App with ${url.origin}/`);
    console.log('Without it the "Open on map" buttons in the group will not work.');
    console.log('Then go through docs/launch-checklist.md with a test group before announcing the bot.');
  }
} catch (error) { die(error); }
