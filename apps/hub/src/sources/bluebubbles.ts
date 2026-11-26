import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { io, type Socket } from 'socket.io-client';
import { config } from '../config.js';
import { kvGet, kvSet, q, q1 } from '../db.js';
import {
  emitLive, ingestMessage, normalizeAddress, setConversationRead, setReaction, upsertConversation, upsertHandle,
  addMember, type MessageInput, type Service,
} from '../store.js';

type Log = { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };

// Shapes returned by the BlueBubbles Server REST API (only the fields we use).
interface BBHandle { address: string; service?: string }
interface BBChat { guid: string; displayName?: string | null; style?: number; participants?: BBHandle[] }
interface BBAttachment {
  guid: string; mimeType?: string | null; transferName?: string | null; totalBytes?: number | null;
  width?: number | null; height?: number | null; hideAttachment?: boolean; uti?: string | null;
}
interface BBMessage {
  originalROWID?: number;
  guid: string; text?: string | null; subject?: string | null; isFromMe: boolean;
  handle?: BBHandle | null; chats?: BBChat[]; attachments?: BBAttachment[];
  dateCreated: number; dateDelivered?: number | null; dateRead?: number | null;
  dateEdited?: number | null; dateRetracted?: number | null;
  associatedMessageGuid?: string | null; associatedMessageType?: string | number | null; associatedMessageEmoji?: string | null;
  threadOriginatorGuid?: string | null;
  itemType?: number; groupTitle?: string | null; groupActionType?: number;
  error?: number;
}

const TAPBACKS: Record<string, string> = {
  love: '\u2764\uFE0F', like: '\uD83D\uDC4D', dislike: '\uD83D\uDC4E', laugh: '\uD83D\uDE02',
  emphasize: '\u203C\uFE0F', question: '\u2753',
};
const TAPBACK_CODES = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'emoji'];

const ROWID_KEY = 'bluebubbles.rowid';
const res_total = (res: any): number => Number(res?.metadata?.total ?? res?.data?.length ?? 0);
const SETTINGS_KEY = 'bluebubbles.settings';

export class BlueBubbles {
  private socket?: Socket;
  private chatCache = new Map<string, BBChat>();
  private syncing = false;
  status = {
    configured: false, connected: false, privateApi: false, serverVersion: null as string | null,
    osVersion: null as string | null, lastSyncAt: null as string | null, importing: false, error: null as string | null,
  };

  /** Connection settings: from env, or saved from the web app's Settings (env wins). */
  private conn = { url: config.bluebubbles.url, password: config.bluebubbles.password };
  private timer?: NodeJS.Timeout;
  /** iCloud downloads go through Messages on the Mac; a few at a time keeps it responsive. */
  private icloudSlots = new Limiter(3);

  constructor(private log: Log) {}

  get currentUrl() {
    return this.conn.url || null;
  }

  // ---------- HTTP ----------

