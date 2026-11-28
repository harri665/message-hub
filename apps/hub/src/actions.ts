// Actions from the web app beyond plain sending: reactions, typing indicators, starting conversations and voice messages.
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { q, q1 } from './db.js';
import { TAPBACK_EMOJI, type BlueBubbles } from './sources/bluebubbles.js';
import type { WhatsApp } from './sources/whatsapp.js';
import { normalizeAddress } from './store.js';
import type { ConvRow } from './queries.js';

const run = promisify(execFile);
const userError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
/** Errors from BlueBubbles or the connector are shown to the user as they are. */
const passThrough = (e: any) => Object.assign(new Error(e?.statusCode ? e.message : String(e?.message ?? e)), { statusCode: e?.statusCode ?? 502 });

/** Reactions offered in the app. iMessage can only send its six tapbacks; WhatsApp takes any emoji. */
export const REACTIONS = {
  apple: TAPBACK_EMOJI,
  whatsapp: ['👍', '❤️', '😂', '😮', '😢', '🙏'],
};

// ---------- reactions ----------

/** Sets my reaction on a message, or removes it when emoji is null. */
export async function react(bb: BlueBubbles, wa: WhatsApp, messageId: number, emoji: string | null) {
  const m = await q1<{ source_id: string; from_me: boolean; kind: string; unsent: boolean; network: 'apple' | 'whatsapp'; chat: string; sender: string | null; mine: string | null }>(
    `select m.source_id, m.from_me, m.kind, m.unsent, c.network, c.source_id as chat, h.address as sender,
            (select r.emoji from reaction r where r.message_id = m.id and r.sender_key = 'me') as mine
     from message m join conversation c on c.id = m.conversation_id left join handle h on h.id = m.sender_handle_id
     where m.id = $1`,
    [messageId],
  );
  if (!m) throw userError(404, 'Message not found.');
  if (m.kind !== 'text' || m.unsent) throw userError(400, "This message can't be reacted to.");
  if (emoji && emoji.length > 16) throw userError(400, 'Pick one emoji.');
  try {
    if (m.network === 'apple') {
      if (emoji) await bb.react(m.chat, m.source_id, emoji);
      else if (m.mine) await bb.react(m.chat, m.source_id, m.mine, true);
    } else {
      await wa.react(m.chat, { sourceId: m.source_id, senderAddress: m.from_me ? null : m.sender }, emoji);
    }
  } catch (e) {
    throw passThrough(e);
  }
}

// ---------- typing ----------

const typingState = new Map<number, { on: boolean; at: number; stop?: NodeJS.Timeout }>();

/**
 * Shows or clears my typing indicator. The web app repeats "typing" every few seconds while keys are pressed; repeats
 * inside that window are dropped, and the indicator clears by itself if the repeats stop (closed tab, lost connection).
 */
export async function setTyping(bb: BlueBubbles, wa: WhatsApp, conv: ConvRow, typing: boolean, audio = false) {
  const prev = typingState.get(conv.id);
  if (prev?.stop) clearTimeout(prev.stop);
  const now = Date.now();
  const repeat = !!prev && prev.on === typing && now - prev.at < 4000;
  const state = { on: typing, at: repeat ? prev!.at : now, stop: undefined as NodeJS.Timeout | undefined };
  if (typing) {
    state.stop = setTimeout(() => setTyping(bb, wa, conv, false).catch(() => {}), 10_000);
    state.stop.unref();
  }
  typingState.set(conv.id, state);
  if (repeat || (!typing && !prev?.on)) return;
  if (conv.network === 'apple') {
    // Typing indicators only exist in iMessage, not SMS or RCS.
    if (!conv.source_id.toLowerCase().startsWith('sms;') && !conv.source_id.toLowerCase().startsWith('rcs;')) {
      await bb.setTyping(conv.source_id, typing);
    }
  } else {
    await wa.setTyping(conv.source_id, typing, audio);
  }
}

// ---------- WhatsApp presence follows whether the web app is in use ----------

const activeSockets = new Map<object, { at: number; tid: string | null }>();
let presenceOn = false;
let presenceChat: string | null = null;

