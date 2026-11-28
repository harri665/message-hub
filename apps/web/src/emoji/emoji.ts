// :shortcode: lookup for the composer. Data: shortcodes.json (see LICENSE-emojibase.txt), most popular first.
import raw from './shortcodes.json';

export interface EmojiEntry { emoji: string; name: string; aliases: string[]; rank: number }

const ALL: EmojiEntry[] = (raw as string[][]).map((r, rank) => ({ emoji: r[0], name: r[1], aliases: r.slice(2), rank }));
const BY_NAME = new Map<string, EmojiEntry>();
for (const e of ALL) for (const n of [e.name, ...e.aliases]) if (!BY_NAME.has(n)) BY_NAME.set(n, e);

export const emojiByName = (name: string) => BY_NAME.get(name.toLowerCase());

/** Exact name first, then names that start with the text, then names containing it; most popular first within each. */
export function searchEmoji(query: string, limit = 8): (EmojiEntry & { shown: string })[] {
  const q = query.toLowerCase();
  if (q.length < 2) return [];
  const scored: { e: EmojiEntry; shown: string; score: number }[] = [];
  for (const e of ALL) {
    let best = -1;
    let shown = e.name;
    for (const n of [e.name, ...e.aliases]) {
      const s = n === q ? 0 : n.startsWith(q) ? 1 : n.includes(`_${q}`) ? 2 : n.includes(q) ? 3 : -1;
      if (s >= 0 && (best < 0 || s < best)) { best = s; shown = n; }
    }
    if (best >= 0) scored.push({ e, shown, score: best });
  }
  scored.sort((a, b) => a.score - b.score || a.e.rank - b.e.rank);
  return scored.slice(0, limit).map((x) => ({ ...x.e, shown: x.shown }));
}

export interface Trigger { start: number; query: string }

const NAME = '[a-z0-9_+-]';

/** True when the position is inside a `code span` or ``` block (an odd number of backticks before it). */
function inCode(text: string, pos: number) {
  return (text.slice(0, pos).match(/`/g)?.length ?? 0) % 2 === 1;
}

/** The ":smi" being typed just before the caret. It must start the text or follow whitespace, so "http://x:80" and "a:b" don't count. */
export function findTrigger(text: string, caret: number): Trigger | null {
  const m = text.slice(0, caret).match(new RegExp(`(?:^|\\s):(${NAME}{2,})$`, 'i'));
  if (!m) return null;
  const start = caret - m[1].length - 1;
  if (inCode(text, start)) return null;
  return { start, query: m[1] };
}

/** A just-completed ":smile:" before the caret that names a real emoji; the text to replace and what to put there. */
export function findComplete(text: string, caret: number): { start: number; emoji: string } | null {
  const m = text.slice(0, caret).match(new RegExp(`(?:^|\\s):(${NAME}{2,}):$`, 'i'));
  if (!m) return null;
  const start = caret - m[1].length - 2;
  if (inCode(text, start)) return null;
  const e = emojiByName(m[1]);
  return e ? { start, emoji: e.emoji } : null;
}

/** Where the caret is inside a textarea, relative to the textarea's top left (follows wrapping and scrolling). */
export function caretOffset(area: HTMLTextAreaElement, pos: number): { left: number; top: number; height: number } {
  const cs = getComputedStyle(area);
  const mirror = document.createElement('div');
  const props = ['boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform',
    'wordSpacing', 'textIndent', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
    'borderBottomWidth', 'borderLeftWidth', 'tabSize'] as const;
  for (const p of props) mirror.style[p] = cs[p];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.textContent = area.value.slice(0, pos);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const out = { left: marker.offsetLeft - area.scrollLeft, top: marker.offsetTop - area.scrollTop, height: marker.offsetHeight || parseFloat(cs.lineHeight) || 18 };
  mirror.remove();
  return out;
}
