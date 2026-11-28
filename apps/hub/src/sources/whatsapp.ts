import fsp from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';
import { q, q1 } from '../db.js';
import {
  editMessage, emitLive, ingestMessage, markReceipts, setConversationRead, setReaction, unsendMessage,
  upsertConversation, upsertHandle, type NameSource,
} from '../store.js';

type Log = { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };

interface WAMedia { kind: string; mime: string; filename?: string; size?: number; width?: number; height?: number }

type WAEvent =
  | { type: 'message'; id: string; chat: string; chatAddress?: string; isGroup: boolean; sender: string; senderName?: string;
      fromMe: boolean; timestamp: number; text: string; replyTo?: string; media?: WAMedia; historical: boolean }
  | { type: 'reaction'; chat: string; target: string; sender: string; fromMe: boolean; emoji: string; timestamp: number }
  | { type: 'edit'; chat: string; target: string; text: string; timestamp: number }
  | { type: 'revoke'; chat: string; target: string }
  | { type: 'receipt'; chat: string; ids: string[]; kind: 'delivered' | 'read' | 'read-self'; timestamp: number }
  | { type: 'contact'; address: string; name: string; source: NameSource }
  | { type: 'chat'; chat: string; name: string; isGroup: boolean }
  | { type: 'typing'; chat: string; sender: string; typing: boolean; audio: boolean }
  | { type: 'status' };

export interface WAStatus {
  configured: boolean; reachable: boolean; loggedIn: boolean; connected: boolean; pairing: boolean;
  qr: string | null; jid: string | null; pushName: string | null; error: string | null;
}

export class WhatsApp {
  private processing = false;
  private pending = false;
  private listener?: pg.Client;

  constructor(private log: Log) {}

  get configured() {
    return !!(config.whatsapp.url && config.whatsapp.secret);
  }