/** Called by the live socket: active means the app is visible and focused, tid is the open conversation. */
export async function reportActivity(wa: WhatsApp, socket: object, active: boolean, tid: string | null) {
  if (active) activeSockets.set(socket, { at: Date.now(), tid });
  else activeSockets.delete(socket);
  await updatePresence(wa);
}

export async function updatePresence(wa: WhatsApp) {
  // Activity reports repeat every 30 seconds; a socket that stops reporting stops counting after 90.
  for (const [s, v] of activeSockets) if (Date.now() - v.at > 90_000) activeSockets.delete(s);
  const latest = [...activeSockets.values()].sort((a, b) => b.at - a.at)[0];
  const on = !!latest;
  let chat: string | null = null;
  if (latest?.tid) {
    const c = await q1<{ source_id: string }>(
      `select c.source_id from conversation_thread ct join conversation c on c.id = ct.conversation_id
       where ct.tid = $1 and c.network = 'whatsapp' and not c.is_group order by c.last_message_at desc nulls last limit 1`,
      [latest.tid],
    ).catch(() => undefined);
    chat = c?.source_id ?? null;
  }
  if (on === presenceOn && chat === presenceChat) return;
  presenceOn = on;
  presenceChat = chat;
  await wa.setPresence(on, chat).catch(() => {
    presenceOn = !on;
  });
}

export function forgetSocket(wa: WhatsApp, socket: object) {
  activeSockets.delete(socket);
  updatePresence(wa).catch(() => {});
}

// ---------- contacts and new conversations ----------

export interface ContactMatch {
  personId: number;
  name: string;
  tid: string | null;
  addresses: { network: 'apple' | 'whatsapp'; address: string }[];
}

/** People to start a conversation with: name, number or email contains the text. Most recently messaged first. */
export async function findContacts(text: string, limit = 12): Promise<ContactMatch[]> {
  const t = text.trim();
  if (!t) return [];
  const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const digits = t.replace(/\D/g, '');
  const rows = await q<{ person_id: number; name: string; has_thread: boolean; addresses: ContactMatch['addresses'] }>(
    `with hits as (
       select distinct h.person_id from handle h left join person_name pn on pn.person_id = h.person_id
       where h.person_id is not null and h.address not like 'lid:%'
         and (pn.name ilike $1 or h.display_name ilike $1 or h.address ilike $1
              or ($2 <> '' and length($2) >= 3 and regexp_replace(coalesce(h.normalized, h.address), '\\D', '', 'g') like '%' || $2 || '%'))
     )
     select hits.person_id, coalesce(pn.name, pa.address) as name,
            exists(select 1 from conversation_thread ct where ct.tid = 'p' || hits.person_id) as has_thread,
            (select json_agg(distinct jsonb_build_object('network', h.network, 'address', coalesce(h.normalized, h.address)))
             from handle h where h.person_id = hits.person_id and h.address not like 'lid:%') as addresses,
            (select max(c.last_message_at) from handle h join conversation_member cm on cm.handle_id = h.id
             join conversation c on c.id = cm.conversation_id where h.person_id = hits.person_id and not c.is_group) as last_at
     from hits left join person_name pn on pn.person_id = hits.person_id left join person_address pa on pa.person_id = hits.person_id
     order by last_at desc nulls last, name
     limit $3`,
    [like, digits, limit],
  );
  return rows.map((r) => ({ personId: r.person_id, name: r.name, tid: r.has_thread ? `p${r.person_id}` : null, addresses: r.addresses ?? [] }));
}

/** Turns what was typed into an address: +E.164 phone number or lowercased email. */
export function cleanAddress(raw: string): string | null {
  const a = raw.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) return a.toLowerCase();
  if (!/^[+(\d][\d\s().-]{2,}$/.test(a)) return null;
  const n = normalizeAddress(a);
  return n && /^\+\d{7,15}$/.test(n) ? n : null;
}

/** Which services can reach an address. null means unknown (can't be checked right now). */
export async function checkAddress(bb: BlueBubbles, wa: WhatsApp, raw: string) {
  const address = cleanAddress(raw);
  if (!address) throw userError(400, 'Enter a phone number with area code, or an email address.');
  const isPhone = address.startsWith('+');
  const [imessage, whatsapp] = await Promise.all([
    bb.status.configured ? bb.canIMessage(address) : Promise.resolve(false),
    isPhone && wa.configured ? wa.check(address).then((r) => r.on).catch(() => null) : Promise.resolve(isPhone ? null : false),
  ]);
  return { address, imessage, sms: isPhone && bb.status.configured, whatsapp };
}