  private url(p: string, query: Record<string, string> = {}) {
    const u = new URL(`${this.conn.url}/api/v1${p}`);
    u.searchParams.set('password', this.conn.password);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  private async api<T = any>(p: string, init: { method?: string; body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
    const isForm = init.body instanceof FormData;
    const res = await fetch(this.url(p, init.query), {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: init.body && !isForm ? { 'content-type': 'application/json' } : undefined,
      body: init.body ? (isForm ? (init.body as FormData) : JSON.stringify(init.body)) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 120_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || (json.status && json.status >= 400)) {
      throw new Error(`BlueBubbles ${p} failed: ${res.status} ${json?.error?.message ?? json?.message ?? ''}`.trim());
    }
    return json as T;
  }

  // ---------- lifecycle ----------

  async start() {
    if (!this.conn.url || !this.conn.password) {
      const saved = await kvGet<{ url: string; password: string }>(SETTINGS_KEY);
      if (saved) this.conn = saved;
    }
    this.status.configured = !!(this.conn.url && this.conn.password);
    if (!this.status.configured) {
      this.log.warn({}, 'BlueBubbles not configured yet; set it in the web app Settings');
      return;
    }
    this.connectSocket();
    await this.fullSync().catch((e) => this.fail(e));
    // Periodic catch-up in case socket events were missed (Messages.app in a VM can go quiet).
    this.timer = setInterval(() => this.fullSync().catch((e) => this.fail(e)), 5 * 60_000);
    this.timer.unref();
  }

  /** Test new connection settings, save them, and reconnect. Throws if the server rejects them. */
  async configure(url: string, password: string) {
    const clean = url.trim().replace(/\/+$/, '');
    const u = new URL(`${clean}/api/v1/server/info`);
    u.searchParams.set('password', password);
    const res = await fetch(u, { signal: AbortSignal.timeout(10_000) }).catch((e) => {
      throw Object.assign(new Error(`Cannot reach ${clean}: ${e.message}`), { statusCode: 400 });
    });
    if (res.status === 401) throw Object.assign(new Error('BlueBubbles rejected that password'), { statusCode: 400 });
    if (!res.ok) throw Object.assign(new Error(`BlueBubbles answered HTTP ${res.status}`), { statusCode: 400 });
    await kvSet(SETTINGS_KEY, { url: clean, password });
    this.socket?.close();
    if (this.timer) clearInterval(this.timer);
    this.conn = { url: clean, password };
    this.status = { ...this.status, configured: true, connected: false, error: null };
    this.start().catch((e) => this.fail(e));
  }

  private fail(e: unknown) {
    this.status.error = e instanceof Error ? e.message : String(e);
    this.log.error({ err: this.status.error }, 'BlueBubbles sync failed');
    emitLive({ type: 'status', source: 'bluebubbles' });
  }

  private connectSocket() {
    const { url, password } = this.conn;
    this.socket = io(url, { query: { guid: password, password }, transports: ['websocket'], reconnection: true });
    this.socket.on('connect', () => {
      this.status.connected = true;
      this.status.error = null;
      this.log.info({}, 'BlueBubbles socket connected');
      emitLive({ type: 'status', source: 'bluebubbles' });
      this.fullSync().catch((e) => this.fail(e));
    });
    this.socket.on('disconnect', (reason) => {
      this.status.connected = false;
      this.log.warn({ reason }, 'BlueBubbles socket disconnected');
      emitLive({ type: 'status', source: 'bluebubbles' });
    });
    this.socket.on('connect_error', (e) => {
      this.status.connected = false;
      this.status.error = `socket: ${e.message}`;
    });
    // iCloud backfill can also arrive as "new" events: only recent messages count as unread / notify.
    const onMsg = (m: BBMessage) =>
      this.ingest(m, Date.now() - (m?.dateCreated ?? 0) > 10 * 60_000).catch((e) => this.log.error({ err: String(e) }, 'ingest failed'));
    this.socket.on('new-message', onMsg);
    this.socket.on('updated-message', onMsg);
    this.socket.on('chat-read-status-changed', (d: { chatGuid: string; read: boolean }) => {
      if (d?.read) setConversationRead('apple', d.chatGuid).catch(() => {});
    });
    this.socket.on('group-name-change', (m: BBMessage) => onMsg(m));
    this.socket.on('participant-added', (m: BBMessage) => onMsg(m));
    this.socket.on('participant-removed', (m: BBMessage) => onMsg(m));
    this.socket.on('participant-left', (m: BBMessage) => onMsg(m));
  }

  private async fullSync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const info = await this.api('/server/info');
      this.status.privateApi = !!info.data?.private_api;
      this.status.serverVersion = info.data?.server_version ?? null;
      this.status.osVersion = info.data?.os_version ?? null;
      this.status.error = null;
      await this.syncContacts();
      await this.syncChats();
      await this.syncMessages();
      this.status.lastSyncAt = new Date().toISOString();
      emitLive({ type: 'status', source: 'bluebubbles' });
    } finally {
      this.syncing = false;
    }
  }

  private async syncContacts() {
    let contacts: any[] = [];
    try {
      contacts = (await this.api('/contact')).data ?? [];
    } catch (e) {
      this.log.warn({ err: String(e) }, 'could not load Mac contacts (grant BlueBubbles Contacts access)');
      return;
    }
    for (const c of contacts) {
      const name = c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || null;
      if (!name) continue;
      const addresses = [...(c.phoneNumbers ?? []), ...(c.emails ?? [])].map((x: any) => x?.address).filter(Boolean);
      for (const raw of addresses) {
        await upsertHandle('apple', { address: normalizeAddress(raw) ?? raw, displayName: name, nameSource: 'contacts' });
      }
    }
  }

  private async syncChats() {
    for (let offset = 0; ; offset += 500) {
      const res = await this.api('/chat/query', { body: { limit: 500, offset, with: ['participants'] } });
      const chats: BBChat[] = res.data ?? [];
      for (const chat of chats) await this.upsertChat(chat);
      if (chats.length < 500) break;
    }
  }

  private async upsertChat(chat: BBChat): Promise<number> {
    this.chatCache.set(chat.guid, chat);
    const isGroup = isGroupChat(chat);
    const id = await upsertConversation('apple', { sourceId: chat.guid, title: chat.displayName || null, isGroup });
    for (const p of chat.participants ?? []) {
      if (p?.address) await addMember(id, await upsertHandle('apple', { address: p.address }));
    }
    return id;
  }

  private async getChat(guid: string): Promise<BBChat> {
    const cached = this.chatCache.get(guid);
    if (cached) return cached;
    try {
      const chat: BBChat = (await this.api(`/chat/${encodeURIComponent(guid)}`, { query: { with: 'participants' } })).data;
      await this.upsertChat(chat);
      return chat;
    } catch {
      return { guid };
    }
  }

  /**
   * Walk chat.db by ROWID, not by date: Messages in iCloud backfills old history with new
   * (higher) ROWIDs but old dates, so a date cursor would skip it. Rows inside a ROWID window
   * never change, which keeps offset paging stable while new messages arrive.
   */
  private async syncMessages() {
    const WINDOW = 5000;
    const PAGE = 1000;
    let cursor = (await kvGet<number>(ROWID_KEY)) ?? 0;
    let maxSeen = cursor;
    this.status.importing = cursor === 0;
    let count = 0;
    const query = (where: string, args: Record<string, number>, offset: number, limit: number) =>
      this.api('/message/query', {
        body: {
          limit, offset, sort: 'ASC',
          where: [{ statement: where, args }],
          with: ['chat', 'chat.participants', 'attachment', 'handle', 'attributedBody'],
        },
      });

    for (;;) {
      const lo = cursor;
      const hi = cursor + WINDOW;
      let got = 0;
      for (let offset = 0; ; offset += PAGE) {
        const res = await query('message.ROWID > :lo AND message.ROWID <= :hi', { lo, hi }, offset, PAGE);
        const msgs: BBMessage[] = res.data ?? [];
        for (const m of msgs) {
          // Anything older than 10 minutes is history: no unread bump or notification.
          await this.ingest(m, Date.now() - m.dateCreated > 10 * 60_000);
          if ((m.originalROWID ?? 0) > maxSeen) maxSeen = m.originalROWID!;
        }
        got += msgs.length;
        // Guard: a server that ignores the ROWID filter would make this loop forever.
        if (msgs.some((m) => m.originalROWID == null || m.originalROWID <= lo || m.originalROWID > hi)) {
          this.log.warn({}, 'BlueBubbles ignored the ROWID filter; stopping this sync pass');
          this.status.importing = false;
          return;
        }
        if (msgs.length < PAGE) break;
      }
      count += got;
      if (got === 0) {
        // An empty window can be a gap (deleted rows); stop only when nothing lies beyond it.
        const rest = await query('message.ROWID > :hi', { hi }, 0, 1);
        if (!(res_total(rest) > 0)) break;
      }
      cursor = hi;
      // Persist the highest ROWID actually seen, never the window edge, so later rows are not skipped.
      await kvSet(ROWID_KEY, maxSeen);
      if (this.status.importing) this.log.info({ count, rowid: maxSeen }, 'importing iMessage history');
    }
    await this.retryOrphanReactions();
    if (count) this.log.info({ count }, 'iMessage sync complete');
    this.status.importing = false;
  }

  /** Tapbacks whose target message had not been imported yet when they arrived. */
  private orphans = new Map<string, { m: BBMessage; tries: number }>();

  private async retryOrphanReactions() {
    for (const [guid, o] of this.orphans) {
      this.orphans.delete(guid);
      if (o.tries < 5) await this.ingest(o.m, true, o.tries + 1);
    }
  }

  // ---------- ingest ----------

  private async ingest(m: BBMessage, historical: boolean, tries = 0) {
    if (!m?.guid) return;
    let chat = m.chats?.[0];
    if (!chat?.guid) return;
    if (!chat.participants?.length) chat = await this.getChat(chat.guid);
    else if (!this.chatCache.has(chat.guid)) await this.upsertChat(chat);

    const sender = !m.isFromMe && m.handle?.address ? { address: m.handle.address } : null;

    // Tapbacks arrive as separate messages pointing at their target.
    if (m.associatedMessageGuid && m.associatedMessageType != null && m.associatedMessageType !== 0 && m.associatedMessageType !== '0') {
      const target = m.associatedMessageGuid.replace(/^(?:p:\d+\/|bp:)/, '');
      const reaction = parseTapback(m.associatedMessageType, m.associatedMessageEmoji);
      if (reaction && !(await setReaction('apple', target, sender, reaction.remove ? null : reaction.emoji))) {
        this.orphans.set(m.guid, { m, tries });
      }
      return;
    }

    const service = serviceFor(chat.guid, m.handle?.service);
    const system = systemText(m);
    const body = system ?? cleanText(m.text, m.subject);
    const attachments = (m.attachments ?? [])
      .filter((a) => !a.hideAttachment && !(a.transferName ?? '').endsWith('.pluginPayloadAttachment'))
      .map((a) => ({
        sourceId: a.guid, mime: a.mimeType ?? null, filename: a.transferName ?? null, size: a.totalBytes ?? null,
        width: a.width ?? null, height: a.height ?? null,
      }));
    if (!body && !attachments.length && !m.dateRetracted) return;

    const input: MessageInput = {
      network: 'apple',
      service,
      conversation: { sourceId: chat.guid, title: chat.displayName || undefined, isGroup: isGroupChat(chat) },
      sourceId: m.guid,
      sender,
      fromMe: m.isFromMe,
      kind: system ? 'system' : 'text',
      body,
      sentAt: new Date(m.dateCreated),
      deliveredAt: m.dateDelivered ? new Date(m.dateDelivered) : null,
      readAt: m.dateRead ? new Date(m.dateRead) : null,
      editedAt: m.dateEdited ? new Date(m.dateEdited) : null,
      unsent: !!m.dateRetracted,
      replyToSourceId: m.threadOriginatorGuid ?? null,
      attachments,
      status: m.error ? 'failed' : 'sent',
      historical,
    };
    await ingestMessage(input);
  }

  // ---------- actions ----------

  async sendText(chatGuid: string, text: string, replyToGuid?: string | null) {
    const method = this.status.privateApi ? 'private-api' : 'apple-script';
    const body: Record<string, unknown> = { chatGuid, tempGuid: `temp-${randomUUID()}`, message: text, method };
    if (replyToGuid && this.status.privateApi) Object.assign(body, { selectedMessageGuid: replyToGuid, partIndex: 0 });
    const res = await this.api('/message/text', { body, timeoutMs: 45_000 }).catch((e) => {
      if (e?.name === 'TimeoutError') {
        throw Object.assign(new Error("The Mac didn't confirm the message in time. Check for a prompt in Messages or BlueBubbles on the Mac."), { statusCode: 504 });
      }
      throw e;
    });
    if (res.data?.guid) await this.ingest(res.data, false);
    return res.data;
  }

  async sendFile(chatGuid: string, file: { buffer: Buffer; filename: string; mime: string }) {
    const form = new FormData();
    form.set('chatGuid', chatGuid);
    form.set('tempGuid', `temp-${randomUUID()}`);
    form.set('name', file.filename);
    form.set('method', this.status.privateApi ? 'private-api' : 'apple-script');
    form.set('attachment', new Blob([new Uint8Array(file.buffer)], { type: file.mime }), file.filename);
    const res = await this.api('/message/attachment', { body: form });
    if (res.data?.guid) await this.ingest(res.data, false);
    return res.data;
  }

  async markRead(chatGuid: string) {
    if (!this.status.privateApi) return;
    await this.api(`/chat/${encodeURIComponent(chatGuid)}/read`, { method: 'POST' }).catch(() => {});
  }

  /** Download an attachment into the local cache and return its relative path. */
  async downloadAttachment(attachmentId: number): Promise<string> {
    const a = await q1<{ source_id: string; filename: string | null }>('select source_id, filename from attachment where id = $1', [attachmentId]);
    if (!a) throw new Error('attachment not found');
    const guid = encodeURIComponent(a.source_id);
    let res = await fetch(this.url(`/attachment/${guid}/download`), { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Photos synced from Messages in iCloud stay in iCloud until opened on the Mac. The Private API can
      // make Messages fetch them ("force" download); without it there is nothing to download.
      if (!/does not exist in disk/i.test(detail)) throw new Error(`attachment download failed: ${res.status}`);
      res = await this.icloudSlots.run(() => fetch(this.url(`/attachment/${guid}/download/force`), { signal: AbortSignal.timeout(300_000) }));
      if (!res.ok || (res.headers.get('content-type') ?? '').includes('application/json')) {
        const why = await res.text().catch(() => '');
        res = await fetch(this.url(`/attachment/${guid}/download`), { signal: AbortSignal.timeout(300_000) });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          this.log.warn({ attachmentId, why: why.slice(0, 200) }, 'iCloud attachment download failed');
          throw new Error('This photo is still in iCloud and the Mac could not download it.');
        }
      }
    }
    if (!res.ok || !res.body) throw new Error(`attachment download failed: ${res.status}`);
    // BlueBubbles converts HEIC to JPEG on download; follow the served type when it differs.
    const served = res.headers.get('content-type');
    let filename = safeName(a.filename ?? a.source_id);
    if (served?.includes('jpeg') && /\.heic$/i.test(filename)) filename = filename.replace(/\.heic$/i, '.jpg');
    const rel = path.posix.join('apple', safeName(a.source_id), filename);
    const abs = path.join(config.attachmentsDir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(abs));
    await q('update attachment set storage_path = $2, mime = coalesce($3, mime) where id = $1', [attachmentId, rel, served?.split(';')[0] ?? null]);
    return rel;
  }
}

// ---------- helpers ----------

class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

function isGroupChat(chat: BBChat) {
  return chat.style === 43 || chat.guid.includes(';+;') || (chat.participants?.length ?? 0) > 1;
}

function serviceFor(chatGuid: string, handleService?: string): Service {
  const prefix = chatGuid.split(';')[0].toLowerCase();
  const s = prefix === 'any' ? (handleService ?? 'imessage').toLowerCase() : prefix;
  if (s === 'sms') return 'sms';
  if (s === 'rcs') return 'rcs';
  return 'imessage';
}

function cleanText(text?: string | null, subject?: string | null) {
  const t = [subject, text].filter(Boolean).join('\n').replace(/\uFFFC/g, '').trim();
  return t || null;
}

function systemText(m: BBMessage): string | null {
  switch (m.itemType) {
    case 1: return m.groupActionType === 1 ? 'removed someone from the conversation' : 'added someone to the conversation';
    case 2: return m.groupTitle ? `named the conversation "${m.groupTitle}"` : 'renamed the conversation';
    case 3: return m.groupActionType === 1 ? 'changed the group photo' : 'left the conversation';
    default: return null;
  }
}

function parseTapback(type: string | number, emoji?: string | null): { emoji: string; remove: boolean } | null {
  let name: string;
  let remove = false;
  if (typeof type === 'number' || /^\d+$/.test(String(type))) {
    const n = Number(type);
    if (n >= 3000 && n < 3010) { remove = true; name = TAPBACK_CODES[n - 3000]; }
    else if (n >= 2000 && n < 2010) name = TAPBACK_CODES[n - 2000];
    else return null;
  } else {
    name = String(type);
    if (name.startsWith('-')) { remove = true; name = name.slice(1); }
  }
  if (!name) return null;
  if (name === 'emoji') return emoji ? { emoji, remove } : null;
  const e = TAPBACKS[name];
  return e ? { emoji: e, remove } : null;
}

function safeName(s: string) {
  return s.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
}
