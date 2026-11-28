import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { q, q1 } from './db.js';

export type Network = 'apple' | 'whatsapp';
export type Service = 'imessage' | 'sms' | 'rcs' | 'whatsapp';
export type NameSource = 'contacts' | 'push' | 'group';

export interface HandleInput {
  address: string;
  displayName?: string | null;
  nameSource?: NameSource | null;
}

export interface AttachmentInput {
  sourceId: string;
  mime?: string | null;
  filename?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  storagePath?: string | null;
}

export interface MessageInput {
  network: Network;
  service: Service;
  conversation: { sourceId: string; title?: string | null; isGroup: boolean; members?: HandleInput[] };
  sourceId: string;
  sender: HandleInput | null; // null when from me
  fromMe: boolean;
  kind?: 'text' | 'system';
  body: string | null;
  sentAt: Date;
  deliveredAt?: Date | null;
  readAt?: Date | null;
  editedAt?: Date | null;
  unsent?: boolean;
  replyToSourceId?: string | null;
  attachments?: AttachmentInput[];
  status?: 'sending' | 'sent' | 'failed';
  /** True during history import: do not bump unread counts or notify. */
  historical?: boolean;
}

/** Live events pushed to connected browsers. */
export type LiveEvent =
  | { type: 'message'; conversationId: number; messageId: number; fromMe: boolean; historical: boolean }
  | { type: 'message-updated'; conversationId: number; messageId: number }
  | { type: 'conversation-updated'; conversationId: number }
  | { type: 'status'; source: 'bluebubbles' | 'whatsapp' }
  | { type: 'send-request' }
  /** Scheduled messages in a thread changed (created, edited, sent, failed or cancelled). */
  | { type: 'scheduled'; tid: string }
  /** Someone started or stopped typing. sender is a handle address in group chats, null in one-to-one chats. */
  | { type: 'typing'; conversationId: number; typing: boolean; sender: { network: Network; address: string } | null; audio?: boolean };

export const bus = new EventEmitter();
bus.setMaxListeners(100);
export function emitLive(ev: LiveEvent) {
  bus.emit('live', ev);
}

// ---------- addresses ----------

export function normalizeAddress(address: string): string | null {
  const a = address.trim();
  if (!a) return null;
  if (a.includes('@')) return a.toLowerCase();
  if (a.startsWith('lid:')) return null;
  const digits = a.replace(/\D/g, '');
  if (!digits) return a.toLowerCase();
  if (a.startsWith('+')) return '+' + digits;
  const cc = config.defaultCountryCode;
  if (cc === '1') {
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  }
  if (digits.length >= 11) return '+' + digits;
  return digits; // short codes and local numbers
}

// ---------- handles and people ----------

const handleCache = new Map<string, { id: number; personId: number | null; name: string | null; source: string | null }>();

const SOURCE_RANK: Record<string, number> = { contacts: 3, push: 2, group: 1 };

export async function upsertHandle(network: Network, h: HandleInput): Promise<number> {
  const key = `${network}|${h.address}`;
  const cached = handleCache.get(key);
  if (cached) {
    // Skip the write unless this brings a new name that outranks (or equals) what we have.
    const incomingRank = SOURCE_RANK[h.nameSource ?? ''] ?? 0;
    const cachedRank = SOURCE_RANK[cached.source ?? ''] ?? 0;
    if (!h.displayName || h.displayName === cached.name || incomingRank < cachedRank) return cached.id;
  }
  const normalized = normalizeAddress(h.address);
  const row = await q1<{ id: number; person_id: number | null; display_name: string | null; name_source: string | null }>(
    `insert into handle (network, address, normalized, display_name, name_source)
     values ($1, $2, $3, $4, $5)
     on conflict (network, address) do update set
       display_name = case
         when excluded.display_name is null then handle.display_name
         when coalesce(handle.name_source, '') = 'contacts' and excluded.name_source <> 'contacts' then handle.display_name
         when coalesce(handle.name_source, '') = 'push' and excluded.name_source = 'group' then handle.display_name
         else excluded.display_name end,
       name_source = case
         when excluded.display_name is null then handle.name_source
         when coalesce(handle.name_source, '') = 'contacts' and excluded.name_source <> 'contacts' then handle.name_source
         when coalesce(handle.name_source, '') = 'push' and excluded.name_source = 'group' then handle.name_source
         else excluded.name_source end
     returning id, person_id, display_name, name_source`,
    [network, h.address, normalized, h.displayName ?? null, h.displayName ? h.nameSource ?? null : null],
  );
  let personId = row!.person_id;
  if (!personId) {
    if (normalized) {
      const other = await q1<{ person_id: number }>(
        'select person_id from handle where normalized = $1 and person_id is not null limit 1',
        [normalized],
      );
      personId = other?.person_id ?? null;
    }
    if (!personId) personId = (await q1<{ id: number }>('insert into person default values returning id'))!.id;
    await q('update handle set person_id = $1 where id = $2', [personId, row!.id]);
  }
  handleCache.set(key, { id: row!.id, personId, name: row!.display_name, source: row!.name_source });
  return row!.id;
}

