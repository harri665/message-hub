// Read queries shared by the web API and the MCP server.
import { cached } from './cache.js';
import { THREAD_AVATAR_SQL } from './avatars.js';
import { q, q1 } from './db.js';

export interface ConvRow {
  id: number; network: 'apple' | 'whatsapp'; source_id: string; title: string | null; is_group: boolean;
  last_message_at: string | null; unread_count: number; muted_until: string | null;
}

export const MESSAGE_COLUMNS = `
  m.id, m.conversation_id, m.service, m.from_me, m.kind, m.body, m.sent_at, m.delivered_at, m.read_at, m.edited_at,
  m.unsent, m.status, m.pinned_at,
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

export const MESSAGE_JOINS = `
  left join handle sh on sh.id = m.sender_handle_id
  left join person_name spn on spn.person_id = sh.person_id
  left join person_address spa on spa.person_id = sh.person_id
  left join message rt on m.reply_to_source_id is not null and rt.source_id = m.reply_to_source_id and rt.conversation_id = m.conversation_id
  left join handle rth on rth.id = rt.sender_handle_id
  left join person_name rtn on rtn.person_id = rth.person_id`;

/** The conversations behind a thread id: "p<person>" merges a person's 1:1 chats on every service, "c<id>" is one group. */
export function threadConversations(tid: string): Promise<ConvRow[]> {
  return cached(`convs:${tid}`, () => loadThreadConversations(tid));
}

async function loadThreadConversations(tid: string): Promise<ConvRow[]> {
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

// ---------- inbox ----------

export interface ThreadFilter { limit?: number; offset?: number; unreadOnly?: boolean; match?: string; tid?: string }

/**
 * Threads newest first. `match` keeps threads whose name, member names or addresses contain the text.
 * Names and addresses are resolved once per query (materialized CTEs) rather than per thread, and the last message
 * is looked up only for the page being returned.
 */
export function listThreads(f: ThreadFilter = {}) {
  const limit = Math.min(f.limit ?? 100, 500);
  const match = f.match?.trim() ? `%${f.match.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const digits = f.match?.replace(/\D/g, '') ?? '';
  const args = [limit, f.offset ?? 0, !!f.unreadOnly, match, digits, f.tid ?? null];
  return cached(`threads:${JSON.stringify(args)}`, () => q(THREADS_SQL, args));
}

