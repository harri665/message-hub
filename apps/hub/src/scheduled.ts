// Scheduled messages: stored in Postgres and sent by the hub, so they go out whatever state the phone, Mac or apps are in.
// Guarantees: a message is sent at most once (rows are claimed with a single UPDATE ... FOR UPDATE SKIP LOCKED), a hub restart
// loses nothing, and one that came due while the hub was down is sent only if it is less than MISSED_AFTER_MS late.
// Only signed-in web routes create these; there is deliberately no MCP tool for them (Claude's sends go through outbox.ts approval).
import { q, q1 } from './db.js';
import { MAX_TEXT, sendText } from './outbox.js';
import { listThreads, threadConversations, type ConvRow } from './queries.js';
import type { BlueBubbles } from './sources/bluebubbles.js';
import type { WhatsApp } from './sources/whatsapp.js';
import { emitLive, type Service } from './store.js';

export * from './schedulerules.js';
import { MAX_ATTEMPTS, MAX_ACTIVE, MISSED_AFTER_MS, STUCK_AFTER_MS, TICK_MS, ScheduleError, isSafeToRetry, parseSendAt, retryDelayMs } from './schedulerules.js';

export type ScheduledStatus = 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface ScheduledRow {
  id: number; tid: string; conversation_id: number; service: Service; text: string; reply_to_message_id: number | null;
  send_at: string; status: ScheduledStatus; error: string | null; attempts: number; retry_at: string | null;
  created_at: string; sent_at: string | null; message_id: number | null; thread_title?: string | null;
  reply_to_body?: string | null;
}

// ---------- queries ----------

export function toJson(r: ScheduledRow) {
  return {
    id: r.id, tid: r.tid, threadTitle: r.thread_title ?? null, conversationId: r.conversation_id, service: r.service, text: r.text,
    replyToId: r.reply_to_message_id, replyToBody: r.reply_to_body ?? null, sendAt: r.send_at, status: r.status, error: r.error,
    attempts: r.attempts, retryAt: r.retry_at, createdAt: r.created_at, sentAt: r.sent_at, messageId: r.message_id,
  };
}

const ACTIVE = `('scheduled','sending','failed')`;

export async function listScheduled(tid?: string): Promise<ScheduledRow[]> {
  const rows = await q<ScheduledRow>(
    `select s.*, rt.body as reply_to_body from scheduled_message s left join message rt on rt.id = s.reply_to_message_id
     where s.status in ${ACTIVE} and ($1::text is null or s.tid = $1)
     order by s.send_at, s.id limit 500`,
    [tid ?? null],
  );
  if (!tid && rows.length) {
    const titles = new Map<string, string | null>();
    for (const t of await listThreads({ limit: 500 })) titles.set(t.tid, t.title ?? null);
    for (const r of rows) r.thread_title = titles.get(r.tid) ?? null;
  }
  return rows;
}

async function getRow(id: number): Promise<ScheduledRow | undefined> {
  return q1<ScheduledRow>(
    `select s.*, rt.body as reply_to_body from scheduled_message s left join message rt on rt.id = s.reply_to_message_id where s.id = $1`,
    [id],
  );
}

function changed(tid: string) {
  emitLive({ type: 'scheduled', tid });
}

