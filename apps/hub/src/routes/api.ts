import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { COOKIE, requireSession, sessionValid } from '../auth.js';
import { config } from '../config.js';
import { q, q1 } from '../db.js';
import type { BlueBubbles } from '../sources/bluebubbles.js';
import type { WhatsApp } from '../sources/whatsapp.js';
import { bus, emitLive, type LiveEvent } from '../store.js';
import { cached } from '../cache.js';
import { AVATAR_SIZES, resizedAvatar, THREAD_AVATAR_SQL, threadAvatar } from '../avatars.js';
import { approveSendRequest, listSendRequests, rejectSendRequest, sendText } from '../outbox.js';
import { listThreads, searchMessages, threadConversations, threadMessages, threadPins, type SearchFilter } from '../queries.js';

const THUMB_WIDTHS = new Set([320, 640, 1280]);
/** Image formats we make resized copies of. Others (SVG, TIFF, ...) are never decoded on the server. */
const THUMB_SOURCES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif', 'image/gif']);
/** Types shown in the browser. Everything else (HTML, SVG, XML, scripts, unknown) is sent as a download. */
const INLINE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp',
  'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/wav', 'audio/amr', 'audio/x-caf',
  'application/pdf',
]);
// Only the image decoders we need; the rest of libvips' loaders (SVG, PDF, TIFF, ...) stay off for untrusted input.
sharp.block({ operation: ['VipsForeignLoadSvg', 'VipsForeignLoadPdf', 'VipsForeignLoadTiff', 'VipsForeignLoadMagick', 'VipsForeignLoadOpenslide', 'VipsForeignLoadFits', 'VipsForeignLoadMatrix', 'VipsForeignLoadVips', 'VipsForeignLoadPpm', 'VipsForeignLoadRad', 'VipsForeignLoadAnalyze', 'VipsForeignLoadCsv', 'VipsForeignLoadJp2k'] });
const thumbsInflight = new Map<string, Promise<string>>();

