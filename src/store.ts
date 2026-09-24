import type { Category, Database, Draft, Report, TgUser } from './types.js';
import { CATEGORIES, cleanText, nameOf } from './domain.js';
import { HttpError } from './security.js';

export class Store {
  constructor(public db: Database, public chatId: number) {}

  async user(user: TgUser, now: number): Promise<void> {
    await this.db.prepare(`INSERT INTO users(id, display_name, created_at, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, updated_at=excluded.updated_at`)
      .bind(user.id, nameOf(user), now, now).run();
  }

  async allow(key: string, limit: number, windowSeconds: number, now: number): Promise<boolean> {
    const bucket = Math.floor(now / windowSeconds);
    const row = await this.db.prepare(`INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`)
      .bind(`${key}:${bucket}`, (bucket + 1) * windowSeconds).first<{ count: number }>();
    return (row?.count ?? limit + 1) <= limit;
  }

  async claimUpdate(id: number, now: number): Promise<'claimed' | 'done' | 'busy'> {
    const claimed = await this.db.prepare(`INSERT INTO processed_updates(id,state,lease_until,updated_at)
      VALUES(?,'processing',?,?) ON CONFLICT(id) DO UPDATE SET lease_until=excluded.lease_until,
      updated_at=excluded.updated_at WHERE processed_updates.state='processing'
      AND processed_updates.lease_until <= ? RETURNING id`)
      .bind(id, now + 60, now, now).first();
    if (claimed) return 'claimed';
    const row = await this.db.prepare('SELECT state FROM processed_updates WHERE id=?').bind(id).first<{ state: string }>();
    return row?.state === 'done' ? 'done' : 'busy';
  }
  async finishUpdate(id: number, now: number): Promise<void> {
    await this.db.prepare("UPDATE processed_updates SET state='done', lease_until=0, updated_at=? WHERE id=?")
      .bind(now, id).run();
  }
  async releaseUpdate(id: number): Promise<void> {
    await this.db.prepare("UPDATE processed_updates SET lease_until=0 WHERE id=? AND state='processing'").bind(id).run();
  }

