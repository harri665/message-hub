// Link previews: the compact card shown for a link in a message (title, site, picture), like iPhone Messages.
//
// Where the details come from, best first:
//  1. iMessage: the sender's Messages app already built the preview and sent it along (the message's payload data,
//     an LPLinkMetadata archive, with the picture and icon as hidden attachments). We use it as is.
//  2. WhatsApp: a message with a link carries its own preview (title, description, small thumbnail).
//  3. Anything else: the hub reads the page's OpenGraph / Twitter card tags itself (see netguard.ts for the safeguards).
//
// Everything is stored once per URL in Postgres (picture and icon already resized), so clients only ever talk to the hub
// and nothing is fetched twice. Fetching happens only when a client asks for a message it is showing.
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { q1 } from './db.js';
import { FetchRefused, guardedGet, urlProblem } from './netguard.js';

// ---------- finding the link in a message ----------

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'​]+/i;
const TRAILING = /^[.,;:!?'"’”]$/;

export interface FoundLink {
  /** Absolute http(s) URL (www. links get https://, the #fragment is dropped). */
  url: string;
  /** The message's text without the link, tidied, for the text bubble shown next to the card. */
  rest: string;
}

/** The first web link in a message's text, or null. */
export function extractLink(text: string | null | undefined): FoundLink | null {
  const m = text ? URL_RE.exec(text) : null;
  if (!m) return null;
  let raw = m[0];
  // Drop sentence punctuation, and a closing bracket unless its opening one is part of the link (Wikipedia /Foo_(bar)).
  const closers: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  while (raw) {
    const last = raw[raw.length - 1];
    if (TRAILING.test(last)) raw = raw.slice(0, -1);
    else if (closers[last] && raw.split(closers[last]).length < raw.split(last).length) raw = raw.slice(0, -1);
    else break;
  }
  let href = raw;
  if (/^www\./i.test(href)) href = `https://${href}`;
  try {
    const u = new URL(href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    const before = text!.slice(0, m.index);
    let after = text!.slice(m.index + raw.length);
    // A link on a line of its own leaves no empty line behind.
    if ((before === '' || before.endsWith('\n')) && after.startsWith('\n')) after = after.slice(1);
    const rest = (before + after)
      .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { url: u.href, rest };
  } catch {
    return null;
  }
}

export const extractUrl = (text: string | null | undefined) => extractLink(text)?.url ?? null;

// ---------- reading a page's tags ----------

export interface PageMeta {
  title: string | null;
  siteName: string | null;
  description: string | null;
  image: string | null;
  icon: string | null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', copy: '(c)' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const clean = (s: string | null | undefined, max: number) => {
  const t = decodeEntities(s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/** Pulls the preview fields out of the start of an HTML page. Plain regex scanning: no DOM, nothing is executed. */
export function parseHtml(html: string, base: URL): PageMeta {
  const head = html.slice(0, html.search(/<\/head>/i) > 0 ? html.search(/<\/head>/i) : html.length);
  const meta = new Map<string, string>();
  const icons: { href: string; score: number }[] = [];
  for (const m of head.matchAll(/<(meta|link)\b([^>]*)>/gi)) {
    const a = attrs(m[2]);
    if (m[1].toLowerCase() === 'meta') {
      const key = (a.property ?? a.name ?? '').toLowerCase();
      if (key && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
    } else if (a.href && /\bimage_src\b/i.test(a.rel ?? '')) {
      if (!meta.has('image_src')) meta.set('image_src', a.href);
    } else if (a.href && /\bicon\b/i.test(a.rel ?? '')) {
      const apple = /apple-touch/i.test(a.rel ?? '');
      const size = parseInt((a.sizes ?? '').split('x')[0], 10) || 0;
      const svgOrIco = /\.(svg|ico)(\?|$)/i.test(a.href) || /svg|icon/.test(a.type ?? '');
      icons.push({ href: a.href, score: (apple ? 1000 : 0) + Math.min(size, 256) - (svgOrIco ? 5000 : 0) });
    }
  }
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const abs = (v: string | undefined) => {
    if (!v) return null;
    try {
      const u = new URL(decodeEntities(v.trim()), base);
      return urlProblem(u) ? null : u.href;
    } catch {
      return null;
    }
  };
  const first = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v && v.trim());
  icons.sort((x, y) => y.score - x.score);
  return {
    title: clean(first('og:title', 'twitter:title') ?? t?.[1], 300),
    siteName: clean(first('og:site_name', 'application-name'), 80),
    description: clean(first('og:description', 'twitter:description', 'description'), 400),
    image: abs(first('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image_src', 'thumbnail')),
    icon: abs(icons[0]?.href),
  };
}

/** Decodes page bytes using the declared charset (header, then meta tag), falling back to UTF-8. */
export function decodeHtml(body: Buffer, contentType: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const sniff = /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1];
  for (const cs of [fromHeader, sniff, 'utf-8']) {
    if (!cs) continue;
    try {
      return new TextDecoder(cs).decode(body);
    } catch {
      /* unknown label: try the next */
    }
  }
  return body.toString('utf8');
}

// ---------- pictures ----------

const CARD_WIDTH = 640;
const MAX_ASPECT = 1.91; // the widest picture a card shows; wider ones are cropped at the sides
const MIN_ASPECT = 1; // square at most tall

const sharpOpts = { failOn: 'error' as const, limitInputPixels: 50_000_000 };

export interface Processed { data: Buffer; width: number; height: number }

/** A card picture: at most 640 px wide, cropped to between 1:1 and 1.91:1. Returns null for pictures too small to use. */
export async function processCardImage(bytes: Buffer): Promise<Processed | null> {
  const meta = await sharp(bytes, sharpOpts).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w < 200 || h < 100) return null;
  const ar = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, w / h));
  const tw = Math.min(CARD_WIDTH, w);
  const th = Math.round(tw / ar);
  const data = await sharp(bytes, sharpOpts).rotate().resize(tw, th, { fit: 'cover', position: 'attention' }).webp({ quality: 80 }).toBuffer();
  return { data, width: tw, height: th };
}

