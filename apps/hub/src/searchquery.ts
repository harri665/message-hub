// Discord-style search syntax: "from: harri has: image pizza" becomes filters plus free text.
// Pure functions only (no database, no config) so they can be unit tested; queries.ts turns the result into SQL.

export const HAS_VALUES = ['image', 'video', 'audio', 'file', 'link', 'sticker', 'attachment'] as const;
export type HasValue = (typeof HAS_VALUES)[number];
export const SERVICE_VALUES = ['imessage', 'sms', 'rcs', 'whatsapp', 'apple'] as const;
export type ServiceValue = (typeof SERVICE_VALUES)[number];
export const IS_VALUES = ['unread', 'reply'] as const;
export type IsValue = (typeof IS_VALUES)[number];
export const OPERATORS = ['from', 'in', 'has', 'before', 'after', 'during', 'is', 'service'] as const;
export type Operator = (typeof OPERATORS)[number];

/** A time range [start, end), as ISO instants. */
export interface DateRange { start: string; end: string }

export interface ParsedSearch {
  /** What is left after the filters are taken out; searched as full text. */
  text: string;
  from: string[];
  in: string[];
  has: HasValue[];
  is: IsValue[];
  service: ServiceValue[];
  /** Only messages sent at or after this instant. */
  sentAfter?: string;
  /** Only messages sent before this instant. */
  sentBefore?: string;
  /** Filter words that weren't understood (kept in `text`), e.g. "has:banana". */
  ignored: string[];
}

const HAS_ALIASES: Record<string, HasValue> = {
  image: 'image', images: 'image', photo: 'image', photos: 'image', picture: 'image', pic: 'image',
  video: 'video', videos: 'video',
  audio: 'audio', sound: 'audio', voice: 'audio',
  file: 'file', files: 'file', document: 'file',
  link: 'link', links: 'link', url: 'link',
  sticker: 'sticker', stickers: 'sticker',
  attachment: 'attachment', attachments: 'attachment', embed: 'attachment',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// ---------- time zone helpers ----------

function tzParts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** The instant a calendar date starts in the time zone (midnight local time). */
export function startOfDay(y: number, m: number, d: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(guess, tz);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    guess += wall - shown;
  }
  return guess;
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function dayRange(y: number, m: number, d: number, tz: string): DateRange | null {
  if (m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    start: new Date(startOfDay(y, m, d, tz)).toISOString(),
    end: new Date(startOfDay(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz)).toISOString(),
  };
}

function monthRange(y: number, m: number, tz: string): DateRange | null {
  if (m < 1 || m > 12) return null;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { start: new Date(startOfDay(y, m, 1, tz)).toISOString(), end: new Date(startOfDay(ny, nm, 1, tz)).toISOString() };
}

/**
 * Understands "2026-11-25", "2026-11" (a whole month), "2026/11/25", "11/25/2026", "11/25", "nov 25", "25 nov",
 * "november 25 2026", "nov 2026", "today", "yesterday". Dates with no year mean the latest such date that isn't in the future.
 * Returns the day (or month) as a range, or null when the text isn't a date.
 */
export function parseDate(input: string, now: Date, tz: string): DateRange | null {
  const s = input.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  const today = tzParts(now.getTime(), tz);
  const noYear = (m: number, d: number): DateRange | null => {
    // Use last year when this year's date hasn't happened yet ("dec 25" asked in November).
    const here = dayRange(today.y, m, d, tz);
    if (!here) return null;
    return new Date(here.start).getTime() > now.getTime() ? dayRange(today.y - 1, m, d, tz) ?? here : here;
  };
  const dayRel = (offset: number) => {
    const t = new Date(Date.UTC(today.y, today.m - 1, today.d + offset));
    return dayRange(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), tz);
  };
  const month = (w: string) => {
    const i = MONTHS.indexOf(w.slice(0, 3));
    const full = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)$/.test(w);
    return full && i >= 0 ? i + 1 : 0;
  };
  const year = (v: string) => (/^\d{4}$/.test(v) && Number(v) >= 1970 && Number(v) <= 2100 ? Number(v) : 0);

  if (s === 'today') return dayRel(0);
  if (s === 'yesterday') return dayRel(-1);
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) return year(m[1]) ? dayRange(+m[1], +m[2], +m[3], tz) : null;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})$/))) return year(m[1]) ? monthRange(+m[1], +m[2], tz) : null;
  if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) return year(m[3]) ? dayRange(+m[3], +m[1], +m[2], tz) : null;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})$/))) return noYear(+m[1], +m[2]);
  // "nov 25", "nov 25 2026", "nov 2026", "nov"
  if ((m = s.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/)) && month(m[1])) {
    return m[3] ? (year(m[3]) ? dayRange(+m[3], month(m[1]), +m[2], tz) : null) : noYear(month(m[1]), +m[2]);
  }
  if ((m = s.match(/^([a-z]+)\.? (\d{4})$/)) && month(m[1])) return year(m[2]) ? monthRange(+m[2], month(m[1]), tz) : null;
  // "25 nov", "25 nov 2026"
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?(?: (\d{4}))?$/)) && month(m[2])) {
    return m[3] ? (year(m[3]) ? dayRange(+m[3], month(m[2]), +m[1], tz) : null) : noYear(month(m[2]), +m[1]);
  }
  return null;
}

// ---------- tokenizer and parser ----------

interface Tok { text: string; quoted: boolean; start: number; end: number }

