import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { COOKIE, requireSession, sessionValid } from '../auth.js';
import { config } from '../config.js';
import { q, q1 } from '../db.js';
import type { BlueBubbles } from '../sources/bluebubbles.js';
import type { WhatsApp } from '../sources/whatsapp.js';
import { bus, emitLive, type LiveEvent } from '../store.js';

interface ConvRow {
  id: number; network: 'apple' | 'whatsapp'; source_id: string; title: string | null; is_group: boolean;
  last_message_at: string | null; unread_count: number;
}

const MESSAGE_COLUMNS = `
  m.id, m.conversation_id, m.service, m.from_me, m.kind, m.body, m.sent_at, m.delivered_at, m.read_at, m.edited_at,
  m.unsent, m.status,
  sh.person_id as sender_person_id,
  coalesce(spn.name, spa.address, sh.address) as sender_name,
  coalesce((select json_agg(json_build_object('id', a.id, 'mime', a.mime, 'filename', a.filename, 'size', a.size,
                                              'width', a.width, 'height', a.height) order by a.id)
            from attachment a where a.message_id = m.id), '[]') as attachments,
  coalesce((select json_agg(json_build_object('emoji', r.emoji, 'fromMe', r.sender_key = 'me',
                                              'name', coalesce(rpn.name, rh.address)) order by r.created_at)
            from reaction r left join handle rh on rh.id = r.sender_handle_id
            left join person_name rpn on rpn.person_id = rh.person_id
            where r.message_id = m.id), '[]') as reactions,
  rt.id as reply_to_id, left(rt.body, 200) as reply_to_body, rt.from_me as reply_to_from_me,
  coalesce(rtn.name, rth.address) as reply_to_name`;

const MESSAGE_JOINS = `
  left join handle sh on sh.id = m.sender_handle_id
  left join person_name spn on spn.person_id = sh.person_id
  left join person_address spa on spa.person_id = sh.person_id
  left join message rt on m.reply_to_source_id is not null and rt.source_id = m.reply_to_source_id and rt.conversation_id = m.conversation_id
  left join handle rth on rth.id = rt.sender_handle_id
  left join person_name rtn on rtn.person_id = rth.person_id`;