// ---------- conversations ----------

const convCache = new Map<string, number>();

export async function upsertConversation(
  network: Network,
  c: { sourceId: string; title?: string | null; isGroup: boolean },
): Promise<number> {
  const key = `${network}|${c.sourceId}`;
  if (c.title === undefined && convCache.has(key)) return convCache.get(key)!;
  const row = await q1<{ id: number }>(
    `insert into conversation (network, source_id, title, is_group) values ($1, $2, $3, $4)
     on conflict (network, source_id) do update set
       title = coalesce(excluded.title, conversation.title),
       is_group = conversation.is_group or excluded.is_group
     returning id`,
    [network, c.sourceId, c.title ?? null, c.isGroup],
  );
  convCache.set(key, row!.id);
  return row!.id;
}

const memberCache = new Set<string>();

export async function addMember(conversationId: number, handleId: number) {
  const key = `${conversationId}|${handleId}`;
  if (memberCache.has(key)) return;
  await q('insert into conversation_member (conversation_id, handle_id) values ($1, $2) on conflict do nothing', [conversationId, handleId]);
  memberCache.add(key);
}

// ---------- messages ----------

export async function ingestMessage(m: MessageInput): Promise<{ id: number; conversationId: number; inserted: boolean }> {
  const conversationId = await upsertConversation(m.network, m.conversation);
  for (const member of m.conversation.members ?? []) {
    await addMember(conversationId, await upsertHandle(m.network, member));
  }
  const senderHandleId = m.sender ? await upsertHandle(m.network, m.sender) : null;
  if (senderHandleId && !m.conversation.isGroup) await addMember(conversationId, senderHandleId);

  const row = await q1<{ id: number; inserted: boolean }>(
    `insert into message (conversation_id, service, source_id, sender_handle_id, from_me, kind, body, sent_at,
                          delivered_at, read_at, edited_at, unsent, reply_to_source_id, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (service, source_id) do update set
       body = case when excluded.unsent then null else coalesce(excluded.body, message.body) end,
       delivered_at = coalesce(excluded.delivered_at, message.delivered_at),
       read_at = coalesce(excluded.read_at, message.read_at),
       edited_at = coalesce(excluded.edited_at, message.edited_at),
       unsent = message.unsent or excluded.unsent,
       status = excluded.status
     returning id, (xmax = 0) as inserted`,
    [
      conversationId, m.service, m.sourceId, senderHandleId, m.fromMe, m.kind ?? 'text', m.body, m.sentAt,
      m.deliveredAt ?? null, m.readAt ?? null, m.editedAt ?? null, m.unsent ?? false, m.replyToSourceId ?? null,
      m.status ?? 'sent',
    ],
  );
  const id = row!.id;
  for (const a of m.attachments ?? []) {
    await q(
      `insert into attachment (message_id, source_id, mime, filename, size, width, height, storage_path)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (message_id, source_id) do update set
         mime = coalesce(excluded.mime, attachment.mime),
         filename = coalesce(excluded.filename, attachment.filename),
         size = coalesce(excluded.size, attachment.size),
         width = coalesce(excluded.width, attachment.width),
         height = coalesce(excluded.height, attachment.height),
         storage_path = coalesce(excluded.storage_path, attachment.storage_path)`,
      [id, a.sourceId, a.mime ?? null, a.filename ?? null, a.size ?? null, a.width ?? null, a.height ?? null, a.storagePath ?? null],
    );
  }

  const bumpUnread = row!.inserted && !m.fromMe && !m.historical && m.kind !== 'system' && !m.readAt;
  await q(
    `update conversation set
       last_message_at = greatest(coalesce(last_message_at, $2), $2),
       unread_count = unread_count + $3
     where id = $1`,
    [conversationId, m.sentAt, bumpUnread ? 1 : 0],
  );

  if (row!.inserted) {
    emitLive({ type: 'message', conversationId, messageId: id, fromMe: m.fromMe, historical: !!m.historical });
  } else {
    emitLive({ type: 'message-updated', conversationId, messageId: id });
  }
  return { id, conversationId, inserted: row!.inserted };
}