  async draft(id: string): Promise<Draft | null> {
    return this.db.prepare('SELECT * FROM drafts WHERE id=?').bind(id).first<Draft>();
  }
  async pendingDraft(userId: number, inputChatId: number, replyId: number | null, now: number): Promise<Draft | null> {
    return this.db.prepare(`SELECT * FROM drafts WHERE user_id=? AND input_chat_id=?
      AND category IS NOT NULL AND expires_at>? AND published_report_id IS NULL
      ${replyId === null ? '' : 'AND prompt_message_id=?'} ORDER BY created_at DESC LIMIT 1`)
      .bind(...(replyId === null ? [userId, inputChatId, now] : [userId, inputChatId, now, replyId]))
      .first<Draft>();
  }
  async createDraft(id: string, user: TgUser, inputChatId: number, messageId: number,
    lat: number, lon: number, observedAt: number, now: number, note = ''): Promise<Draft> {
    await this.user(user, now);
    await this.db.prepare(`INSERT OR IGNORE INTO drafts(id,user_id,input_chat_id,input_message_id,
      latitude,longitude,description,created_at,observed_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, user.id, inputChatId, messageId, lat, lon, cleanText(note), now, observedAt, now + 1800).run();
    return (await this.draft(id))!;
  }
  async setPrompt(id: string, messageId: number): Promise<void> {
    await this.db.prepare('UPDATE drafts SET prompt_message_id=? WHERE id=?').bind(messageId, id).run();
  }
  async chooseCategory(id: string, type: Category): Promise<void> {
    await this.db.prepare('UPDATE drafts SET category=? WHERE id=? AND published_report_id IS NULL').bind(type, id).run();
  }
  async noteDraft(id: string, note: string): Promise<void> {
    await this.db.prepare('UPDATE drafts SET description=? WHERE id=? AND published_report_id IS NULL')
      .bind(cleanText(note), id).run();
  }
  async cancelDrafts(userId: number, inputChatId: number): Promise<void> {
    await this.db.prepare('DELETE FROM drafts WHERE user_id=? AND input_chat_id=? AND published_report_id IS NULL')
      .bind(userId, inputChatId).run();
  }
  async cancelDraft(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM drafts WHERE id=? AND published_report_id IS NULL').bind(id).run();
  }

  async publish(draft: Draft, now: number, hourlyLimit: number): Promise<Report> {
    const existing = await this.db.prepare('SELECT id FROM reports WHERE draft_id=?').bind(draft.id).first<{ id: number }>();
    if (existing) return (await this.report(existing.id, now))!;
    if (!draft.category || draft.expires_at <= now) throw new HttpError(400, 'This draft has expired. Send the location again.');
    const expiresAt = draft.observed_at + CATEGORIES[draft.category].ttl;
    if (expiresAt <= now) throw new HttpError(400, 'This information is too old. Please send a new report.');
    const count = await this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE user_id=? AND created_at>=?')
      .bind(draft.user_id, now - 3600).first<{ n: number }>();
    if ((count?.n ?? 0) >= hourlyLimit) throw new HttpError(429, "You've reached the hourly report limit. Try again later.");
    // D1 runs a batch as a single transaction.
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO reports(draft_id,chat_id,user_id,latitude,longitude,category,
        description,created_at,observed_at,expires_at,updated_at)
        SELECT id,?,user_id,latitude,longitude,category,description,?,observed_at,?,?
        FROM drafts WHERE id=? AND expires_at>? AND category IS NOT NULL`)
        .bind(this.chatId, now, expiresAt, now, draft.id, now),
      this.db.prepare('UPDATE drafts SET published_report_id=(SELECT id FROM reports WHERE draft_id=?) WHERE id=?')
        .bind(draft.id, draft.id),
      this.db.prepare(`INSERT OR IGNORE INTO report_history(event_key,report_id,actor_id,action,created_at)
        SELECT ?,id,user_id,'created',? FROM reports WHERE draft_id=?`)
        .bind(`create:${draft.id}`, now, draft.id)
    ]);
    const row = await this.db.prepare('SELECT id FROM reports WHERE draft_id=?').bind(draft.id).first<{ id: number }>();
    if (!row) throw new HttpError(409, 'This draft is no longer available.');
    return (await this.report(row.id, now))!;
  }

  private selectReport(): string {
    return `SELECT r.*, u.display_name,
      (SELECT COUNT(*) FROM votes v WHERE v.report_id=r.id AND v.kind='confirm') AS confirmations,
      (SELECT COUNT(*) FROM votes v WHERE v.report_id=r.id AND v.kind='clear'
        AND v.created_at>=? AND v.created_at>=COALESCE(r.last_confirmed_at,r.observed_at)) AS clear_votes
      FROM reports r JOIN users u ON u.id=r.user_id`;
  }
  async report(id: number, now: number): Promise<Report | null> {
    return this.db.prepare(`${this.selectReport()} WHERE r.id=? AND r.chat_id=?`)
      .bind(now - 900, id, this.chatId).first<Report>();
  }
  async list(mode: 'active' | '24h' | '7d', now: number, before = Number.MAX_SAFE_INTEGER): Promise<Report[]> {
    const where = mode === 'active' ? "r.status='active' AND r.expires_at>?" : "r.status!='removed' AND r.created_at>=?";
    const cutoff = mode === 'active' ? now : now - (mode === '24h' ? 86400 : 7 * 86400);
    const result = await this.db.prepare(`${this.selectReport()} WHERE r.chat_id=? AND ${where}
      AND r.id<? ORDER BY r.id DESC LIMIT 201`).bind(now - 900, this.chatId, cutoff, before).all<Report>();
    return result.results;
  }

  async vote(report: Report, actor: TgUser, kind: 'confirm' | 'clear', updateId: number,
    threshold: number, now: number): Promise<Report> {
    if (kind === 'confirm' && actor.id === report.user_id) throw new HttpError(400, "You can't confirm your own report.");
    await this.user(actor, now);
    await this.db.batch([
      this.db.prepare(`INSERT INTO votes(report_id,user_id,kind,created_at)
        SELECT id,?,?,? FROM reports WHERE id=? AND chat_id=? AND status='active' AND expires_at>?
        ON CONFLICT(report_id,user_id) DO UPDATE SET kind=excluded.kind,created_at=excluded.created_at
        WHERE votes.kind!=excluded.kind OR votes.created_at<=excluded.created_at-900`)
        .bind(actor.id, kind, now, report.id, this.chatId, now),
      this.db.prepare(`UPDATE reports SET updated_at=?, revision=revision+1, dirty=1,
        last_confirmed_at=NULLIF(MAX(COALESCE(last_confirmed_at,0),
          COALESCE((SELECT MAX(created_at) FROM votes WHERE report_id=? AND kind='confirm'),0)),0)
        WHERE id=? AND chat_id=? AND status='active' AND expires_at>?`)
        .bind(now, report.id, report.id, this.chatId, now),
      this.db.prepare(`UPDATE reports SET status='resolved',resolved_at=?,updated_at=?,revision=revision+1,dirty=1
        WHERE id=? AND chat_id=? AND status='active' AND expires_at>? AND
        (SELECT COUNT(*) FROM votes WHERE report_id=reports.id AND kind='clear'
          AND created_at>=? AND created_at>=COALESCE(reports.last_confirmed_at,reports.observed_at))>=?`)
        .bind(now, now, report.id, this.chatId, now, now - 900, threshold),
      this.db.prepare(`INSERT OR IGNORE INTO report_history(event_key,report_id,actor_id,action,created_at)
        SELECT ?,id,?,?,? FROM reports WHERE id=? AND chat_id=?`)
        .bind(`vote:${updateId}`, actor.id, kind, now, report.id, this.chatId),
      this.db.prepare(`INSERT OR IGNORE INTO report_history(event_key,report_id,actor_id,action,created_at)
        SELECT 'resolved:'||id,id,NULL,'community_resolved',? FROM reports WHERE id=? AND status='resolved'`)
        .bind(now, report.id)
    ]);
    return (await this.report(report.id, now))!;
  }

  async close(id: number, actor: TgUser, removed: boolean, now: number): Promise<void> {
    await this.user(actor, now);
    const state = removed ? 'removed' : 'resolved';
    await this.db.batch([
      this.db.prepare(`UPDATE reports SET status=?,resolved_at=?,updated_at=?,revision=revision+1,dirty=1,
        description=CASE WHEN ?=1 THEN '' ELSE description END WHERE id=? AND chat_id=?
        AND ${removed ? "status!='removed'" : "status='active' AND expires_at>?"}`)
        .bind(...(removed ? [state, now, now, 1, id, this.chatId] : [state, now, now, 0, id, this.chatId, now])),
      this.db.prepare(`INSERT OR IGNORE INTO report_history(event_key,report_id,actor_id,action,created_at)
        SELECT ?,id,?,?,? FROM reports WHERE id=? AND chat_id=? AND status=?`)
        .bind(`${state}:${id}`, actor.id, state, now, id, this.chatId, state)
    ]);
  }
  async editNote(id: number, note: string, actor: TgUser, updateId: number, now: number): Promise<void> {
    await this.user(actor, now);
    await this.db.batch([
      this.db.prepare(`UPDATE reports SET description=?,updated_at=?,revision=revision+1,dirty=1
        WHERE id=? AND chat_id=? AND status!='removed'`).bind(cleanText(note), now, id, this.chatId),
      this.db.prepare(`INSERT OR IGNORE INTO report_history(event_key,report_id,actor_id,action,created_at)
        VALUES(?,?,?,'note_edited',?)`).bind(`note:${updateId}`, id, actor.id, now)
    ]);
  }

  async maintenance(now: number): Promise<void> {
    const expired = await this.db.prepare(`SELECT id FROM reports WHERE chat_id=? AND status='active'
      AND expires_at<=? ORDER BY expires_at LIMIT 10`).bind(this.chatId, now).all<{ id: number }>();
    const statements = expired.results.flatMap(({ id }) => [
      this.db.prepare(`UPDATE reports SET status='expired',updated_at=?,revision=revision+1,dirty=1
        WHERE id=? AND status='active' AND expires_at<=?`).bind(now, id, now),
      this.db.prepare(`INSERT OR IGNORE INTO report_history(event_key,report_id,actor_id,action,created_at)
        SELECT ?,id,NULL,'expired',? FROM reports WHERE id=? AND status='expired'`).bind(`expired:${id}`, now, id)
    ]);
    statements.push(
      this.db.prepare('DELETE FROM drafts WHERE id IN (SELECT id FROM drafts WHERE expires_at<? LIMIT 200)').bind(now),
      this.db.prepare('DELETE FROM processed_updates WHERE id IN (SELECT id FROM processed_updates WHERE updated_at<? LIMIT 500)').bind(now - 3 * 86400),
      this.db.prepare('DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at<? LIMIT 500)').bind(now)
    );
    await this.db.batch(statements);
  }
}
