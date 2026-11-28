// Suggestions for the search box's Discord-style filters ("from:", "has:", ...). The hub parses the query
// (apps/hub/src/searchquery.ts); this only helps typing it and keeps the people list in step with it.
import type { ThreadSummary } from './api.ts';

export interface Suggestion {
  /** Text shown, e.g. "from:" or "Cole Writer". */
  label: string;
  /** Smaller text after it. */
  hint?: string;
  /** What replaces the word being typed. Empty for a hint that can't be picked. */
  insert: string;
  /** A hint row only explains; it can't be chosen. */
  info?: boolean;
  /** After picking, keep typing the value (no trailing space). */
  more?: boolean;
}

export interface Completion { start: number; end: number; items: Suggestion[] }

const OPERATORS: { op: string; hint: string }[] = [
  { op: 'from', hint: 'messages from a person (or "me")' },
  { op: 'in', hint: 'one conversation' },
  { op: 'has', hint: 'image, video, file, link, audio, sticker' },
  { op: 'before', hint: 'before a date' },
  { op: 'after', hint: 'after a date' },
  { op: 'during', hint: 'on a day or in a month' },
  { op: 'is', hint: 'unread or reply' },
  { op: 'service', hint: 'imessage, sms or whatsapp' },
];
const HAS = ['image', 'video', 'file', 'link', 'audio', 'sticker', 'attachment'];
const IS = ['unread', 'reply'];
const SERVICE = ['imessage', 'sms', 'whatsapp'];
const DATES = ['today', 'yesterday'];
const MAX = 7;

const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v);
const FILTER = /\b(?:from|in|has|before|after|during|is|service):[ \t]*(?:"[^"]*"|\S+)/gi;

/** The search text without its filters, for narrowing the people list. */
export function freeText(query: string): { text: string; hasFilters: boolean } {
  const text = query.replace(FILTER, ' ').replace(/\s+/g, ' ').trim();
  return { text, hasFilters: text !== query.replace(/\s+/g, ' ').trim() };
}

/** What to suggest for the word ending at the caret, or null when nothing applies. */
export function complete(query: string, caret: number, threads: ThreadSummary[]): Completion | null {
  const before = query.slice(0, caret);
  // "from: Col", "from:"Cole W", "has:i": an operator and the start of its value.
  const q = before.match(/(?:^|\s)(from|in|has|before|after|during|is|service):[ 	]*"([^"]*)$/i);
  const m = q ? null : before.match(/(?:^|\s)(from|in|has|before|after|during|is|service):[ 	]*("?)([^"\s]*)$/i);
  if (m || q) {
    const op = (q ? q[1] : m![1]).toLowerCase();
    const partial = (q ? q[2] : m![3]).toLowerCase();
    const valueLen = q ? q[2].length + 1 : m![2].length + m![3].length;
    const start = caret - valueLen;
    const pick = (list: string[]) => list.filter((v) => v.includes(partial));
    let items: Suggestion[] = [];
    if (op === 'has') items = pick(HAS).map((v) => ({ label: v, insert: `${v} ` }));
    else if (op === 'is') items = pick(IS).map((v) => ({ label: v, insert: `${v} ` }));
    else if (op === 'service') items = pick(SERVICE).map((v) => ({ label: v, insert: `${v} ` }));
    else if (op === 'from' || op === 'in') {
      const seen = new Set<string>();
      if (op === 'from' && 'me'.startsWith(partial)) { items.push({ label: 'me', hint: 'messages you sent', insert: 'me ' }); seen.add('me'); }
      const list = op === 'from' ? threads.filter((t) => !t.is_group) : threads;
      const starts = list.filter((t) => t.title.toLowerCase().startsWith(partial));
      const has = list.filter((t) => !t.title.toLowerCase().startsWith(partial) && t.title.toLowerCase().includes(partial));
      for (const t of [...starts, ...has]) {
        if (seen.has(t.title) || items.length >= MAX) continue;
        seen.add(t.title);
        items.push({ label: t.title, hint: op === 'in' && t.is_group ? 'group' : undefined, insert: `${quote(t.title)} ` });
      }
    } else {
      items = [
        ...DATES.filter((v) => v.includes(partial)).map((v) => ({ label: v, insert: `${v} ` })),
        { label: 'Try 2026-11-25, 2026-11, nov 25 or yesterday', insert: '', info: true },
      ];
    }
    if (!items.length) return null;
    // Typing the full value exactly isn't worth a popup.
    if (items.length === 1 && !items[0].info && items[0].label.toLowerCase() === partial && !partial.includes(' ')) return null;
    return { start, end: caret, items: items.slice(0, MAX) };
  }
  // A word that starts like an operator: "fr" -> from:
  const w = before.match(/(?:^|\s)([a-z]{2,8})$/i);
  if (w) {
    const items = OPERATORS.filter((o) => o.op.startsWith(w[1].toLowerCase()) && o.op !== w[1].toLowerCase())
      .map((o) => ({ label: `${o.op}:`, hint: o.hint, insert: `${o.op}: `, more: true }));
    if (items.length) return { start: caret - w[1].length, end: caret, items };
  }
  return null;
}

/** All operators, shown when the box is focused and empty. */
export function allOperators(): Completion {
  return { start: 0, end: 0, items: OPERATORS.map((o) => ({ label: `${o.op}:`, hint: o.hint, insert: `${o.op}: `, more: true })) };
}