function tokenize(input: string): Tok[] {
  const out: Tok[] = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    if (/\s/.test(input[i])) { i++; continue; }
    const start = i;
    let text = '';
    let quoted = false;
    // A token is a run of characters with no whitespace, but a "quoted part" may contain spaces ( from:"Cole Writer" ).
    while (i < n && !/\s/.test(input[i])) {
      if (input[i] === '"') {
        const close = input.indexOf('"', i + 1);
        if (close === -1) { text += input.slice(i + 1); i = n; quoted = true; break; }
        text += input.slice(i + 1, close);
        quoted = true;
        i = close + 1;
      } else {
        text += input[i++];
      }
    }
    out.push({ text, quoted, start, end: i });
  }
  return out;
}

/** The operator a token starts with ("from:harri" or "from:"), if it is one we know. */
function operatorOf(tok: Tok, input: string): { op: Operator; rest: string; restQuoted: boolean } | null {
  const raw = input.slice(tok.start, tok.end);
  const m = raw.match(/^([a-zA-Z]+):(.*)$/s);
  if (!m) return null;
  const op = m[1].toLowerCase();
  if (!(OPERATORS as readonly string[]).includes(op)) return null;
  const rest = m[2];
  // A URL like "from://x" or an emoji shortcode is not an operator.
  if (rest.startsWith('//')) return null;
  const quoted = rest.includes('"');
  const unq = quoted ? rest.replace(/"/g, '') : rest;
  return { op: op as Operator, rest: unq, restQuoted: quoted };
}

const ESCAPE = /[\\%_]/g;
export const likePattern = (s: string) => `%${s.replace(ESCAPE, (c) => `\\${c}`)}%`;

/**
 * Splits a search string into filters and free text. Filters are `operator:value` (spaces after the colon are fine,
 * values may be "quoted"). Unknown operators and values we can't understand stay in the text.
 */
export function parseSearch(input: string, opts: { now?: Date; tz?: string } = {}): ParsedSearch {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? 'UTC';
  const toks = tokenize(input.slice(0, 500));
  const res: ParsedSearch = { text: '', from: [], in: [], has: [], is: [], service: [], ignored: [] };
  const rest: string[] = [];
  let after: number | undefined;
  let before: number | undefined;
  const tighten = (r: { lo?: number; hi?: number }) => {
    if (r.lo !== undefined) after = after === undefined ? r.lo : Math.max(after, r.lo);
    if (r.hi !== undefined) before = before === undefined ? r.hi : Math.min(before, r.hi);
  };
  const put = <T>(list: T[], v: T) => { if (!list.includes(v)) list.push(v); };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const o = operatorOf(t, input);
    if (!o) { rest.push(input.slice(t.start, t.end)); continue; }
    // The value is what follows the colon, or the next token when the colon ends this one ("from: harri").
    let value = o.rest;
    let used = 0;
    if (value === '' && !o.restQuoted) {
      const nx = toks[i + 1];
      if (nx && !(operatorOf(nx, input) && !nx.quoted)) { value = nx.text; used = 1; }
    }
    const original = input.slice(t.start, toks[i + used].end);
    value = value.trim();
    if (!value) { res.ignored.push(original); continue; }  // "from:" typed but not finished yet: dropped, not searched
    const v = value.toLowerCase();
    let ok = true;
    switch (o.op) {
      case 'from': put(res.from, value); break;
      case 'in': put(res.in, value.replace(/^#/, '')); break;
      case 'has': {
        const h = HAS_ALIASES[v];
        if (h) put(res.has, h); else ok = false;
        break;
      }
      case 'is': {
        if (v === 'unread' || v === 'reply' || v === 'replies') put(res.is, v === 'unread' ? 'unread' : 'reply');
        else ok = false;
        break;
      }
      case 'service': {
        const s = v === 'imsg' ? 'imessage' : v === 'wa' ? 'whatsapp' : v === 'text' || v === 'texts' ? 'sms' : v;
        if ((SERVICE_VALUES as readonly string[]).includes(s)) put(res.service, s as ServiceValue); else ok = false;
        break;
      }
      case 'before': case 'after': case 'during': {
        // Dates can be several words ("nov 25"): take as many following tokens as still make a date.
        let range = parseDate(value, now, tz);
        let extra = 0;
        if (!o.restQuoted) {
          for (let k = 1; k <= 2; k++) {
            const nx = toks[i + used + k];
            if (!nx || operatorOf(nx, input)) break;
            const joined = [value, ...toks.slice(i + used + 1, i + used + 1 + k).map((x) => x.text)].join(' ');
            const r = parseDate(joined, now, tz);
            if (r) { range = r; extra = k; }
          }
        }
        if (!range) { ok = false; break; }
        used += extra;
        const lo = new Date(range.start).getTime();
        const hi = new Date(range.end).getTime();
        if (o.op === 'before') tighten({ hi: lo });
        else if (o.op === 'after') tighten({ lo: hi });
        else tighten({ lo, hi });
        break;
      }
    }
    if (!ok) {
      // Not understood: keep the words as ordinary text and say so.
      res.ignored.push(input.slice(t.start, toks[i + used].end));
      rest.push(input.slice(t.start, toks[i + used].end));
    }
    i += used;
  }
  res.text = rest.join(' ').trim();
  if (after !== undefined) res.sentAfter = new Date(after).toISOString();
  if (before !== undefined) res.sentBefore = new Date(before).toISOString();
  return res;
}

/** True when the parsed search has filters, not just text. */
export function hasFilters(p: ParsedSearch): boolean {
  return !!(p.from.length || p.in.length || p.has.length || p.is.length || p.service.length || p.sentAfter || p.sentBefore);
}