/** Returns the relative path of a resized WebP copy of an image attachment, creating it if needed. */
function thumbnail(id: number, rel: string, width: number): Promise<string> {
  const out = path.posix.join('thumbs', `${id}-${width}.webp`);
  const abs = path.join(config.attachmentsDir, out);
  if (fs.existsSync(abs)) return Promise.resolve(out);
  let p = thumbsInflight.get(out);
  if (!p) {
    p = (async () => {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.${process.pid}.tmp`;
      await sharp(path.join(config.attachmentsDir, rel), { failOn: 'error' })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(tmp);
      await fs.promises.rename(tmp, abs);
      return out;
    })().finally(() => thumbsInflight.delete(out));
    thumbsInflight.set(out, p);
  }
  return p;
}

export function registerApiRoutes(app: FastifyInstance, bb: BlueBubbles, wa: WhatsApp) {
  // ---------- live updates ----------
  const sockets = new Set<WebSocket>();
  let refreshPending = false;
  const broadcast = (data: unknown) => {
    const json = JSON.stringify(data);
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(json);
  };
  bus.on('live', async (ev: LiveEvent) => {
    // History imports produce thousands of inserts: coalesce them into periodic refresh hints.
    if (ev.type === 'message' && ev.historical) {
      if (!refreshPending) {
        refreshPending = true;
        setTimeout(() => { refreshPending = false; broadcast({ type: 'refresh' }); }, 3000);
      }
      return;
    }
    if (ev.type === 'message') {
      const row = await q1(
        `select ct.tid, m.body, m.service, m.from_me, coalesce(spn.name, spa.address, sh.address) as sender_name,
                c.is_group, c.title, exists(select 1 from attachment a where a.message_id = m.id) as has_attachment,
                coalesce(c.muted_until > now(), false) as muted
         from message m join conversation c on c.id = m.conversation_id
         join conversation_thread ct on ct.conversation_id = c.id
         left join handle sh on sh.id = m.sender_handle_id
         left join person_name spn on spn.person_id = sh.person_id
         left join person_address spa on spa.person_id = sh.person_id
         where m.id = $1`,
        [ev.messageId],
      ).catch(() => undefined);
      broadcast({ ...ev, ...(row ? { tid: row.tid, preview: row } : {}) });
      return;
    }
    broadcast(ev);
  });

  app.get('/api/live', { websocket: true }, async (socket, req) => {
    // WebSockets aren't covered by CORS: only this app's own pages may open the live feed.
    const origin = req.headers.origin;
    let sameOrigin = false;
    try {
      sameOrigin = !!origin && new URL(origin).host === req.host;
    } catch {
      /* malformed origin */
    }
    if (!sameOrigin) {
      socket.close(4403, 'origin not allowed');
      return;
    }
    if (!(await sessionValid(req.cookies[COOKIE]))) {
      socket.close(4401, 'not logged in');
      return;
    }
    sockets.add(socket);
    const ping = setInterval(() => socket.ping(), 30_000);
    socket.on('close', () => {
      sockets.delete(socket);
      clearInterval(ping);
    });
  });

  // Everything below needs a session.
  app.register(async (r) => {
    r.addHook('preHandler', requireSession);

    r.get('/api/status', async () => ({ bluebubbles: { ...bb.status, url: bb.currentUrl }, whatsapp: await wa.status() }));

    r.put<{ Body: { url?: string; password?: string } }>('/api/settings/bluebubbles', async (req, reply) => {
      if (!req.body?.url || !req.body?.password) return reply.code(400).send({ error: 'Address and password are required' });
      await bb.configure(req.body.url, req.body.password);
      return { ok: true };
    });

    r.post('/api/whatsapp/pair', async () => wa.pair());
    r.post('/api/whatsapp/logout', async () => wa.logout());

    // ---------- inbox ----------
    r.get<{ Querystring: { limit?: string; offset?: string } }>('/api/threads', async (req) =>
      listThreads({ limit: Number(req.query.limit ?? 100), offset: Number(req.query.offset ?? 0) }),
    );

    r.get<{ Params: { tid: string } }>('/api/threads/:tid', async (req, reply) => {
      const detail = await cached(`thread:${req.params.tid}`, () => threadDetail(req.params.tid));
      return detail ?? reply.code(404).send({ error: 'thread not found' });
    });

    const threadDetail = async (tid: string) => {
      const convs = await threadConversations(tid);
      if (!convs.length) return null;
      const isGroup = convs[0].is_group;
      const personId = tid.startsWith('p') ? Number(tid.slice(1)) : null;
      const name = personId
        ? (await q1(`select coalesce(pn.name, pa.address) as name from (select $1::bigint as id) p
                     left join person_name pn on pn.person_id = p.id left join person_address pa on pa.person_id = p.id`, [personId]))?.name
        : null;
      const members = await q(
        `select distinct h.id, h.network, h.address, coalesce(pn.name, h.display_name) as name
         from conversation_member cm join handle h on h.id = cm.handle_id
         left join person_name pn on pn.person_id = h.person_id
         where cm.conversation_id = any($1)`,
        [convs.map((c) => c.id)],
      );
      const lastServices = await q(
        `select distinct on (conversation_id) conversation_id, service from message
         where conversation_id = any($1) order by conversation_id, sent_at desc`,
        [convs.map((c) => c.id)],
      );
      const svc = new Map(lastServices.map((r) => [r.conversation_id, r.service]));
      const avatar = (await q1<{ v: string | null }>(`select ${THREAD_AVATAR_SQL('$1::bigint', '$2::bigint')} as v`, [personId, convs[0].id]))?.v ?? null;
      return {
        tid: tid,
        isGroup,
        avatar,
        muted: convs.every((c) => !!c.muted_until && new Date(c.muted_until) > new Date()),
        title: convs[0].title ?? name ?? members.map((m) => m.name ?? m.address).join(', '),
        conversations: convs.map((c) => ({
          id: c.id, network: c.network, title: c.title, lastMessageAt: c.last_message_at, unread: c.unread_count,
          lastService: svc.get(c.id) ?? (c.network === 'whatsapp' ? 'whatsapp' : 'imessage'),
        })),
        members,
        pins: (await threadPins(convs.map((c) => c.id))).map((p) => ({
          id: p.id, pinnedAt: p.pinned_at, sentAt: p.sent_at, fromMe: p.from_me, text: p.body,
          sender: p.from_me ? null : p.sender_name, hasAttachment: p.has_attachment,
        })),
      };
    };

    r.get<{ Params: { tid: string }; Querystring: { before?: string; after?: string; around?: string; limit?: string } }>(
      '/api/threads/:tid/messages',
      async (req, reply) => {
        const convs = await threadConversations(req.params.tid);
        if (!convs.length) return reply.code(404).send({ error: 'thread not found' });
        const { before, after, around, limit } = req.query;
        return threadMessages(convs.map((c) => c.id), {
          before, after, around: around ? Number(around) : undefined, limit: limit ? Number(limit) : undefined,
        });
      },
    );

    // Mute or unmute every chat in a thread. WhatsApp chats are muted on the WhatsApp account too (so the phone
    // matches); iMessage has no shared mute setting the Mac can change, so those are muted in Message Hub only.
    r.post<{ Params: { tid: string }; Body: { muted?: boolean; hours?: number | null } }>('/api/threads/:tid/mute', async (req, reply) => {
      const convs = await threadConversations(req.params.tid);
      if (!convs.length) return reply.code(404).send({ error: 'thread not found' });
      const muted = !!req.body?.muted;
      const hours = Number(req.body?.hours);
      const until = muted && Number.isFinite(hours) && hours > 0 ? new Date(Date.now() + hours * 3_600_000) : null;
      for (const c of convs) {
        if (c.network === 'whatsapp') {
          await wa.setMute(c.source_id, muted, until).catch((e) => {
            throw Object.assign(new Error(`Couldn't change the mute setting on WhatsApp: ${e instanceof Error ? e.message : e}`), { statusCode: 502 });
          });
        }
        await q('update conversation set muted_until = $2 where id = $1', [c.id, muted ? (until ?? 'infinity') : null]);
        emitLive({ type: 'conversation-updated', conversationId: c.id });
      }
      return { ok: true, muted, until };
    });

    // Pin or unpin one message. Pins live only in the hub: nothing is sent to iMessage or WhatsApp.
    for (const [action, pinned] of [['pin', true], ['unpin', false]] as const) {
      r.post<{ Params: { id: string } }>(`/api/messages/:id/${action}`, async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id)) return reply.code(404).send({ error: 'message not found' });
        const row = await q1<{ conversation_id: number; pinned_at: string | null }>(
          // Pinning again keeps the original pin time; unsent messages can't be pinned.
          pinned
            ? "update message set pinned_at = coalesce(pinned_at, now()) where id = $1 and not unsent and kind = 'text' returning conversation_id, pinned_at"
            : 'update message set pinned_at = null where id = $1 returning conversation_id, pinned_at',
          [id],
        );
        if (!row) return reply.code(404).send({ error: 'message not found' });
        emitLive({ type: 'message-updated', conversationId: row.conversation_id, messageId: id });
        return { ok: true, pinned: !!row.pinned_at, pinnedAt: row.pinned_at };
      });
    }

    r.post<{ Params: { tid: string } }>('/api/threads/:tid/read', async (req) => {
      const convs = await threadConversations(req.params.tid);
      for (const c of convs) {
        if (c.unread_count > 0 || c.network === 'whatsapp') {
          if (c.network === 'apple') await bb.markRead(c.source_id).catch(() => {});
          else await wa.markRead(c.id, c.source_id).catch(() => {});
        }
        if (c.unread_count > 0) {
          await q('update conversation set unread_count = 0 where id = $1', [c.id]);
          emitLive({ type: 'conversation-updated', conversationId: c.id });
        }
      }
      return { ok: true };
    });

    const pickConversation = async (tid: string, conversationId?: number) => {
      const convs = await threadConversations(tid);
      const conv = conversationId ? convs.find((c) => c.id === Number(conversationId)) : convs[0];
      if (!conv) throw Object.assign(new Error('conversation not found'), { statusCode: 404 });
      return conv;
    };

    r.post<{ Params: { tid: string }; Body: { text?: string; conversationId?: number; replyToId?: number } }>(
      '/api/threads/:tid/send',
      async (req, reply) => {
        const text = req.body?.text?.trim();
        if (!text) return reply.code(400).send({ error: 'text is required' });
        const conv = await pickConversation(req.params.tid, req.body.conversationId);
        await sendText(bb, wa, conv, text, req.body.replyToId);
        return { ok: true };
      },
    );

    // ---------- messages Claude asked to send: only a signed-in user can approve them ----------
    r.get<{ Querystring: { status?: string } }>('/api/send-requests', async (req) => listSendRequests(req.query.status || undefined));
    r.post<{ Params: { id: string } }>('/api/send-requests/:id/approve', async (req) => approveSendRequest(bb, wa, Number(req.params.id)));
    r.post<{ Params: { id: string } }>('/api/send-requests/:id/reject', async (req) => rejectSendRequest(Number(req.params.id)));

    r.post<{ Params: { tid: string } }>('/api/threads/:tid/send-file', async (req, reply) => {
      const part = await req.file({ limits: { fileSize: 100 * 1024 * 1024 } });
      if (!part) return reply.code(400).send({ error: 'file is required' });
      const buffer = await part.toBuffer();
      const fields = part.fields as Record<string, { value?: string } | undefined>;
      const conversationId = fields.conversationId?.value ? Number(fields.conversationId.value) : undefined;
      const caption = fields.caption?.value?.trim() || undefined;
      const conv = await pickConversation(req.params.tid, conversationId);
      const file = { buffer, filename: part.filename || 'file', mime: part.mimetype || 'application/octet-stream' };
      try {
        if (conv.network === 'apple') {
          await bb.sendFile(conv.source_id, file);
          if (caption) await bb.sendText(conv.source_id, caption);
        } else {
          await wa.sendFile(conv.source_id, file, caption);
        }
      } catch (e: any) {
        throw Object.assign(new Error(e?.statusCode ? e.message : `Not sent: ${e?.message ?? e}`), { statusCode: e?.statusCode ?? 502 });
      }
      return { ok: true };
    });

    // ---------- search ----------
    r.get<{ Querystring: { q?: string; tid?: string; service?: string; limit?: string; offset?: string } }>('/api/search', async (req) => {
      const { q: text = '', tid, service, limit, offset } = req.query;
      return searchMessages({
        text, tid: tid || undefined, service: (service || undefined) as SearchFilter['service'],
        limit: Number(limit ?? 50), offset: Number(offset ?? 0),
      });
    });

    // ---------- profile photos ----------
    // /api/avatars/p12?w=64&v=<version>: the photo shown for a person or group thread (see avatars.ts for which one wins).
    // The version in the thread list changes when the photo does, so a versioned URL can be cached forever.
    r.get<{ Params: { tid: string }; Querystring: { w?: string; v?: string } }>('/api/avatars/:tid', async (req, reply) => {
      const av = await threadAvatar(req.params.tid);
      if (!av) return reply.code(404).send({ error: 'no photo' });
      const width = AVATAR_SIZES.has(Number(req.query.w)) ? Number(req.query.w) : 256;
      const etag = `"${av.etag}-${width}"`;
      reply.header('etag', etag);
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', req.query.v === av.etag ? 'private, max-age=31536000, immutable' : 'private, max-age=0, must-revalidate');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.type('image/webp').send(await resizedAvatar(av.etag, av.data, width));
    });

    // ---------- attachments ----------
    const inflight = new Map<number, Promise<string>>();
    const failed = new Map<number, { at: number; error: string }>();
    r.get<{ Params: { id: string }; Querystring: { w?: string; retry?: string } }>('/api/attachments/:id', async (req, reply) => {
      const id = Number(req.params.id);
      const a = await q1<{ storage_path: string | null; mime: string | null; filename: string | null; network: string }>(
        `select a.storage_path, a.mime, a.filename, c.network from attachment a
         join message m on m.id = a.message_id join conversation c on c.id = m.conversation_id where a.id = $1`,
        [id],
      );
      if (!a) return reply.code(404).send({ error: 'not found' });
      let rel = a.storage_path;
      if (!rel || !fs.existsSync(path.join(config.attachmentsDir, rel))) {
        // A photo iCloud couldn't deliver is not retried on every scroll; "Try again" in the app waits this out.
        const failedAt = failed.get(id);
        if (failedAt && Date.now() - failedAt.at < 10 * 60_000 && !req.query.retry) {
          return reply.code(502).send({ error: failedAt.error });
        }
        let p = inflight.get(id);
        if (!p) {
          p = (a.network === 'apple' ? bb.downloadAttachment(id) : wa.downloadAttachment(id)).finally(() => inflight.delete(id));
          inflight.set(id, p);
        }
        try {
          rel = await p;
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          failed.set(id, { at: Date.now(), error });
          return reply.code(502).send({ error });
        }
        failed.delete(id);
      }
      const updated = await q1<{ mime: string | null }>('select mime from attachment where id = $1', [id]);
      reply.header('cache-control', 'private, max-age=31536000, immutable');
      // Attachments come from other people. Even when opened directly in a tab they must not run as part of this
      // app: no scripts, no plugins, and anything outside a short list of media types is a download, never a page.
      reply.header('content-security-policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
      reply.header('x-content-type-options', 'nosniff');
      const mime = (updated?.mime ?? '').toLowerCase().split(';')[0].trim();
      const inline = INLINE_TYPES.has(mime);
      reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${(a.filename ?? `attachment-${id}`).replace(/[^\w.\- ]/g, '_')}"`);
      // ?w=640 etc.: a resized WebP for message bubbles, made once and kept next to the original.
      const width = Number(req.query.w);
      if (THUMB_WIDTHS.has(width) && THUMB_SOURCES.has(mime)) {
        const thumb = await thumbnail(id, rel, width).catch((e) => {
          req.log.warn({ attachmentId: id, err: String(e) }, 'thumbnail failed, sending the original');
          return null;
        });
        if (thumb) return reply.type('image/webp').header('content-disposition', 'inline').sendFile(thumb, config.attachmentsDir);
      }
      reply.type(inline ? mime : 'application/octet-stream');
      return reply.sendFile(rel, config.attachmentsDir);
    });
  });
}