async function threadConversations(tid: string): Promise<ConvRow[]> {
  const id = Number(tid.slice(1));
  if (!Number.isFinite(id)) return [];
  if (tid.startsWith('p')) {
    return q<ConvRow>(
      `select distinct c.* from conversation c
       join conversation_member cm on cm.conversation_id = c.id
       join handle h on h.id = cm.handle_id
       where h.person_id = $1 and not c.is_group
       order by c.last_message_at desc nulls last`,
      [id],
    );
  }
  if (tid.startsWith('c')) return q<ConvRow>('select * from conversation where id = $1', [id]);
  return [];
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
                c.is_group, c.title, exists(select 1 from attachment a where a.message_id = m.id) as has_attachment
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

    r.get('/api/status', async () => ({ bluebubbles: bb.status, whatsapp: await wa.status() }));

    r.post('/api/whatsapp/pair', async () => wa.pair());
    r.post('/api/whatsapp/logout', async () => wa.logout());

    // ---------- inbox ----------
    r.get<{ Querystring: { limit?: string; offset?: string } }>('/api/threads', async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 100), 500);
      const offset = Number(req.query.offset ?? 0);
      return q(
        `with threads as (
           select ct.tid,
                  min(case when ct.tid like 'p%' then substr(ct.tid, 2)::bigint end) as person_id,
                  bool_or(c.is_group) as is_group,
                  max(c.last_message_at) as last_at,
                  sum(c.unread_count)::int as unread,
                  array_agg(c.id) as conversation_ids,
                  array_agg(distinct c.network) as networks,
                  max(c.title) filter (where c.is_group) as group_title
           from conversation c join conversation_thread ct on ct.conversation_id = c.id
           where not c.archived
           group by ct.tid
         )
         select t.tid, t.is_group, t.last_at, t.unread, t.conversation_ids, t.networks,
                coalesce(t.group_title, pn.name, pa.address, gm.names, 'Unknown') as title,
                lm.body as last_body, lm.from_me as last_from_me, lm.service as last_service, lm.kind as last_kind,
                lm.unsent as last_unsent, lm.has_attachment as last_has_attachment, lm.sender_name as last_sender_name
         from threads t
         left join person_name pn on pn.person_id = t.person_id
         left join person_address pa on pa.person_id = t.person_id
         left join lateral (
           select string_agg(coalesce(mpn.name, mpa.address, h.address), ', ') as names
           from (select h.* from conversation_member cm join handle h on h.id = cm.handle_id
                 where t.is_group and cm.conversation_id = t.conversation_ids[1] limit 5) h
           left join person_name mpn on mpn.person_id = h.person_id
           left join person_address mpa on mpa.person_id = h.person_id
         ) gm on true
         left join lateral (
           select m.body, m.from_me, m.service, m.kind, m.unsent,
                  exists(select 1 from attachment a where a.message_id = m.id) as has_attachment,
                  coalesce(spn.name, sh.address) as sender_name
           from message m
           left join handle sh on sh.id = m.sender_handle_id
           left join person_name spn on spn.person_id = sh.person_id
           where m.conversation_id = any(t.conversation_ids)
           order by m.sent_at desc limit 1
         ) lm on true
         where t.last_at is not null
         order by t.last_at desc
         limit $1 offset $2`,
        [limit, offset],
      );
    });

    r.get<{ Params: { tid: string } }>('/api/threads/:tid', async (req, reply) => {
      const convs = await threadConversations(req.params.tid);
      if (!convs.length) return reply.code(404).send({ error: 'thread not found' });
      const isGroup = convs[0].is_group;
      const personId = req.params.tid.startsWith('p') ? Number(req.params.tid.slice(1)) : null;
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
      return {
        tid: req.params.tid,
        isGroup,
        title: convs[0].title ?? name ?? members.map((m) => m.name ?? m.address).join(', '),
        conversations: convs.map((c) => ({
          id: c.id, network: c.network, title: c.title, lastMessageAt: c.last_message_at, unread: c.unread_count,
          lastService: svc.get(c.id) ?? (c.network === 'whatsapp' ? 'whatsapp' : 'imessage'),
        })),
        members,
      };
    });

    r.get<{ Params: { tid: string }; Querystring: { before?: string; limit?: string } }>('/api/threads/:tid/messages', async (req, reply) => {
      const convs = await threadConversations(req.params.tid);
      if (!convs.length) return reply.code(404).send({ error: 'thread not found' });
      const limit = Math.min(Number(req.query.limit ?? 60), 200);
      const rows = await q(
        `select ${MESSAGE_COLUMNS} from message m ${MESSAGE_JOINS}
         where m.conversation_id = any($1) and ($2::timestamptz is null or m.sent_at < $2)
         order by m.sent_at desc limit $3`,
        [convs.map((c) => c.id), req.query.before ?? null, limit],
      );
      return rows.reverse();
    });

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
        const replyTo = req.body.replyToId
          ? await q1(
              `select m.source_id, m.body, m.from_me, h.address from message m left join handle h on h.id = m.sender_handle_id
               where m.id = $1 and m.conversation_id = $2`,
              [req.body.replyToId, conv.id],
            )
          : undefined;
        if (conv.network === 'apple') {
          await bb.sendText(conv.source_id, text, replyTo?.source_id);
        } else {
          await wa.sendText(conv.source_id, text, replyTo ? { id: replyTo.source_id, sender: replyTo.from_me ? '' : replyTo.address ?? '', text: replyTo.body ?? '' } : null);
        }
        return { ok: true };
      },
    );

    r.post<{ Params: { tid: string } }>('/api/threads/:tid/send-file', async (req, reply) => {
      const part = await req.file({ limits: { fileSize: 100 * 1024 * 1024 } });
      if (!part) return reply.code(400).send({ error: 'file is required' });
      const buffer = await part.toBuffer();
      const fields = part.fields as Record<string, { value?: string } | undefined>;
      const conversationId = fields.conversationId?.value ? Number(fields.conversationId.value) : undefined;
      const caption = fields.caption?.value?.trim() || undefined;
      const conv = await pickConversation(req.params.tid, conversationId);
      const file = { buffer, filename: part.filename || 'file', mime: part.mimetype || 'application/octet-stream' };
      if (conv.network === 'apple') {
        await bb.sendFile(conv.source_id, file);
        if (caption) await bb.sendText(conv.source_id, caption);
      } else {
        await wa.sendFile(conv.source_id, file, caption);
      }
      return { ok: true };
    });

    // ---------- search ----------
    r.get<{ Querystring: { q?: string } }>('/api/search', async (req) => {
      const words = (req.query.q ?? '').split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
      if (!words.length) return [];
      const tsq = words.map((w) => `${w}:*`).join(' & ');
      return q(
        `select ${MESSAGE_COLUMNS}, ct.tid,
                coalesce(c.title, tpn.name, tpa.address) as thread_title
         from message m ${MESSAGE_JOINS}
         join conversation c on c.id = m.conversation_id
         join conversation_thread ct on ct.conversation_id = c.id
         left join person_name tpn on ct.tid like 'p%' and tpn.person_id = substr(ct.tid, 2)::bigint
         left join person_address tpa on ct.tid like 'p%' and tpa.person_id = substr(ct.tid, 2)::bigint
         where m.tsv @@ to_tsquery('simple', $1)
         order by m.sent_at desc limit 100`,
        [tsq],
      );
    });

    // ---------- attachments ----------
    const inflight = new Map<number, Promise<string>>();
    r.get<{ Params: { id: string } }>('/api/attachments/:id', async (req, reply) => {
      const id = Number(req.params.id);
      const a = await q1<{ storage_path: string | null; mime: string | null; filename: string | null; network: string }>(
        `select a.storage_path, a.mime, a.filename, c.network from attachment a
         join message m on m.id = a.message_id join conversation c on c.id = m.conversation_id where a.id = $1`,
        [id],
      );
      if (!a) return reply.code(404).send({ error: 'not found' });
      let rel = a.storage_path;
      if (!rel || !fs.existsSync(path.join(config.attachmentsDir, rel))) {
        let p = inflight.get(id);
        if (!p) {
          p = (a.network === 'apple' ? bb.downloadAttachment(id) : wa.downloadAttachment(id)).finally(() => inflight.delete(id));
          inflight.set(id, p);
        }
        try {
          rel = await p;
        } catch (e) {
          return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
        }
      }
      const updated = await q1<{ mime: string | null }>('select mime from attachment where id = $1', [id]);
      reply.header('cache-control', 'private, max-age=31536000, immutable');
      if (updated?.mime) reply.type(updated.mime);
      return reply.sendFile(rel, config.attachmentsDir);
    });
  });
}
