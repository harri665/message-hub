// Profile photos for people and groups: stored once (a 256px WebP in Postgres) and served resized.
//
// Which photo a thread shows:
//  - a group shows its own icon (iMessage group photo, or the WhatsApp group photo);
//  - a person shows the photo from their Mac/iPhone contact when they have one, and otherwise their WhatsApp
//    profile photo. When the person has several (two iMessage addresses, say) the most recently changed one wins.
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { q, q1 } from './db.js';
import { emitLive } from './store.js';

export const AVATAR_SIZES = new Set([64, 128, 256]);
const STORED = 256;
/** How long an answer is trusted before the source is asked again. Change events from WhatsApp shorten this. */
export const RECHECK_MS = 24 * 3600_000;

type Target = { handleId: number } | { conversationId: number };

/** Squares and shrinks any image we are given (never trusting the source's size or format). */
async function normalize(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { failOn: 'error', limitInputPixels: 64_000_000 })
    .rotate()
    .resize(STORED, STORED, { fit: 'cover', position: 'attention' })
    .webp({ quality: 82 })
    .toBuffer();
}

const col = (t: Target) => ('handleId' in t ? 'handle_id' : 'conversation_id');
const ref = (t: Target) => ('handleId' in t ? t.handleId : t.conversationId);

/**
 * Records the outcome of asking a source for a photo: image bytes, or null when there is none. Does nothing visible
 * when the photo is unchanged. `sourceKey` identifies the source's version of the photo, to skip re-processing.
 */
export async function saveAvatar(t: Target, bytes: Buffer | null, sourceKey: string | null): Promise<boolean> {
  let data: Buffer | null = null;
  if (bytes) {
    try {
      data = await normalize(bytes);
    } catch {
      return false; // not an image we can read; keep what we have
    }
  }
  const etag = data ? createHash('sha1').update(data).digest('hex').slice(0, 12) : null;
  const prev = await q1<{ etag: string | null }>(`select etag from avatar where ${col(t)} = $1`, [ref(t)]);
  await q(
    `insert into avatar (${col(t)}, source_key, etag, data) values ($1, $2, $3, $4)
     on conflict (${col(t)}) do update set source_key = excluded.source_key, etag = excluded.etag, data = excluded.data,
       checked_at = now(), updated_at = case when avatar.etag is distinct from excluded.etag then now() else avatar.updated_at end`,
    [ref(t), sourceKey, etag, data],
  );
  const changed = (prev?.etag ?? null) !== etag;
  if (changed) await announce(t);
  return changed;
}

/** The source still has the same photo. */
export async function touchAvatar(t: Target) {
  await q(`update avatar set checked_at = now() where ${col(t)} = $1`, [ref(t)]);
}

/** Makes the next refresh pass look at this one again. */
export async function expireAvatar(t: Target) {
  await q(`update avatar set checked_at = 'epoch' where ${col(t)} = $1`, [ref(t)]);
}

/** Tells connected apps to reload the thread list, which carries the new photo versions. */
async function announce(t: Target) {
  const convs = 'conversationId' in t
    ? [{ id: t.conversationId }]
    : await q<{ id: number }>('select conversation_id as id from conversation_member where handle_id = $1', [t.handleId]);
  for (const c of convs) emitLive({ type: 'conversation-updated', conversationId: c.id });
}

/** SQL fragment: the photo version (etag) shown for a thread. `tidExpr` is the thread id column; null when there is none. */
export const THREAD_AVATAR_SQL = (personIdExpr: string, convIdExpr: string) => `(
  select av.etag from avatar av
  left join handle h on h.id = av.handle_id
  where av.etag is not null
    and (av.conversation_id = ${convIdExpr} or (${personIdExpr} is not null and h.person_id = ${personIdExpr}))
  order by (h.network = 'apple') desc nulls last, av.updated_at desc
  limit 1)`;

/** The stored photo for a thread id ("p12" person, "c34" group), or undefined. */
export async function threadAvatar(tid: string): Promise<{ etag: string; data: Buffer } | undefined> {
  const id = Number(tid.slice(1));
  if (!Number.isSafeInteger(id) || id <= 0 || (tid[0] !== 'p' && tid[0] !== 'c')) return undefined;
  const person = tid[0] === 'p' ? id : null;
  const conv = tid[0] === 'c' ? id : null;
  return q1<{ etag: string; data: Buffer }>(
    `select av.etag, av.data from avatar av
     left join handle h on h.id = av.handle_id
     where av.etag is not null and ((av.conversation_id = $2::bigint) or ($1::bigint is not null and h.person_id = $1::bigint))
     order by (h.network = 'apple') desc nulls last, av.updated_at desc limit 1`,
    [person, conv],
  );
}

const resized = new Map<string, Promise<Buffer>>();
/** A smaller copy of a stored photo, kept in memory (they're a few KB each). */
export function resizedAvatar(etag: string, data: Buffer, width: number): Promise<Buffer> {
  if (width >= STORED) return Promise.resolve(data);
  const key = `${etag}:${width}`;
  let p = resized.get(key);
  if (!p) {
    p = sharp(data).resize(width, width).webp({ quality: 82 }).toBuffer();
    resized.set(key, p);
    p.catch(() => resized.delete(key));
    while (resized.size > 2000) resized.delete(resized.keys().next().value!);
  }
  return p;
}