export async function createScheduled(a: { tid: string; text: unknown; sendAt: unknown; conversationId?: number; replyTo?: number | null }): Promise<ScheduledRow> {
  const text = typeof a.text === 'string' ? a.text.trim() : '';
  if (!text) throw new ScheduleError(400, 'text is required');
  if (text.length > MAX_TEXT) throw new ScheduleError(400, `Messages can be up to ${MAX_TEXT} characters.`);
  const sendAt = parseSendAt(a.sendAt);
  const convs = await threadConversations(a.tid);
  const conv = a.conversationId ? convs.find((c) => c.id === Number(a.conversationId)) : convs[0];
  if (!conv) throw new ScheduleError(404, 'conversation not found');
  if (a.replyTo) {
    const ok = await q1('select 1 from message where id = $1 and conversation_id = $2', [a.replyTo, conv.id]);
    if (!ok) throw new ScheduleError(400, "That message isn't in this conversation.");
  }
  const n = await q1<{ n: number }>(`select count(*) as n from scheduled_message where status in ('scheduled','sending')`);
  if (Number(n!.n) >= MAX_ACTIVE) throw new ScheduleError(409, `You already have ${MAX_ACTIVE} scheduled messages.`);
  let service: Service = conv.network === 'whatsapp' ? 'whatsapp' : 'imessage';
  if (conv.network === 'apple') {
    const last = await q1<{ service: Service }>('select service from message where conversation_id = $1 order by sent_at desc limit 1', [conv.id]);
    if (last) service = last.service;
  }
  const row = await q1<{ id: number }>(
    `insert into scheduled_message (tid, conversation_id, service, text, reply_to_message_id, send_at) values ($1,$2,$3,$4,$5,$6) returning id`,
    [a.tid, conv.id, service, text, a.replyTo || null, sendAt],
  );
  changed(a.tid);
  return (await getRow(row!.id))!;
}

/** Edits the text and/or time. Only while it is still scheduled; a message already being sent can't be changed. */
export async function editScheduled(id: number, patch: { text?: unknown; sendAt?: unknown }): Promise<ScheduledRow> {
  const sets: string[] = [];
  const args: unknown[] = [id];
  if (patch.text !== undefined) {
    const text = typeof patch.text === 'string' ? patch.text.trim() : '';
    if (!text) throw new ScheduleError(400, 'text can\'t be empty');
    if (text.length > MAX_TEXT) throw new ScheduleError(400, `Messages can be up to ${MAX_TEXT} characters.`);
    args.push(text);
    sets.push(`text = $${args.length}`);
  }
  if (patch.sendAt !== undefined) {
    args.push(parseSendAt(patch.sendAt));
    sets.push(`send_at = $${args.length}`, 'attempts = 0', 'retry_at = null');
  }
  // A failed message that gets a new time is scheduled again.
  const reschedule = patch.sendAt !== undefined;
  if (reschedule) sets.push(`status = 'scheduled'`, 'error = null');
  if (!sets.length) throw new ScheduleError(400, 'Nothing to change.');
  const row = await q1<{ tid: string }>(
    `update scheduled_message set ${sets.join(', ')}, updated_at = now() where id = $1 and status in ('scheduled'${reschedule ? ", 'failed'" : ''}) returning tid`, args,
  );
  if (!row) throw await notEditable(id);
  changed(row.tid);
  return (await getRow(id))!;
}

async function notEditable(id: number): Promise<ScheduleError> {
  const cur = await getRow(id);
  if (!cur) return new ScheduleError(404, 'Scheduled message not found.');
  const why: Record<string, string> = {
    sending: 'It is being sent right now.', sent: 'It was already sent.', cancelled: 'It was cancelled.', failed: 'It failed to send.',
  };
  return new ScheduleError(409, why[cur.status] ?? `It is ${cur.status}.`);
}

/** Cancels a scheduled message, or dismisses a failed one. */
export async function cancelScheduled(id: number): Promise<ScheduledRow> {
  const row = await q1<{ tid: string }>(
    `update scheduled_message set status = 'cancelled', updated_at = now() where id = $1 and status in ('scheduled','failed') returning tid`, [id],
  );
  if (!row) throw await notEditable(id);
  changed(row.tid);
  return (await getRow(id))!;
}

/** Makes a scheduled or failed message due now and sends it straight away. */
export async function sendScheduledNow(bb: BlueBubbles, wa: WhatsApp, id: number): Promise<ScheduledRow> {
  const row = await q1<{ tid: string }>(
    `update scheduled_message set status = 'scheduled', send_at = now(), attempts = 0, retry_at = null, error = null, updated_at = now()
     where id = $1 and status in ('scheduled','failed') returning tid`, [id],
  );
  if (!row) throw await notEditable(id);
  changed(row.tid);
  await runScheduler(bb, wa);
  return (await getRow(id))!;
}