async function findMessage(network: Network, sourceId: string) {
  return q1<{ id: number; conversation_id: number }>(
    `select m.id, m.conversation_id from message m join conversation c on c.id = m.conversation_id
     where c.network = $1 and m.source_id = $2 limit 1`,
    [network, sourceId],
  );
}

/** Set or clear (emoji = null) one sender's reaction on a message. */
export async function setReaction(network: Network, targetSourceId: string, sender: HandleInput | null, emoji: string | null): Promise<boolean> {
  const target = await findMessage(network, targetSourceId);
  if (!target) return false;
  const handleId = sender ? await upsertHandle(network, sender) : null;
  const senderKey = handleId ? String(handleId) : 'me';
  if (emoji) {
    await q(
      `insert into reaction (message_id, sender_key, sender_handle_id, emoji) values ($1,$2,$3,$4)
       on conflict (message_id, sender_key) do update set emoji = excluded.emoji, created_at = now()`,
      [target.id, senderKey, handleId, emoji],
    );
  } else {
    await q('delete from reaction where message_id = $1 and sender_key = $2', [target.id, senderKey]);
  }
  emitLive({ type: 'message-updated', conversationId: target.conversation_id, messageId: target.id });
  return true;
}

export async function editMessage(network: Network, targetSourceId: string, body: string | null, at: Date) {
  const target = await findMessage(network, targetSourceId);
  if (!target) return;
  await q('update message set body = $2, edited_at = $3 where id = $1', [target.id, body, at]);
  emitLive({ type: 'message-updated', conversationId: target.conversation_id, messageId: target.id });
}

export async function unsendMessage(network: Network, targetSourceId: string) {
  const target = await findMessage(network, targetSourceId);
  if (!target) return;
  await q('update message set unsent = true, body = null where id = $1', [target.id]);
  emitLive({ type: 'message-updated', conversationId: target.conversation_id, messageId: target.id });
}

export async function markReceipts(network: Network, sourceIds: string[], kind: 'delivered' | 'read', at: Date) {
  if (!sourceIds.length) return;
  const col = kind === 'read' ? 'read_at' : 'delivered_at';
  const rows = await q<{ id: number; conversation_id: number }>(
    `update message m set ${col} = coalesce(m.${col}, $3)
     from conversation c
     where c.id = m.conversation_id and c.network = $1 and m.source_id = any($2)
     returning m.id, m.conversation_id`,
    [network, sourceIds, at],
  );
  for (const r of rows) emitLive({ type: 'message-updated', conversationId: r.conversation_id, messageId: r.id });
}

export async function setConversationRead(network: Network, sourceId: string) {
  const row = await q1<{ id: number }>(
    'update conversation set unread_count = 0 where network = $1 and source_id = $2 and unread_count > 0 returning id',
    [network, sourceId],
  );
  if (row) emitLive({ type: 'conversation-updated', conversationId: row.id });
}