export type ComposeService = 'imessage' | 'sms' | 'whatsapp';

/** Sends the first message of a conversation, creating it if needed. Returns the thread to open. */
export async function startConversation(bb: BlueBubbles, wa: WhatsApp, rawAddresses: string[], service: ComposeService, text: string): Promise<string> {
  const body = text.trim();
  if (!body) throw userError(400, 'Write a message to start the conversation.');
  if (body.length > 4000) throw userError(400, 'That message is too long.');
  if (!rawAddresses.length) throw userError(400, 'Add who the message is for.');
  if (rawAddresses.length > 20) throw userError(400, 'That is too many people for one conversation.');
  const addresses = rawAddresses.map((a) => {
    const clean = cleanAddress(a);
    if (!clean) throw userError(400, `"${a}" isn't a phone number or email address.`);
    return clean;
  });
  const unique = [...new Set(addresses)];
  let network: 'apple' | 'whatsapp';
  let chatId: string;
  try {
    if (service === 'whatsapp') {
      if (unique.length > 1) throw userError(400, 'New WhatsApp group chats have to be made on the phone. Pick one person.');
      if (!unique[0].startsWith('+')) throw userError(400, 'WhatsApp needs a phone number.');
      const check = await wa.check(unique[0]);
      if (!check.on || !check.chat) throw userError(400, `${unique[0]} isn't on WhatsApp.`);
      network = 'whatsapp';
      chatId = check.chat;
      await wa.sendText(chatId, body);
    } else {
      if (service === 'sms' && unique.some((a) => !a.startsWith('+'))) throw userError(400, 'Text messages (SMS) need phone numbers.');
      if (service === 'sms' && unique.length > 1) throw userError(400, 'Group texts have to start as iMessage.');
      if (!bb.status.configured) throw userError(409, 'iMessage is not connected.');
      network = 'apple';
      chatId = await bb.createChat(unique, body, service === 'sms' ? 'SMS' : 'iMessage');
    }
  } catch (e) {
    throw passThrough(e);
  }
  const row = await q1<{ tid: string }>(
    `select ct.tid from conversation c join conversation_thread ct on ct.conversation_id = c.id where c.network = $1 and c.source_id = $2`,
    [network, chatId],
  );
  if (!row) throw userError(502, 'The message was sent, but the conversation has not shown up yet. It will appear in the list shortly.');
  return row.tid;
}

// ---------- voice messages ----------

/**
 * Converts a voice message recorded in the browser (WebM or Ogg Opus, or MP4 AAC) to what each service plays as a voice
 * note: MP3 for iMessage (BlueBubbles turns it into a voice memo CAF) and Ogg Opus for WhatsApp.
 */
export async function convertVoice(input: Buffer, target: 'apple' | 'whatsapp'): Promise<{ buffer: Buffer; filename: string; mime: string; seconds: number }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mh-voice-'));
  try {
    const src = path.join(dir, 'in');
    const out = path.join(dir, target === 'apple' ? 'Audio Message.mp3' : 'voice.ogg');
    await fsp.writeFile(src, input);
    const codec = target === 'apple'
      ? ['-c:a', 'libmp3lame', '-b:a', '64k', '-ar', '44100']
      : ['-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-application', 'voip'];
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-ac', '1', ...codec, '-t', '900', out], { timeout: 60_000 });
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out], { timeout: 15_000 });
    return {
      buffer: await fsp.readFile(out),
      filename: path.basename(out),
      mime: target === 'apple' ? 'audio/mpeg' : 'audio/ogg',
      seconds: Math.max(1, Number.parseFloat(probe.stdout) || 1),
    };
  } catch (e: any) {
    throw userError(500, `Couldn't prepare the voice message: ${e?.code === 'ENOENT' ? 'ffmpeg is not installed' : e?.stderr?.toString().trim() || e?.message || e}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