const THREADS_SQL = `
    with pn as materialized (select * from person_name),
         pa as materialized (select * from person_address),
         ct as materialized (select * from conversation_thread),
         threads as (
           select ct.tid,
                  min(case when ct.tid like 'p%' then substr(ct.tid, 2)::bigint end) as person_id,
                  bool_or(c.is_group) as is_group,
                  max(c.last_message_at) as last_at,
                  sum(c.unread_count)::int as unread,
                  array_agg(c.id order by c.last_message_at desc nulls last) as conversation_ids,
                  array_agg(distinct c.network) as networks,
                  max(c.title) filter (where c.is_group) as group_title,
                  -- A thread is muted when every chat in it is (a person's iMessage and WhatsApp chats can differ).
                  bool_and(coalesce(c.muted_until > now(), false)) as muted,
                  min(c.muted_until) filter (where c.muted_until > now()) as muted_until
           from conversation c join ct on ct.conversation_id = c.id
           where not c.archived
           group by ct.tid
           having max(c.last_message_at) is not null
         ),
         gm as (
           select t.tid, string_agg(coalesce(mpn.name, mpa.address, h.address), ', ') as names
           from threads t
           cross join lateral (select h.* from conversation_member cm join handle h on h.id = cm.handle_id
                               where cm.conversation_id = t.conversation_ids[1] order by h.id limit 5) h
           left join pn mpn on mpn.person_id = h.person_id
           left join pa mpa on mpa.person_id = h.person_id
           where t.is_group
           group by t.tid
         ),
         named as (
           select t.*, coalesce(t.group_title, pn.name, pa.address, gm.names, 'Unknown') as title
           from threads t
           left join pn on pn.person_id = t.person_id
           left join pa on pa.person_id = t.person_id
           left join gm on gm.tid = t.tid
         ),
         matched as (
           select distinct ct.tid from conversation_member cm
           join handle h on h.id = cm.handle_id
           join ct on ct.conversation_id = cm.conversation_id
           left join pn hpn on hpn.person_id = h.person_id
           where $4::text is not null
             and (hpn.name ilike $4 or h.display_name ilike $4 or h.address ilike $4
                  or (length($5) >= 4 and regexp_replace(h.address, '\\D', '', 'g') like '%' || $5 || '%'))
         ),
         page as (
           select n.* from named n
           where (not $3 or n.unread > 0)
             and ($6::text is null or n.tid = $6)
             and ($4::text is null or n.title ilike $4 or n.tid in (select tid from matched))
           order by n.last_at desc
           limit $1 offset $2
         )
    select p.tid, p.is_group, p.last_at, p.unread, p.conversation_ids, p.networks, p.title, p.muted, p.muted_until,
           ${THREAD_AVATAR_SQL('p.person_id', 'p.conversation_ids[1]')} as avatar,
           lm.body as last_body, lm.from_me as last_from_me, lm.service as last_service, lm.kind as last_kind,
           lm.unsent as last_unsent, lm.has_attachment as last_has_attachment, lm.sender_name as last_sender_name
    from page p
    left join lateral (
      select m.body, m.from_me, m.service, m.kind, m.unsent,
             exists(select 1 from attachment a where a.message_id = m.id) as has_attachment,
             coalesce(spn.name, sh.address) as sender_name
      from unnest(p.conversation_ids) as cid
      cross join lateral (select * from message m where m.conversation_id = cid order by m.sent_at desc limit 1) m
      left join handle sh on sh.id = m.sender_handle_id
      left join pn spn on spn.person_id = sh.person_id
      order by m.sent_at desc limit 1
    ) lm on true
    order by p.last_at desc`;

// ---------- messages ----------

export interface MessagePage { before?: string; after?: string; around?: number; limit?: number }

/** Messages of a thread, oldest first: the newest page, a page before/after a time, or a window around one message. */
export function threadMessages(convIds: number[], p: MessagePage = {}) {
  return cached(`messages:${convIds.join(',')}:${JSON.stringify(p)}`, () => loadThreadMessages(convIds, p));
}

async function loadThreadMessages(convIds: number[], p: MessagePage) {
  const limit = Math.min(p.limit ?? 60, 200);
  const page = (where: string, order: 'asc' | 'desc', args: unknown[], n: number) =>
    q(
      `select ${MESSAGE_COLUMNS} from message m ${MESSAGE_JOINS}
       where m.conversation_id = any($1) ${where}
       order by m.sent_at ${order}, m.id ${order} limit ${n}`,
      [convIds, ...args],
    );
  if (p.around) {
    const target = await q1<{ sent_at: string }>('select sent_at from message where id = $1 and conversation_id = any($2)', [p.around, convIds]);
    if (!target) return [];
    const half = Math.floor(limit / 2);
    const older = await page('and (m.sent_at, m.id) < ($2, $3)', 'desc', [target.sent_at, p.around], half);
    const newer = await page('and (m.sent_at, m.id) >= ($2, $3)', 'asc', [target.sent_at, p.around], limit - half);
    return [...older.reverse(), ...newer];
  }
  if (p.after) return page('and m.sent_at > $2', 'asc', [p.after], limit);
  const rows = await page('and ($2::timestamptz is null or m.sent_at < $2)', 'desc', [p.before ?? null], limit);
  return rows.reverse();
}

