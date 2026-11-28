import type { Service } from './api.ts';

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Inbox timestamp: time today, weekday this week, otherwise a short date. */
export function listTime(iso: string) {
  const d = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days === 0) return timeFmt.format(d);
  if (days === 1) return 'Yesterday';
  if (days < 7) return dayFmt.format(d);
  return shortDate.format(d);
}

export function dayLabel(iso: string) {
  const d = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return longDate.format(d);
}

export const clock = (iso: string) => timeFmt.format(new Date(iso));
export const fullTime = (iso: string) => `${longDate.format(new Date(iso))}, ${timeFmt.format(new Date(iso))}`;
export const sameDay = (a: string, b: string) => startOfDay(new Date(a)) === startOfDay(new Date(b));

export function initials(name: string) {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || !/\p{L}/u.test(name)) return '#';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export const serviceClass = (s: Service | null | undefined) => `svc-${s ?? 'imessage'}`;

export function fileSize(n: number | null) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

// ---------- scheduling ----------

const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const shortWhen = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "today at 6:00 PM", "tomorrow at 9:00 AM", "Monday at 9:00 AM" (within a week), otherwise "Dec 12 at 9:00 AM". */
export function sendsLabel(iso: string | Date) {
  const d = new Date(iso);
  const days = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  const t = timeFmt.format(d);
  if (days <= 0) return `today at ${t}`;
  if (days === 1) return `tomorrow at ${t}`;
  if (days < 7) return `${weekdayFmt.format(d)} at ${t}`;
  return `${shortDate.format(d)}${d.getFullYear() !== new Date().getFullYear() ? `, ${d.getFullYear()}` : ''} at ${t}`;
}

/** A Date as the value of an <input type="datetime-local"> (local time, no zone). */
export function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The full date and time of an instant in a named time zone, e.g. "Tue, Dec 1, 9:00 AM". */
export function inZone(d: Date, zone: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone }).format(d);
  } catch {
    return shortWhen.format(d);
  }
}
export const localWhen = (d: Date) => shortWhen.format(d);
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The suggested times: later today 18:00, tomorrow 9:00 and next Monday 9:00 (each only when it makes sense). */
export function quickPicks(now = new Date()): { label: string; at: Date }[] {
  const at = (days: number, h: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, 0, 0, 0);
  const out: { label: string; at: Date }[] = [];
  const evening = at(0, 18);
  if (+evening - +now > 15 * 60_000) out.push({ label: 'Later today', at: evening });
  out.push({ label: 'Tomorrow', at: at(1, 9) });
  const untilMonday = ((8 - now.getDay()) % 7) || 7;
  if (untilMonday > 1) out.push({ label: 'Monday', at: at(untilMonday, 9) });
  return out;
}
