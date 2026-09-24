import type { Draft, Env, InlineButton, Report, TgCallback, TgMessage, TgUpdate, TgUser } from './types.js';
import { CATEGORIES, category, cleanText, coordinates, groupId, html, integer, isAdmin, isMember, mapLink, statusAt } from './domain.js';
import { HttpError } from './security.js';
import { Store } from './store.js';
import { answer, edit, flushReport, markup, member, sameTopic, send } from './telegram.js';

const PRIVACY = `<b>Data and privacy</b>
The bot only stores what you send it as a report: the location, the category, your note, your Telegram first name and user ID, the time and the votes. It doesn't store the group chat, photos, live locations or your routes.

The map and the history are only visible to group members. Unfinished drafts are deleted after 30 minutes. Reports stay in the archive until an admin deletes them, and removing a report from the map doesn't delete it from the database. Ask the admins if you want something corrected or deleted.

The data is hosted on Cloudflare and messages go through Telegram. Map tiles come from OpenStreetMap, so opening the map sends a request for the area you're looking at.

Please don't post plate numbers, names of the people involved or medical details. Only report when you've stopped somewhere safe. This bot is not an emergency service or an official traffic source.`;

function categoryButtons(id: string): InlineButton[][] {
  const buttons = Object.entries(CATEGORIES).map(([key, value]) => ({ text: value.label, callback_data: `cat:${key}:${id}` }));
  return [buttons.slice(0, 2), buttons.slice(2, 4), buttons.slice(4, 6), [{ text: 'Cancel', callback_data: `cancel:${id}` }]];
}
async function requireMember(env: Env, userId: number): Promise<void> {
  if (!isMember(await member(env, userId))) throw new HttpError(403, 'This is only available to members of the group.');
}
function validActor(user: TgUser | undefined): user is TgUser {
  return !!user && !user.is_bot && Number.isSafeInteger(user.id) && user.id > 0 && typeof user.first_name === 'string';
}
/** Filters out other chats, bots and normal conversation before anything touches the database. */
export function relevantUpdate(update: TgUpdate, env: Env): boolean {
  const msg = update.message || update.callback_query?.message;
  const user = update.message?.from || update.callback_query?.from;
  if (!msg || !validActor(user)) return false;
  const allowed = msg.chat.id === groupId(env) || (msg.chat.type === 'private' && msg.chat.id === user.id);
  if (!allowed) return false;
  if (update.callback_query) return true;
  return !!(msg.location || msg.venue || (msg.text && (msg.text.startsWith('/') || msg.reply_to_message || msg.chat.type === 'private')));
}
async function checkDraft(store: Store, id: string, actor: TgUser, inputChat: number, now: number): Promise<Draft> {
  const draft = await store.draft(id);
  if (!draft || draft.user_id !== actor.id || draft.input_chat_id !== inputChat) {
    throw new HttpError(403, "This draft isn't yours or is no longer available.");
  }
  if (draft.expires_at <= now && !draft.published_report_id) throw new HttpError(400, 'This draft has expired. Send the location again.');
  return draft;
}
async function publishDraft(env: Env, store: Store, draft: Draft, now: number): Promise<Report> {
  const report = await store.publish(draft, now, integer(env.MAX_REPORTS_PER_HOUR, 10, 1, 100));
  const delivered = await flushReport(env, store, report.id, now);
  const current = (await store.report(report.id, now))!;
  if (draft.prompt_message_id) {
    const pending = !delivered && !current.message_id ? "\nCouldn't post it in the group yet. It will be retried automatically." : '';
    await edit(env, draft.input_chat_id, draft.prompt_message_id,
      `Report <b>#${report.id}</b> saved.${pending}\nTo change the note: <code>/note ${report.id} new text</code>`,
      [[{ text: 'Open on map', url: mapLink(env, report.id) }]]);
  }
  return current;
}
async function location(env: Env, store: Store, msg: TgMessage, updateId: number, now: number): Promise<void> {
  if (!msg.from) return;
  const loc = msg.location || msg.venue?.location;
  if (!loc || !coordinates(loc.latitude, loc.longitude)) throw new HttpError(400, "Those coordinates can't be shown on the map.");
  if (msg.location?.live_period) throw new HttpError(400, 'Please send a fixed point where the problem is, not your live location.');
  const observed = msg.date ?? now;
  if (observed > now + 30 || now - observed > 900) throw new HttpError(400, 'This location reached the bot too late. If the problem is still there, send it again.');
  const thread = integer(env.GROUP_THREAD_ID, 0, 0, Number.MAX_SAFE_INTEGER);
  if (msg.chat.id === store.chatId && thread && msg.message_thread_id !== thread) {
    throw new HttpError(400, 'Please send reports in the topic set up for the bot.');
  }
  const id = `d${updateId.toString(36)}`;
  let draft = await store.draft(id);
  if (!draft) {
    if (!await store.allow(`draft:${msg.from.id}`, 6, 600, now)) throw new HttpError(429, 'Too many drafts. Wait a few minutes before sending another one.');
    await store.cancelDrafts(msg.from.id, msg.chat.id);
    draft = await store.createDraft(id, msg.from, msg.chat.id, msg.message_id, loc.latitude, loc.longitude,
      observed, now, msg.venue?.title || '');
  }
  if (!draft.prompt_message_id) {
    const prompt = await send(env, msg.chat.id,
      "<b>What are you reporting?</b>\nPick a category. Only the person who sent the location can finish this report.\n\nThe pin should be where the problem is. Don't use your phone while driving.",
      { reply_markup: markup(categoryButtons(id)), reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
        ...sameTopic(msg) });
    await store.setPrompt(id, prompt.message_id);
  }
}
function parseCommand(text: string, botName: string): { command: string; args: string } | null {
  const match = /^\/([a-z_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match || (match[2] && match[2].toLowerCase() !== botName.replace(/^@/, '').toLowerCase())) return null;
  return { command: match[1]!, args: (match[3] || '').trim() };
}
async function ownedReport(env: Env, store: Store, id: number, actor: TgUser, adminOnly: boolean, now: number): Promise<Report> {
  const report = await store.report(id, now);
  if (!report) throw new HttpError(404, 'Report not found in this group.');
  if ((!adminOnly && report.user_id === actor.id) || isAdmin(await member(env, actor.id))) return report;
  throw new HttpError(403, adminOnly ? 'Only admins can do that.' : 'Only the author or an admin can do that.');
}
async function handleMessage(env: Env, store: Store, msg: TgMessage, updateId: number, now: number): Promise<void> {
  const actor = msg.from!;
  if (msg.sender_chat) {
    if (msg.location || msg.text?.startsWith('/')) await send(env, msg.chat.id, 'Please post from your personal account to use the bot, not as a channel or anonymous admin.');
    return;
  }
  if (msg.chat.type === 'private') await requireMember(env, actor.id);
  if (msg.location || msg.venue) { await location(env, store, msg, updateId, now); return; }
  const text = msg.text || '';
  const command = parseCommand(text, env.BOT_USERNAME);
  if (command) {
    switch (command.command) {
      case 'start': case 'help':
        await send(env, msg.chat.id,
          `<b>${html(env.APP_TITLE || 'Road alerts')}</b>\nSend a location from Telegram's attachment menu to report a problem on the road. Pick a category, add a note if you like, and the bot posts it in the group and on the map. Group members can also do this in a private chat with the bot.\n\n/report - how to send a report\n/map - map and history\n/active - latest active reports\n/cancel - cancel your draft\n/note ID text - change the note of a report\n/resolve ID - close one of your reports\n/privacy - what data is stored\n\nConfirmations and closures come from group members, not from an official source.`,
          { reply_markup: markup([[{ text: 'Open map', url: mapLink(env) }]]) });
        return;
      case 'report':
        await send(env, msg.chat.id, "<b>Send the location of the problem</b>\nOpen Telegram's attachment menu, choose Location and drop a pin where the problem is. Send a fixed point, not your live location.\n\nAfter that you'll pick a category and add a note. Only do this when you've stopped somewhere safe.");
        return;
      case 'map':
        await send(env, msg.chat.id, '<b>Group map</b>\nActive reports, filters and the last 7 days of history. Only group members can open it.',
          { reply_markup: markup([[{ text: 'Open map', url: mapLink(env) }]]) });
        return;
      case 'privacy': await send(env, msg.chat.id, PRIVACY); return;
      case 'cancel':
        await store.cancelDrafts(actor.id, msg.chat.id);
        await send(env, msg.chat.id, 'Your unpublished drafts in this chat have been cancelled.');
        return;
      case 'publish': {
        const draft = await store.pendingDraft(actor.id, msg.chat.id, null, now);
        if (!draft) throw new HttpError(400, 'Send a location and pick a category first.');
        await publishDraft(env, store, draft, now);
        return;
      }
      case 'active': {
        const reports = await store.list('active', now);
        const lines = reports.slice(0, 10).map(r => `#${r.id} · ${html(CATEGORIES[r.category].label)}${r.description ? ` - ${html(r.description.slice(0, 100))}` : ''}`);
        await send(env, msg.chat.id, lines.length ? `<b>Latest active reports</b>\n${lines.join('\n')}\n\nOpen the map for details and the full list.` : 'No active reports at the moment.',
          { reply_markup: markup([[{ text: 'Open map', url: mapLink(env) }]]) });
        return;
      }
      case 'note': case 'resolve': case 'remove': {
        const match = /^(\d+)(?:\s+([\s\S]*))?$/.exec(command.args);
        const id = Number(match?.[1]);
        if (!match || !Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, `Usage: /${command.command} ID${command.command === 'note' ? ' text' : ''}`);
        const report = await ownedReport(env, store, id, actor, command.command === 'remove', now);
        if (command.command === 'note') {
          const note = cleanText(match[2] || '', 501);
          if (!note || note.length > 500) throw new HttpError(400, 'The note must be between 1 and 500 characters.');
          if (report.status === 'removed') throw new HttpError(400, 'This report has been removed.');
          await store.editNote(id, note, actor, updateId, now);
        } else {
          if (command.command === 'resolve' && statusAt(report, now) !== 'active') throw new HttpError(400, 'This report is no longer active.');
          await store.close(id, actor, command.command === 'remove', now);
        }
        await flushReport(env, store, id, now);
        await send(env, msg.chat.id, `Report #${id} updated. The card in the group will be refreshed as soon as Telegram allows it.`);
        return;
      }
      case 'status': {
        if (!isAdmin(await member(env, actor.id))) throw new HttpError(403, 'Only admins can use this command.');
        const row = await env.DB.prepare(`SELECT COUNT(*) AS total,
          SUM(CASE WHEN status='active' AND expires_at>? THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN dirty=1 THEN 1 ELSE 0 END) AS pending FROM reports WHERE chat_id=?`)
          .bind(now, store.chatId).first<{ total: number; active: number; pending: number }>();
        await send(env, msg.chat.id, `<b>Bot status</b>\nReports stored: ${row?.total || 0}\nActive: ${row?.active || 0}\nCards waiting to sync: ${row?.pending || 0}\nCheck the Cloudflare dashboard for quota usage.`);
        return;
      }
      default: return; // Might be meant for another bot in the group.
    }
  }
  if (text.startsWith('/')) return;
  const replyId = msg.chat.type === 'private' ? null : msg.reply_to_message?.message_id;
  if (replyId === undefined) return;
  const draft = await store.pendingDraft(actor.id, msg.chat.id, replyId, now);
  if (!draft) return;
  const note = cleanText(text, 501);
  if (!note || note.length > 500) throw new HttpError(400, "Notes can be up to 500 characters. Please leave out other people's personal details.");
  await store.noteDraft(draft.id, note);
  await publishDraft(env, store, (await store.draft(draft.id))!, now);
}
async function handleCallback(env: Env, store: Store, callback: TgCallback, updateId: number, now: number): Promise<void> {
  const msg = callback.message!;
  const actor = callback.from;
  if (msg.chat.type === 'private') await requireMember(env, actor.id);
  const parts = (callback.data || '').split(':');
  if (['cat', 'pub', 'cancel'].includes(parts[0] || '')) {
    const id = parts[0] === 'cat' ? parts[2] : parts[1];
    if (!id || !/^d[0-9a-z]+$/.test(id)) throw new HttpError(400, 'Invalid button.');
    const draft = await checkDraft(store, id, actor, msg.chat.id, now);
    if (draft.published_report_id) { await answer(env, callback.id, `Already posted as #${draft.published_report_id}.`); return; }
    if (parts[0] === 'cancel') {
      await store.cancelDraft(id);
      await edit(env, msg.chat.id, msg.message_id, 'Draft cancelled.');
      await answer(env, callback.id, 'Cancelled.'); return;
    }
    if (parts[0] === 'cat') {
      const type = category(parts[1]);
      if (!type) throw new HttpError(400, 'Unknown category.');
      await store.chooseCategory(id, type);
      await edit(env, msg.chat.id, msg.message_id,
        `<b>${html(CATEGORIES[type].label)}</b>\n${msg.chat.type === 'private' ? 'Send' : 'Reply to this message with'} a short note: road, direction and what's going on. The report is posted as soon as you send it.\n\nOr tap "Publish without note". Please leave out names, plate numbers and medical details.`,
        [[{ text: 'Publish without note', callback_data: `pub:${id}` }], [{ text: 'Cancel', callback_data: `cancel:${id}` }]]);
      await answer(env, callback.id, 'Category selected.'); return;
    }
    const report = await publishDraft(env, store, draft, now);
    await answer(env, callback.id, `Posted as #${report.id}.`); return;
  }
  if (parts[0] === 'vote' && ['confirm', 'clear'].includes(parts[1] || '')) {
    const id = Number(parts[2]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Invalid report.');
    const report = await store.report(id, now);
    if (!report || msg.chat.id !== store.chatId || report.message_id !== msg.message_id) throw new HttpError(403, 'Use the buttons on the original report in the group.');
    if (statusAt(report, now) !== 'active') throw new HttpError(400, 'This report is no longer active.');
    if (!await store.allow(`vote:${actor.id}`, 30, 60, now)) throw new HttpError(429, 'Too many taps. Wait a minute and try again.');
    let updated: Report;
    if (parts[1] === 'clear' && (actor.id === report.user_id || isAdmin(await member(env, actor.id)))) {
      await store.close(report.id, actor, false, now);
      updated = (await store.report(id, now))!;
    } else {
      updated = await store.vote(report, actor, parts[1] as 'confirm' | 'clear', updateId,
        integer(env.COMMUNITY_RESOLVE_VOTES, 2, 2, 10), now);
    }
    await answer(env, callback.id, updated.status === 'resolved' ? 'Marked as resolved.' : 'Thanks, got it. Each person counts once.');
    await flushReport(env, store, id, now);
    return;
  }
  await answer(env, callback.id, 'This button no longer works.');
}
export async function processUpdate(env: Env, store: Store, update: TgUpdate, now: number): Promise<void> {
  try {
    if (update.message) await handleMessage(env, store, update.message, update.update_id, now);
    else if (update.callback_query) await handleCallback(env, store, update.callback_query, update.update_id, now);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (update.callback_query) await answer(env, update.callback_query.id, error.message, true);
    else if (update.message) await send(env, update.message.chat.id, html(error.message));
  }
}