/** A site icon: 96 px square. */
export async function processIcon(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, sharpOpts).rotate().resize(96, 96, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
}

async function download(url: string, maxBytes: number): Promise<Buffer | null> {
  try {
    const get = (plainAgent: boolean) =>
      guardedGet(new URL(url), { maxBytes, accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', timeoutMs: 10_000, plainAgent });
    let res = await get(false);
    if ([401, 403, 429, 503].includes(res.status)) res = await get(true);
    if (res.status !== 200 || res.truncated || !/^image\//i.test(res.contentType) || /svg/i.test(res.contentType)) return null;
    return res.body;
  } catch {
    return null;
  }
}

// ---------- storage ----------

export type Source = 'imessage' | 'whatsapp' | 'web';

export interface PreviewRow {
  id: number;
  url: string;
  host: string;
  title: string | null;
  site_name: string | null;
  description: string | null;
  image_w: number | null;
  image_h: number | null;
  has_image: boolean;
  has_icon: boolean;
  etag: string | null;
  source: Source;
  state: 'ok' | 'none' | 'error';
}

const ROW_COLUMNS = `id, url, host, title, site_name, description, image_w, image_h, (image_data is not null) as has_image,
                     (icon_data is not null) as has_icon, etag, source, state`;

const TTL_OK_MS = 7 * 24 * 3600_000;
const TTL_NONE_MS = 24 * 3600_000;
const TTL_ERROR_MS = 2 * 3600_000;

interface Details {
  title: string | null;
  siteName: string | null;
  description: string | null;
  image: Processed | null;
  icon: Buffer | null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

async function save(url: string, source: Source, d: Details, error: string | null = null): Promise<PreviewRow> {
  const useful = !!(d.title || d.image);
  const state = error ? 'error' : useful ? 'ok' : 'none';
  const ttl = state === 'ok' ? TTL_OK_MS : state === 'none' ? TTL_NONE_MS : TTL_ERROR_MS;
  const etag = createHash('sha1').update(d.image?.data ?? '').update(d.icon ?? '').update(d.title ?? '').digest('hex').slice(0, 12);
  // Details that came from the sender's own phone are never replaced by what we scrape, and don't expire.
  const keepsOwner = source === 'web';
  const row = await q1<PreviewRow>(
    `insert into link_preview (url, host, title, site_name, description, image_data, image_w, image_h, icon_data, etag,
                               source, state, error, fetched_at, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), case when $11 = 'web' then now() + ($14 || ' milliseconds')::interval end)
     on conflict (url) do update set
       host = excluded.host, title = excluded.title, site_name = excluded.site_name, description = excluded.description,
       image_data = excluded.image_data, image_w = excluded.image_w, image_h = excluded.image_h, icon_data = excluded.icon_data,
       etag = excluded.etag, source = excluded.source, state = excluded.state, error = excluded.error,
       fetched_at = now(), expires_at = excluded.expires_at
     where not ($15 and link_preview.source <> 'web' and link_preview.state = 'ok')
     returning ${ROW_COLUMNS}`,
    [url, hostOf(url), d.title, d.siteName, d.description, d.image?.data ?? null, d.image?.width ?? null, d.image?.height ?? null,
     d.icon, etag, source, state, error, String(ttl), keepsOwner],
  );
  return row ?? (await getRow(url))!;
}

export async function getRow(url: string): Promise<PreviewRow | undefined> {
  return q1<PreviewRow>(`select ${ROW_COLUMNS} from link_preview where url = $1`, [url]);
}

export async function getRowById(id: number): Promise<PreviewRow | undefined> {
  return q1<PreviewRow>(`select ${ROW_COLUMNS} from link_preview where id = $1`, [id]);
}

export async function getImage(id: number, which: 'image' | 'icon'): Promise<Buffer | null> {
  const row = await q1<{ d: Buffer | null }>(`select ${which}_data as d from link_preview where id = $1`, [id]);
  return row?.d ?? null;
}

/** A row that is still good: from a phone (never expires), or a web fetch that hasn't expired. */
async function fresh(url: string): Promise<PreviewRow | undefined> {
  return q1<PreviewRow>(
    `select ${ROW_COLUMNS} from link_preview where url = $1 and (expires_at is null or expires_at > now())`,
    [url],
  );
}

// ---------- details handed to us by the messaging services ----------

export interface ProvidedPreview {
  title?: string | null;
  siteName?: string | null;
  description?: string | null;
  image?: Buffer | null;
  icon?: Buffer | null;
}

/** Stores the preview a messaging service sent along with a link (iMessage payload, WhatsApp link preview). */
export async function saveProvided(url: string, source: 'imessage' | 'whatsapp', p: ProvidedPreview): Promise<PreviewRow | null> {
  const title = clean(p.title, 300);
  let image: Processed | null = null;
  let icon: Buffer | null = null;
  if (p.image) image = await processCardImage(p.image).catch(() => null);
  if (p.icon) icon = await processIcon(p.icon).catch(() => null);
  // A tiny "picture" (WhatsApp thumbnails are ~100 px) is better as the icon than nothing.
  if (!image && p.image && !icon) icon = await processIcon(p.image).catch(() => null);
  if (!title && !image) return null;
  return save(url, source, { title, siteName: clean(p.siteName, 80), description: clean(p.description, 400), image, icon });
}

/**
 * Reads the Messages link preview out of a message's payload data. BlueBubbles parses the NSKeyedArchiver plist into
 * JSON: an `$objects` table whose entries refer to each other by {UID: n}.
 */
export function readLinkPayload(payload: unknown): { url: string | null; title: string | null; siteName: string | null; summary: string | null;
  imageIndex: number | null; iconIndex: number | null } | null {
  const arc: any = Array.isArray(payload) ? payload[0] : payload;
  const objects: any[] | undefined = arc?.$objects;
  if (!Array.isArray(objects)) return null;
  const rootUid = arc?.$top?.root?.UID;
  const get = (v: any, depth = 0): any => {
    if (depth > 14 || v == null) return null;
    if (typeof v === 'object' && !Array.isArray(v) && typeof v.UID === 'number') return get(objects[v.UID], depth + 1);
    if (typeof v === 'string') return v === '$null' ? null : v;
    if (typeof v === 'object' && !Array.isArray(v)) {
      // An NSURL: a relative string, with an optional base.
      if ('NS.relative' in v) return get(v['NS.relative'], depth + 1);
      return Object.fromEntries(Object.entries(v).filter(([k]) => k !== '$class').map(([k, x]) => [k, get(x, depth + 1)]));
    }
    return v;
  };
  const root = get({ UID: rootUid });
  const lp = root?.richLinkMetadata;
  if (!lp || typeof lp !== 'object') return null;
  const idx = (o: any) => (o && Number.isInteger(o.richLinkImageAttachmentSubstituteIndex) ? (o.richLinkImageAttachmentSubstituteIndex as number) : null);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    url: str(lp.URL) ?? str(lp.originalURL),
    title: str(lp.title),
    siteName: str(lp.siteName),
    summary: str(lp.summary),
    imageIndex: idx(lp.image),
    iconIndex: idx(lp.icon),
  };
}

// ---------- fetching a page ----------

const inflight = new Map<string, Promise<PreviewRow>>();

/** Reads the page and stores the result (also stores "nothing found" and failures, so they aren't retried at once). */
function fetchPage(url: string): Promise<PreviewRow> {
  let p = inflight.get(url);
  if (!p) {
    p = scrape(url).finally(() => inflight.delete(url));
    inflight.set(url, p);
  }
  return p;
}

async function scrape(url: string): Promise<PreviewRow> {
  const empty: Details = { title: null, siteName: null, description: null, image: null, icon: null };
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return save(url, 'web', empty, 'bad address');
  }
  try {
    const get = (plainAgent: boolean) =>
      guardedGet(target, {
        // Some sites (YouTube) put a megabyte of script before their tags, so the cap is generous; reading stops at </head>.
        maxBytes: 2_000_000,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        timeoutMs: 12_000,
        plainAgent,
        enough: (latest) => /<\/head>/i.test(latest.toString('latin1')),
      });
    let res = await get(false);
    // Some sites turn away scripts posing as browsers but serve their tags to a plain link-preview agent.
    if ([401, 403, 429, 503].includes(res.status)) res = await get(true);
    if (res.status >= 400) return save(url, 'web', empty, `status ${res.status}`);
    if (/^image\//i.test(res.contentType)) {
      // A link straight to a picture: show it.
      const image = await processCardImage(res.body).catch(() => null);
      return save(url, 'web', { ...empty, title: decodeURIComponent(res.url.pathname.split('/').pop() || '') || null, image });
    }
    if (!/html|xml/i.test(res.contentType) && res.contentType) return save(url, 'web', empty);
    const meta = parseHtml(decodeHtml(res.body, res.contentType), res.url);
    const [imgBytes, iconBytes] = await Promise.all([
      meta.image ? download(meta.image, 8_000_000) : null,
      meta.icon ? download(meta.icon, 1_000_000) : null,
    ]);
    const image = imgBytes ? await processCardImage(imgBytes).catch(() => null) : null;
    let icon = iconBytes ? await processIcon(iconBytes).catch(() => null) : null;
    if (!icon && imgBytes && !image) icon = await processIcon(imgBytes).catch(() => null);
    return save(url, 'web', { title: meta.title, siteName: meta.siteName, description: meta.description, image, icon });
  } catch (e) {
    const why = e instanceof FetchRefused ? e.message : (e as any)?.code === 'EBLOCKED' ? 'address is not public' : 'could not be reached';
    return save(url, 'web', empty, why);
  }
}

/**
 * The preview for a link: what we already know, else (when `provider` knows something, like a phone's own preview) that,
 * else a fresh read of the page. Always answers; "no metadata" is a valid answer.
 */
export async function resolvePreview(url: string, provider?: () => Promise<ProvidedPreview & { source: 'imessage' | 'whatsapp' } | null>): Promise<PreviewRow> {
  const have = await fresh(url);
  if (have) return have;
  if (provider) {
    const given = await provider().catch(() => null);
    if (given) {
      const saved = await saveProvided(url, given.source, given).catch(() => null);
      if (saved) return saved;
    }
  }
  return fetchPage(url);
}

/** Forgets scraped previews that expired a month ago (they are re-read when a message shows them again). */
export async function pruneLinkPreviews() {
  await q1(`with gone as (delete from link_preview where expires_at < now() - interval '30 days' returning 1) select count(*) from gone`);
}