  private async call<T = any>(p: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${config.whatsapp.url}${p}`, {
      ...init,
      headers: { 'x-internal-secret': config.whatsapp.secret, ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...init.headers },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const j: any = await res.json().catch(() => ({}));
      // 409: WhatsApp isn't linked; that message is written for the user.
      if (res.status === 409 && j.error) throw Object.assign(new Error(j.error), { statusCode: 409 });
      throw new Error(`WhatsApp connector ${p}: ${res.status} ${j.error ?? ''}`.trim());
    }
    return res.json() as Promise<T>;
  }

  async start() {
    if (!this.configured) {
      this.log.warn({}, 'WhatsApp connector not configured (WA_CONNECTOR_URL / INTERNAL_SECRET); WhatsApp disabled');
      return;
    }
    await this.listen();
    this.kick();
    setInterval(() => this.kick(), 30_000).unref();
    this.syncMutes().catch((e) => this.log.warn({ err: String(e) }, 'WhatsApp mute sync failed'));
    setInterval(() => this.syncMutes().catch((e) => this.log.warn({ err: String(e) }, 'WhatsApp mute sync failed')), 60_000).unref();
  }

  /**
   * Copies each chat's mute setting from the WhatsApp account (kept by the connector in whatsmeow_chat_settings,
   * updated whenever it changes on any device) onto the matching conversation.
   */
  async syncMutes() {
    const exists = await q1(`select 1 from information_schema.tables where table_name = 'whatsmeow_chat_settings'`);
    if (!exists) return;
    const changed = await q<{ id: number }>(
      `with settings as (
         select case
                  when s.chat_jid like '%@lid' then coalesce(l.pn || '@s.whatsapp.net', s.chat_jid)
                  else s.chat_jid
                end as chat,
                case
                  when s.muted_until = -1 then 'infinity'::timestamptz
                  when s.muted_until > 0 then to_timestamp(s.muted_until)
                end as until
         from whatsmeow_chat_settings s
         left join whatsmeow_lid_map l on s.chat_jid like '%@lid' and l.lid = split_part(s.chat_jid, '@', 1)
       ),
       target as (
         select c.id, (select max(st.until) from settings st where st.chat = c.source_id and st.until > now()) as until
         from conversation c where c.network = 'whatsapp'
       )
       update conversation c set muted_until = t.until
       from target t
       where c.id = t.id and c.muted_until is distinct from t.until
       returning c.id`,
    );
    for (const c of changed) emitLive({ type: 'conversation-updated', conversationId: c.id });
    if (changed.length) this.log.info({ count: changed.length }, 'WhatsApp mute settings updated');
  }

  /** Mutes or unmutes a chat on the WhatsApp account itself. until: null means always. */
  async setMute(chat: string, muted: boolean, until: Date | null) {
    await this.call('/mute', { method: 'POST', body: JSON.stringify({ chat, muted, until: until ? until.getTime() : 0 }) });
  }

  private async listen() {
    try {
      this.listener = new pg.Client({ connectionString: config.databaseUrl });
      await this.listener.connect();
      await this.listener.query('listen wa_event');
      this.listener.on('notification', () => this.kick());
      this.listener.on('error', (e) => {
        this.log.warn({ err: String(e) }, 'wa_event listener lost; reconnecting');
        setTimeout(() => this.listen(), 5000);
      });
    } catch (e) {
      this.log.warn({ err: String(e) }, 'could not LISTEN for wa_event; polling only');
      setTimeout(() => this.listen(), 15000);
    }
  }

  /** Drain the wa_event outbox. Coalesces concurrent wakeups into one loop. */
  private kick() {
    if (this.processing) {
      this.pending = true;
      return;
    }
    this.processing = true;
    this.drain()
      .catch((e) => this.log.error({ err: String(e) }, 'processing WhatsApp events failed'))
      .finally(() => {
        this.processing = false;
        if (this.pending) {
          this.pending = false;
          this.kick();
        }
      });
  }

  private async drain() {
    for (;;) {
      const rows = await q<{ id: number; payload: WAEvent }>('select id, payload from wa_event order by id limit 500');
      if (!rows.length) return;
      for (const row of rows) {
        try {
          await this.apply(row.payload);
        } catch (e) {
          this.log.error({ err: String(e), event: row.payload.type }, 'failed to apply WhatsApp event');
        }
      }
      await q('delete from wa_event where id = any($1)', [rows.map((r) => r.id)]);
    }
  }

  private async apply(ev: WAEvent) {
    switch (ev.type) {
      case 'message': {
        const sender = ev.fromMe ? null : { address: ev.sender, displayName: ev.senderName || null, nameSource: 'push' as const };
        const members = !ev.isGroup && ev.chatAddress ? [{ address: ev.chatAddress }] : [];
        await ingestMessage({
          network: 'whatsapp',
          service: 'whatsapp',
          conversation: { sourceId: ev.chat, isGroup: ev.isGroup, members },
          sourceId: ev.id,
          sender,
          fromMe: ev.fromMe,
          body: ev.text || null,
          sentAt: new Date(ev.timestamp),
          replyToSourceId: ev.replyTo || null,
          attachments: ev.media
            ? [{ sourceId: ev.id, mime: ev.media.mime, filename: ev.media.filename ?? `${ev.media.kind}${extFor(ev.media.mime)}`,
                 size: ev.media.size ?? null, width: ev.media.width ?? null, height: ev.media.height ?? null }]
            : [],
          historical: ev.historical,
        });
        break;
      }
      case 'reaction':
        await setReaction('whatsapp', ev.target, ev.fromMe ? null : { address: ev.sender }, ev.emoji || null);
        break;
      case 'edit':
        await editMessage('whatsapp', ev.target, ev.text || null, new Date(ev.timestamp));
        break;
      case 'revoke':
        await unsendMessage('whatsapp', ev.target);
        break;
      case 'receipt':
        if (ev.kind === 'read-self') await setConversationRead('whatsapp', ev.chat);
        else await markReceipts('whatsapp', ev.ids, ev.kind, new Date(ev.timestamp));
        break;
      case 'contact':
        if (ev.address && ev.name) await upsertHandle('whatsapp', { address: ev.address, displayName: ev.name, nameSource: ev.source });
        break;
      case 'chat':
        await upsertConversation('whatsapp', { sourceId: ev.chat, title: ev.name, isGroup: ev.isGroup });
        break;
      case 'typing': {
        const c = await q1<{ id: number; is_group: boolean }>(`select id, is_group from conversation where network = 'whatsapp' and source_id = $1`, [ev.chat]);
        if (c) {
          emitLive({
            type: 'typing', conversationId: c.id, typing: ev.typing, audio: ev.audio,
            sender: c.is_group && ev.sender ? { network: 'whatsapp', address: ev.sender } : null,
          });
        }
        break;
      }
      case 'status':
        emitLive({ type: 'status', source: 'whatsapp' });
        break;
    }
  }

  // ---------- commands ----------

  async status(): Promise<WAStatus> {
    const base: WAStatus = { configured: this.configured, reachable: false, loggedIn: false, connected: false, pairing: false, qr: null, jid: null, pushName: null, error: null };
    if (!this.configured) return base;
    try {
      const s = await this.call<any>('/status');
      return { ...base, reachable: true, loggedIn: s.loggedIn, connected: s.connected, pairing: s.pairing, qr: s.qr || null, jid: s.jid ?? null, pushName: s.pushName ?? null };
    } catch (e) {
      return { ...base, error: e instanceof Error ? e.message : String(e) };
    }
  }

  pair() {
    return this.call('/pair', { method: 'POST' });
  }

  logout() {
    return this.call('/logout', { method: 'POST' });
  }

  async sendText(chat: string, text: string, replyTo?: { id: string; sender: string; text: string } | null) {
    const res = await this.call<{ id: string; timestamp: number }>('/send', { method: 'POST', body: JSON.stringify({ chat, text, replyTo: replyTo ?? undefined }) });
    await ingestMessage({
      network: 'whatsapp', service: 'whatsapp', conversation: conversationFor(chat),
      sourceId: res.id, sender: null, fromMe: true, body: text, sentAt: new Date(res.timestamp), replyToSourceId: replyTo?.id ?? null,
    });
    return res;
  }

  /** voice: an Ogg Opus voice note (seconds is its length). */
  async sendFile(chat: string, file: { buffer: Buffer; filename: string; mime: string }, caption?: string, voice?: { seconds: number }) {
    const form = new FormData();
    form.set('chat', chat);
    if (caption) form.set('caption', caption);
    if (voice) {
      form.set('ptt', 'true');
      form.set('seconds', String(Math.round(voice.seconds)));
    }
    form.set('file', new Blob([new Uint8Array(file.buffer)], { type: file.mime }), file.filename);
    const res = await this.call<{ id: string; timestamp: number; mime: string }>('/send-media', { method: 'POST', body: form });
    // Keep our own copy so the sent file shows immediately without a round trip.
    const rel = path.posix.join('whatsapp', safe(chat), `${safe(res.id)}${extFor(res.mime) || path.extname(file.filename)}`);
    await fsp.mkdir(path.dirname(path.join(config.attachmentsDir, rel)), { recursive: true });
    await fsp.writeFile(path.join(config.attachmentsDir, rel), file.buffer);
    await ingestMessage({
      network: 'whatsapp', service: 'whatsapp', conversation: conversationFor(chat),
      sourceId: res.id, sender: null, fromMe: true, body: caption || null, sentAt: new Date(res.timestamp),
      attachments: [{ sourceId: res.id, mime: res.mime, filename: file.filename, size: file.buffer.length, storagePath: rel }],
    });
    return res;
  }

  /** Sets my reaction on a message, or removes it (emoji null). WhatsApp doesn't echo my own reactions back, so store it here. */
  async react(chat: string, target: { sourceId: string; senderAddress: string | null }, emoji: string | null) {
    await this.call('/react', { method: 'POST', body: JSON.stringify({ chat, id: target.sourceId, sender: target.senderAddress ?? '', emoji: emoji ?? '' }) });
    await setReaction('whatsapp', target.sourceId, null, emoji);
  }

  async setTyping(chat: string, typing: boolean, audio = false) {
    await this.call('/typing', { method: 'POST', body: JSON.stringify({ chat, typing, audio }) });
  }

  /** Online while the web app is in use (needed to receive typing updates); chat is the open one-to-one chat, if any. */
  async setPresence(available: boolean, chat?: string | null) {
    if (!this.configured) return;
    await this.call('/presence', { method: 'POST', body: JSON.stringify({ available, chat: chat ?? '' }) });
  }

  /** Whether a +E.164 number has WhatsApp, and the chat id to message it at. */
  async check(phone: string): Promise<{ on: boolean; chat?: string }> {
    return this.call('/check', { method: 'POST', body: JSON.stringify({ phone }) });
  }

  async markRead(conversationId: number, chat: string) {
    const unread = await q<{ source_id: string; address: string | null }>(
      `select m.source_id, h.address from message m left join handle h on h.id = m.sender_handle_id
       where m.conversation_id = $1 and not m.from_me and m.read_at is null
       order by m.sent_at desc limit 50`,
      [conversationId],
    );
    if (!unread.length) return;
    await this.call('/read', { method: 'POST', body: JSON.stringify({ chat, messages: unread.map((u) => ({ id: u.source_id, sender: u.address ?? '' })) }) }).catch((e) =>
      this.log.warn({ err: String(e) }, 'WhatsApp mark read failed'),
    );
    await q('update message set read_at = now() where conversation_id = $1 and not from_me and read_at is null', [conversationId]);
  }

  async downloadAttachment(attachmentId: number): Promise<string> {
    const a = await q1<{ source_id: string; filename: string | null; mime: string | null; chat: string }>(
      `select a.source_id, a.filename, a.mime, c.source_id as chat from attachment a
       join message m on m.id = a.message_id join conversation c on c.id = m.conversation_id where a.id = $1`,
      [attachmentId],
    );
    if (!a) throw new Error('attachment not found');
    const res = await fetch(`${config.whatsapp.url}/media?chat=${encodeURIComponent(a.chat)}&id=${encodeURIComponent(a.source_id)}`, {
      headers: { 'x-internal-secret': config.whatsapp.secret },
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`media download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get('content-type') ?? a.mime ?? 'application/octet-stream';
    const rel = path.posix.join('whatsapp', safe(a.chat), `${safe(a.source_id)}${path.extname(a.filename ?? '') || extFor(mime)}`);
    const abs = path.join(config.attachmentsDir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buf);
    await q('update attachment set storage_path = $2, mime = coalesce(mime, $3), size = coalesce(size, $4) where id = $1', [attachmentId, rel, mime, buf.length]);
    return rel;
  }
}

/** The conversation a sent message belongs to. One-to-one chats list the other person, so they merge with that person's other chats. */
function conversationFor(chat: string) {
  const isGroup = chat.endsWith('@g.us');
  const [user, server] = chat.split('@');
  const address = server === 's.whatsapp.net' ? `+${user}` : server === 'lid' ? `lid:${user}` : null;
  return { sourceId: chat, isGroup, members: !isGroup && address ? [{ address }] : [] };
}

function safe(s: string) {
  // No leading dots, so a sender-chosen name can never be "." or "..".
  return s.replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';
}

function extFor(mime?: string | null) {
  if (!mime) return '';
  const m = mime.split(';')[0].trim();
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'application/pdf': '.pdf',
  };
  return map[m] ?? '';
}