/** The pinned messages of a thread (all its conversations), newest pin first. Unsent messages drop out. */
export function threadPins(convIds: number[]) {
  return q(
    `select m.id, m.conversation_id, m.pinned_at, m.sent_at, m.from_me, left(m.body, 200) as body,
            coalesce(spn.name, spa.address, sh.address) as sender_name,
            exists(select 1 from attachment a where a.message_id = m.id) as has_attachment
     from message m
     left join handle sh on sh.id = m.sender_handle_id
     left join person_name spn on spn.person_id = sh.person_id
     left join person_address spa on spa.person_id = sh.person_id
     where m.conversation_id = any($1) and m.pinned_at is not null and not m.unsent
     order by m.pinned_at desc, m.id desc`,
    [convIds],
  );
}

// ---------- search ----------

const HIT_START = '⟦';
const HIT_END = '⟧';

/**
 * Turns what someone typed into a tsquery: every word must appear (prefix match, so "pizz" finds "pizza"),
 * "quoted words" must appear together, and -word excludes a word.
 */
export function toTsQuery(text: string): string | null {
  const parts: string[] = [];
  const clean = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 60);
  // Bounded so one request can't build an enormous query.
  for (const m of text.slice(0, 300).matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
    if (parts.length >= 16) break;
    if (m[2] !== undefined) {
      const words = m[2].split(/\s+/).map(clean).filter(Boolean);
      if (words.length) parts.push(`${m[1] ? '!' : ''}(${words.join(' <-> ')})`);
    } else {
      const w = clean(m[4]);
      if (w) parts.push(m[3] ? `!${w}` : `${w}:*`);
    }
  }
  // A query made only of exclusions would match nearly everything.
  if (!parts.some((p) => !p.startsWith('!'))) return null;
  return parts.join(' & ');
}

export interface SearchFilter {
  text: string;
  tid?: string;
  service?: 'imessage' | 'sms' | 'rcs' | 'whatsapp' | 'apple';
  fromMe?: boolean;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
}

/** Full-text search over message bodies, newest first, with a highlighted snippet (hits wrapped in ⟦ ⟧). */
export function searchMessages(f: SearchFilter) {
  return cached(`search:${JSON.stringify(f)}`, () => loadSearch(f));
}

async function loadSearch(f: SearchFilter) {
  const tsq = toTsQuery(f.text);
  if (!tsq) return [];
  let convIds: number[] | null = null;
  if (f.tid) {
    convIds = (await threadConversations(f.tid)).map((c) => c.id);
    if (!convIds.length) return [];
  }
  const services = f.service === 'apple' ? ['imessage', 'sms', 'rcs'] : f.service ? [f.service] : null;
  return q(
    `select ${MESSAGE_COLUMNS}, ct.tid,
            coalesce(c.title, tpn.name, tpa.address) as thread_title, c.is_group,
            ts_headline('simple', m.body, query,
              'StartSel=${HIT_START}, StopSel=${HIT_END}, MaxWords=24, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "') as snippet
     from message m ${MESSAGE_JOINS}
     join conversation c on c.id = m.conversation_id
     join conversation_thread ct on ct.conversation_id = c.id
     left join person_name tpn on ct.tid like 'p%' and tpn.person_id = substr(ct.tid, 2)::bigint
     left join person_address tpa on ct.tid like 'p%' and tpa.person_id = substr(ct.tid, 2)::bigint,
     to_tsquery('simple', $1) query
     where m.tsv @@ query and not m.unsent
       and ($2::bigint[] is null or m.conversation_id = any($2))
       and ($3::text[] is null or m.service = any($3))
       and ($4::boolean is null or m.from_me = $4)
       and ($5::timestamptz is null or m.sent_at >= $5)
       and ($6::timestamptz is null or m.sent_at < $6)
     order by m.sent_at desc
     limit $7 offset $8`,
    [tsq, convIds, services, f.fromMe ?? null, f.after ?? null, f.before ?? null, Math.min(f.limit ?? 50, 200), f.offset ?? 0],
  );
}
