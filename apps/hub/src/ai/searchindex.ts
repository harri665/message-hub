// Search by meaning. Messages are grouped into chunks: consecutive messages in one chat with no long pause between them,
// a few minutes of conversation each, because a lone "ok" or "haha" means nothing by itself. Each chunk's text (names,
// messages, photo descriptions) is embedded with bge-m3 and stored in pgvector; a search embeds the question and returns
// the nearest chunks. A chat's newest messages wait until the conversation pauses, so a chunk isn't cut mid-exchange.
// A chunk is rebuilt (and only re-embedded if its text changed) when one of its messages changes or gets a photo description.
import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { pool, q } from '../db.js';
import { parseSearch } from '../searchquery.js';
import { budget, NEW_DAYS, type Priority } from './usage.js';
import { AiError, embed, vectorLiteral } from './workers.js';

const GAP_MS = 30 * 60_000;
const SETTLE_MS = 30 * 60_000;
const MAX_CHARS = 1500;
const MAX_LINES = 30;
const LINE_CHARS = 500;

export interface IndexMessage {
  id: number;
  sent_at: string | Date;
  from_me: boolean;
  kind: string;
  unsent: boolean;
  body: string | null;
  sender_name: string | null;
  attachments: { mime: string | null; filename: string | null; description: string | null }[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One line of chunk text ("Mom: see you soon [photo: a beach at sunset]"), or null for messages left out. */
export function indexLine(m: IndexMessage): string | null {
  if (m.kind === 'system' || m.unsent) return null;
  const parts: string[] = [];
  const body = m.body?.replace(/\s+/g, ' ').trim();
  if (body) parts.push(body);
  for (const a of m.attachments ?? []) {
    const mime = a.mime ?? '';
    if (mime.startsWith('image/')) parts.push(a.description ? `[photo: ${a.description}]` : '[photo]');
    else if (mime.startsWith('video/')) parts.push('[video]');
    else if (mime.startsWith('audio/')) parts.push('[audio]');
    else parts.push(`[file: ${a.filename ?? 'attachment'}]`);
  }
  if (!parts.length) return null;
  return `${m.from_me ? 'Me' : (m.sender_name ?? 'Someone')}: ${clip(parts.join(' '), LINE_CHARS)}`;
}

/**
 * Splits a chat's messages (oldest first) into chunks: a new chunk starts after a pause of GAP_MS or when the chunk is
 * full. The last chunk is held back while its newest message is younger than SETTLE_MS, or when `more` says the list
 * was cut off, since later messages may still belong to it.
 */
export function groupMessages<T extends { sent_at: string | Date }>(msgs: T[], lineOf: (m: T) => string | null, now: number, more = false): T[][] {
  const groups: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  let lines = 0;
  let lastAt = 0;
  for (const m of msgs) {
    const at = new Date(m.sent_at).getTime();
    const line = lineOf(m);
    const len = line?.length ?? 0;
    if (cur.length && (at - lastAt > GAP_MS || chars + len > MAX_CHARS || (line && lines >= MAX_LINES))) {
      groups.push(cur);
      cur = [];
      chars = 0;
      lines = 0;
    }
    cur.push(m);
    chars += len;
    if (line) lines++;
    lastAt = at;
  }
  if (cur.length && !more && now - lastAt >= SETTLE_MS) groups.push(cur);
  return groups;
}

const fmtDay = (d: string | Date) =>
  new Date(d).toLocaleDateString('en-US', { timeZone: config.timeZone, year: 'numeric', month: 'short', day: 'numeric' });

/** The embedded text: a header naming the chat and the day, then one line per message. */
export function chunkText(title: string, isGroup: boolean, first: string | Date, last: string | Date, lines: string[]) {
  const a = fmtDay(first);
  const b = fmtDay(last);
  return `Chat with ${title}${isGroup ? ' (group)' : ''}, ${a === b ? a : `${a} to ${b}`}\n${lines.join('\n')}`;
}

const INDEX_MESSAGE_SQL = `
  select m.id, m.sent_at, m.from_me, m.kind, m.unsent, m.body, m.search_chunk_id,
         coalesce(spn.name, sh.display_name, sh.address) as sender_name,
         coalesce((select json_agg(json_build_object('mime', a.mime, 'filename', a.filename, 'description', a.description) order by a.id)
                   from attachment a where a.message_id = m.id), '[]') as attachments
  from message m
  left join handle sh on sh.id = m.sender_handle_id
  left join person_name spn on spn.person_id = sh.person_id`;

const THREAD_TITLE_SQL = `coalesce(c.title, tpn.name, tpa.address, 'Unknown')`;
const THREAD_JOINS = `
  join conversation_thread ct on ct.conversation_id = c.id
  left join person_name tpn on ct.tid like 'p%' and tpn.person_id = substr(ct.tid, 2)::bigint
  left join person_address tpa on ct.tid like 'p%' and tpa.person_id = substr(ct.tid, 2)::bigint`;

/** Marks the chunk holding a message for rebuilding (its text changed, or a photo in it was described). */
export async function markChunkStale(messageId: number) {
  await q(
    'update search_chunk set stale = true where id = (select search_chunk_id from message where id = $1) and not stale',
    [messageId],
  );
}

/** Groups messages that aren't in a chunk yet. Free: no AI calls. */
async function buildChunks(deadline: number) {
  const done: number[] = [];
  while (Date.now() < deadline) {
    const convs = await q<{ conversation_id: number }>(
      `select distinct conversation_id from message
       where search_chunk_id is null and sent_at < now() - interval '${SETTLE_MS / 60_000} minutes' and conversation_id <> all($1)
       limit 50`,
      [done],
    );
    if (!convs.length) return;
    for (const { conversation_id: cid } of convs) {
      done.push(cid);
      const limit = 1000;
      const msgs = await q<IndexMessage>(
        `${INDEX_MESSAGE_SQL} where m.conversation_id = $1 and m.search_chunk_id is null order by m.sent_at, m.id limit ${limit}`,
        [cid],
      );
      const groups = groupMessages(msgs, indexLine, Date.now(), msgs.length === limit);
      if (!groups.length) continue;
      const client = await pool.connect();
      try {
        await client.query('begin');
        for (const g of groups) {
          const { rows } = await client.query<{ id: number }>(
            `insert into search_chunk (conversation_id, first_message_id, first_sent_at, last_sent_at, message_count)
             values ($1, $2, $3, $4, $5) returning id`,
            [cid, g[0].id, g[0].sent_at, g[g.length - 1].sent_at, g.length],
          );
          await client.query('update message set search_chunk_id = $1 where id = any($2)', [rows[0].id, g.map((m) => m.id)]);
        }
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw e;
      } finally {
        client.release();
      }
      if (Date.now() >= deadline) return;
    }
  }
}

/** Rebuilds and embeds stale chunks: recent ones first, then old ones while the budget allows backlog work. */
async function embedStale(deadline: number, log: FastifyBaseLogger) {
  for (const priority of ['new', 'backlog'] as Priority[]) {
    const recent = priority === 'new';
    while (Date.now() < deadline) {
      if (!(await budget(priority)).ok) break;
      const chunks = await q<{ id: number; text_hash: string | null; embedded: boolean; first_sent_at: string; last_sent_at: string; title: string; is_group: boolean }>(
        `select sc.id, sc.text_hash, sc.embedding is not null as embedded, sc.first_sent_at, sc.last_sent_at, ${THREAD_TITLE_SQL} as title, c.is_group
         from search_chunk sc join conversation c on c.id = sc.conversation_id ${THREAD_JOINS}
         where sc.stale and sc.last_sent_at ${recent ? '>=' : '<'} now() - interval '${NEW_DAYS} days'
         order by sc.last_sent_at desc limit 48`,
      );
      if (!chunks.length) break;
      const msgs = await q<IndexMessage & { search_chunk_id: number }>(
        `${INDEX_MESSAGE_SQL} where m.search_chunk_id = any($1) order by m.sent_at, m.id`,
        [chunks.map((c) => c.id)],
      );
      const linesBy = new Map<number, string[]>();
      for (const m of msgs) {
        const line = indexLine(m);
        if (line) linesBy.set(m.search_chunk_id, [...(linesBy.get(m.search_chunk_id) ?? []), line]);
      }
      const toEmbed: { id: number; text: string; hash: string }[] = [];
      for (const c of chunks) {
        const lines = linesBy.get(c.id) ?? [];
        if (!lines.length) {
          await q("update search_chunk set text = '', text_hash = null, embedding = null, stale = false where id = $1", [c.id]);
          continue;
        }
        const text = chunkText(c.title, c.is_group, c.first_sent_at, c.last_sent_at, lines);
        const hash = createHash('sha1').update(text).digest('hex');
        if (hash === c.text_hash && c.embedded) await q('update search_chunk set stale = false where id = $1', [c.id]);
        else toEmbed.push({ id: c.id, text, hash });
      }
      if (!toEmbed.length) continue;
      let vectors: number[][];
      try {
        vectors = await embed(toEmbed.map((c) => c.text.slice(0, 8000)), recent ? 'search-index' : 'search-backlog', priority);
      } catch (e) {
        if (!(e instanceof AiError && (e.kind === 'budget' || e.kind === 'off'))) log.warn({ err: String(e) }, 'search indexing failed');
        return;
      }
      for (const [i, c] of toEmbed.entries()) {
        await q(
          'update search_chunk set text = $2, text_hash = $3, embedding = $4::vector, model = $5, stale = false where id = $1',
          [c.id, c.text, c.hash, vectorLiteral(vectors[i]), config.ai.models.embed],
        );
      }
    }
  }
}

let running = false;

/** One round of indexing: group new messages, then embed what changed. */
export async function indexRound(log: FastifyBaseLogger) {
  if (running) return;
  running = true;
  try {
    const deadline = Date.now() + 50_000;
    await buildChunks(Date.now() + 20_000);
    await embedStale(deadline, log);
  } finally {
    running = false;
  }
}

export interface MeaningHit {
  chunkId: number;
  tid: string;
  threadTitle: string;
  isGroup: boolean;
  /** The chunk's first message: where the conversation opens. */
  messageId: number;
  firstSentAt: string;
  lastSentAt: string;
  /** The chunk's messages, one per line (without the header). */
  text: string;
  /** Cosine similarity, 0 to 1. */
  score: number;
}

/**
 * Chunks closest in meaning to the text, best first. `in:`-style narrowing comes from `tid`; date filters typed in
 * the text (before:, after:, during:) are applied, and other filters are ignored.
 */
export async function searchByMeaning(o: { text: string; tid?: string; convIds?: number[]; limit?: number }): Promise<MeaningHit[]> {
  const parsed = parseSearch(o.text, { tz: config.timeZone });
  const query = (parsed.text || o.text).trim().slice(0, 1000);
  if (!query) return [];
  const [vector] = await embed([query], 'search', 'interactive');
  const args: unknown[] = [vectorLiteral(vector)];
  const arg = (v: unknown) => { args.push(v); return `$${args.length}`; };
  const where = ['sc.embedding is not null'];
  if (o.convIds) where.push(`sc.conversation_id = any(${arg(o.convIds)})`);
  if (parsed.sentAfter) where.push(`sc.last_sent_at >= ${arg(parsed.sentAfter)}`);
  if (parsed.sentBefore) where.push(`sc.first_sent_at < ${arg(parsed.sentBefore)}`);
  const limit = Math.min(Math.max(o.limit ?? 10, 1), 50);
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Filtered searches keep scanning the graph until enough matches are found (pgvector 0.8 iterative scans).
    await client.query('set local hnsw.ef_search = 100');
    await client.query("set local hnsw.iterative_scan = 'relaxed_order'");
    const { rows } = await client.query(
      `with near as materialized (
         select sc.id, sc.conversation_id, sc.first_message_id, sc.first_sent_at, sc.last_sent_at, sc.text,
                sc.embedding <=> $1::vector as distance
         from search_chunk sc where ${where.join(' and ')}
         order by sc.embedding <=> $1::vector limit ${limit}
       )
       select near.*, ct.tid, ${THREAD_TITLE_SQL} as title, c.is_group
       from near join conversation c on c.id = near.conversation_id ${THREAD_JOINS}
       order by near.distance`,
      args,
    );
    await client.query('commit');
    return rows.map((r) => ({
      chunkId: r.id, tid: r.tid, threadTitle: r.title, isGroup: r.is_group, messageId: r.first_message_id,
      firstSentAt: r.first_sent_at, lastSentAt: r.last_sent_at, text: String(r.text).split('\n').slice(1).join('\n'),
      score: Math.max(0, 1 - Number(r.distance)),
    }));
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * The hits worth showing: close enough in absolute terms (unrelated text still scores around 0.3 to 0.4 with bge-m3)
 * and not far behind the best one, so a vague search doesn't list every chat.
 */
export function relevantHits<T extends { score: number }>(hits: T[], min = 0.45, spread = 0.1): T[] {
  const best = hits[0]?.score ?? 0;
  return hits.filter((h) => h.score >= min && h.score >= best - spread);
}

/** Counts for the Settings page. */
export async function indexStats() {
  const [c] = await q<{ chunks: number; embedded: number; stale: number }>(
    `select count(*)::int as chunks, count(embedding)::int as embedded, count(*) filter (where stale)::int as stale from search_chunk`,
  );
  const [m] = await q<{ n: number }>('select count(*)::int as n from message where search_chunk_id is null');
  return { chunks: c?.chunks ?? 0, embedded: c?.embedded ?? 0, waitingChunks: c?.stale ?? 0, waitingMessages: m?.n ?? 0 };
}
