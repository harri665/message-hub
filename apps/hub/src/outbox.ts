// Sending, and the approval queue for messages Claude asks to send.
// Only the web routes (which need a signed-in session) call approveSendRequest; the MCP server can only create and read requests.
import { q, q1 } from './db.js';
import { threadConversations, listThreads, type ConvRow } from './queries.js';
import type { BlueBubbles } from './sources/bluebubbles.js';
import type { WhatsApp } from './sources/whatsapp.js';
import { emitLive, type Service } from './store.js';

export const MAX_PENDING = 10;
export const EXPIRY_HOURS = 24;
export const MAX_TEXT = 4000;

export interface SendRequest {
  id: number; tid: string; thread_title: string | null; conversation_id: number; service: Service; text: string;
  reply_to_message_id: number | null; requested_by: string;
  status: 'pending' | 'approved' | 'rejected' | 'sent' | 'failed' | 'expired';
  error: string | null; created_at: string; decided_at: string | null; sent_at: string | null; message_id: number | null;
  reply_to_body?: string | null; reply_to_from_me?: boolean | null;
}

/** Sends text into one conversation. Shared by the composer and by approved requests. Returns the id of the stored message, if known. */
export async function sendText(
  bb: BlueBubbles, wa: WhatsApp, conv: Pick<ConvRow, 'id' | 'network' | 'source_id'>, text: string, replyToId?: number | null,
): Promise<number | null> {
  const replyTo = replyToId
    ? await q1(
        `select m.source_id, m.body, m.from_me, h.address from message m left join handle h on h.id = m.sender_handle_id
         where m.id = $1 and m.conversation_id = $2`,
        [replyToId, conv.id],
      )
    : undefined;
  let sourceId: string | undefined;
  if (conv.network === 'apple') {
    sourceId = (await bb.sendText(conv.source_id, text, replyTo?.source_id))?.guid;
  } else {
    sourceId = (await wa.sendText(conv.source_id, text, replyTo ? { id: replyTo.source_id, sender: replyTo.from_me ? '' : replyTo.address ?? '', text: replyTo.body ?? '' } : null))?.id;
  }
  if (!sourceId) return null;
  const m = await q1<{ id: number }>('select id from message where conversation_id = $1 and source_id = $2 limit 1', [conv.id, sourceId]);
  return m?.id ?? null;
}

const SELECT = `select p.*, rt.body as reply_to_body, rt.from_me as reply_to_from_me
                from pending_send p left join message rt on rt.id = p.reply_to_message_id`;

async function expireOld() {
  const rows = await q(
    `update pending_send set status = 'expired', decided_at = now()
     where status = 'pending' and created_at < now() - make_interval(hours => $1) returning id`,
    [EXPIRY_HOURS],
  );
  if (rows.length) emitLive({ type: 'send-request' });
}

export async function listSendRequests(status?: string, limit = 50): Promise<SendRequest[]> {
  await expireOld();
  return q<SendRequest>(`${SELECT} where ($1::text is null or p.status = $1) order by p.created_at desc limit $2`, [status ?? null, limit]);
}

export async function getSendRequest(id: number): Promise<SendRequest | undefined> {
  await expireOld();
  return q1<SendRequest>(`${SELECT} where p.id = $1`, [id]);
}

/** Stores a pending request. Throws an Error with a user-facing message if it can't be made. */
export async function createSendRequest(a: {
  tid: string; text: string; service?: Service; replyToMessageId?: number; requestedBy: string;
}): Promise<SendRequest> {
  await expireOld();
  const convs = await threadConversations(a.tid);
  if (!convs.length) throw new Error(`No conversation ${a.tid}.`);
  const wantWa = a.service === 'whatsapp';
  const conv = a.service ? convs.find((c) => (c.network === 'whatsapp') === wantWa) : convs[0];
  if (!conv) throw new Error(`Conversation ${a.tid} has no ${wantWa ? 'WhatsApp' : 'iMessage/SMS/RCS'} chat. Leave service out or pick another.`);
  let service: Service = wantWa || conv.network === 'whatsapp' ? 'whatsapp' : (a.service as Service | undefined) ?? 'imessage';
  if (!a.service && conv.network === 'apple') {
    const last = await q1<{ service: Service }>('select service from message where conversation_id = $1 order by sent_at desc limit 1', [conv.id]);
    if (last) service = last.service;
  }
  if (a.replyToMessageId) {
    const ok = await q1('select 1 from message where id = $1 and conversation_id = $2', [a.replyToMessageId, conv.id]);
    if (!ok) throw new Error(`Message ${a.replyToMessageId} isn't in conversation ${a.tid}.`);
  }
  const pending = await q1<{ n: string }>(`select count(*) as n from pending_send where status = 'pending'`);
  if (Number(pending!.n) >= MAX_PENDING) {
    throw new Error(`${MAX_PENDING} send requests are already waiting for the user's approval. Wait for them to be decided before asking for more.`);
  }
  const [info] = await listThreads({ tid: a.tid, limit: 1 });
  const row = await q1<{ id: number }>(
    `insert into pending_send (tid, thread_title, conversation_id, service, text, reply_to_message_id, requested_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [a.tid, info?.title ?? null, conv.id, service, a.text, a.replyToMessageId ?? null, a.requestedBy],
  );
  emitLive({ type: 'send-request' });
  return (await getSendRequest(row!.id))!;
}

export class SendRequestError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

/**
 * The only way a request turns into a sent message. Called from the session-protected web route.
 * The status flip is atomic, so a double click or two open tabs can't send twice.
 */
export async function approveSendRequest(bb: BlueBubbles, wa: WhatsApp, id: number): Promise<SendRequest> {
  await expireOld();
  const claimed = await q1<SendRequest>(
    `update pending_send set status = 'approved', decided_at = now()
     where id = $1 and status = 'pending' and created_at > now() - make_interval(hours => $2) returning *`,
    [id, EXPIRY_HOURS],
  );
  if (!claimed) {
    const cur = await getSendRequest(id);
    if (!cur) throw new SendRequestError(404, 'Request not found.');
    throw new SendRequestError(409, cur.status === 'expired' ? 'This request expired. Ask Claude to send it again.' : `This request was already ${cur.status}.`);
  }
  emitLive({ type: 'send-request' });
  const fail = async (error: string) => {
    await q(`update pending_send set status = 'failed', error = $2 where id = $1`, [id, error.slice(0, 500)]);
    emitLive({ type: 'send-request' });
    return (await getSendRequest(id))!;
  };
  const conv = await q1<ConvRow>('select * from conversation where id = $1', [claimed.conversation_id]);
  if (!conv) return fail('The conversation no longer exists.');
  try {
    const messageId = await sendText(bb, wa, conv, claimed.text, claimed.reply_to_message_id);
    await q(`update pending_send set status = 'sent', sent_at = now(), message_id = $2 where id = $1`, [id, messageId]);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  emitLive({ type: 'send-request' });
  return (await getSendRequest(id))!;
}

export async function rejectSendRequest(id: number): Promise<SendRequest> {
  await expireOld();
  const row = await q1(`update pending_send set status = 'rejected', decided_at = now() where id = $1 and status = 'pending' returning id`, [id]);
  if (!row) {
    const cur = await getSendRequest(id);
    if (!cur) throw new SendRequestError(404, 'Request not found.');
    throw new SendRequestError(409, `This request was already ${cur.status}.`);
  }
  emitLive({ type: 'send-request' });
  return (await getSendRequest(id))!;
}