// ---------- the scheduler ----------

/** Marks messages that are 24 hours or more late as failed ("missed"), and ones stuck mid-send. Returns the changed rows. */
export async function expireScheduled(): Promise<{ tid: string }[]> {
  const missed = await q<{ tid: string }>(
    `update scheduled_message set status = 'failed', updated_at = now(),
       error = 'Missed: the hub was not running at the scheduled time, so it was not sent.'
     where status = 'scheduled' and send_at <= now() - make_interval(secs => $1) returning tid`,
    [MISSED_AFTER_MS / 1000],
  );
  const stuck = await q<{ tid: string }>(
    `update scheduled_message set status = 'failed', updated_at = now(),
       error = 'The hub stopped while sending this. It may or may not have gone out, so check the conversation before sending it again.'
     where status = 'sending' and claimed_at <= now() - make_interval(secs => $1) returning tid`,
    [STUCK_AFTER_MS / 1000],
  );
  return [...missed, ...stuck];
}

/** Takes due messages for sending. The single UPDATE flips the status, so two schedulers (or two hubs) can't both get a row. */
export async function claimDue(limit = 10): Promise<ScheduledRow[]> {
  return q<ScheduledRow>(
    `update scheduled_message set status = 'sending', claimed_at = now(), attempts = attempts + 1, updated_at = now()
     where id in (
       select id from scheduled_message
       where status = 'scheduled' and send_at <= now() and coalesce(retry_at, send_at) <= now()
         and send_at > now() - make_interval(secs => $2)
       order by send_at, id limit $1 for update skip locked)
     returning *`,
    [limit, MISSED_AFTER_MS / 1000],
  );
}

async function deliver(bb: BlueBubbles, wa: WhatsApp, row: ScheduledRow, log?: { warn: (o: any, m?: string) => void }) {
  try {
    const conv = await q1<ConvRow>('select * from conversation where id = $1', [row.conversation_id]);
    if (!conv) throw new Error('The conversation no longer exists.');
    const messageId = await sendText(bb, wa, conv, row.text, row.reply_to_message_id);
    await q(`update scheduled_message set status = 'sent', sent_at = now(), message_id = $2, error = null, updated_at = now() where id = $1`, [row.id, messageId]);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    log?.warn({ id: row.id, err: msg }, 'scheduled send failed');
    if (row.attempts < MAX_ATTEMPTS && isSafeToRetry(e)) {
      await q(
        `update scheduled_message set status = 'scheduled', error = $2, retry_at = now() + make_interval(secs => $3), updated_at = now() where id = $1`,
        [row.id, msg, retryDelayMs(row.attempts) / 1000],
      );
    } else {
      await q(`update scheduled_message set status = 'failed', error = $2, updated_at = now() where id = $1`, [row.id, msg]);
    }
  }
}

let running = false;
/** One pass: expire, claim, send. Safe to call at any time; overlapping calls are skipped. */
export async function runScheduler(bb: BlueBubbles, wa: WhatsApp, log?: { warn: (o: any, m?: string) => void }) {
  if (running) return;
  running = true;
  try {
    const tids = new Set((await expireScheduled()).map((r) => r.tid));
    for (const r of await claimDue()) {
      tids.add(r.tid);
      emitLive({ type: 'scheduled', tid: r.tid });
      await deliver(bb, wa, r, log);
      tids.add(r.tid);
    }
    for (const tid of tids) changed(tid);
  } finally {
    running = false;
  }
}

export function startScheduler(bb: BlueBubbles, wa: WhatsApp, log: { warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void }) {
  const tick = () => runScheduler(bb, wa, log).catch((e) => log.error(e, 'scheduler pass failed'));
  // Give BlueBubbles and WhatsApp a moment to connect before the first pass after a restart.
  setTimeout(tick, 10_000).unref();
  setInterval(tick, TICK_MS).unref();
}
