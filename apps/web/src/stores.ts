// Small shared stores outside React Query: unsent drafts (kept on this device) and who is typing right now.
import { useSyncExternalStore } from 'react';

function createStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const s of subs) s();
    },
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

// ---------- drafts ----------

const DRAFT_PREFIX = 'mh-draft:';

function loadDrafts(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(DRAFT_PREFIX)) out[k.slice(DRAFT_PREFIX.length)] = localStorage.getItem(k) ?? '';
    }
  } catch {
    /* storage unavailable: drafts just aren't kept */
  }
  return out;
}

const drafts = createStore<Record<string, string>>(loadDrafts());

/** Text typed in a conversation but not sent yet. Survives switching conversations and reloading the page. */
export function setDraft(tid: string, text: string) {
  const cur = drafts.get();
  if ((cur[tid] ?? '') === text) return;
  const next = { ...cur };
  if (text.trim()) next[tid] = text;
  else delete next[tid];
  drafts.set(next);
  try {
    if (text.trim()) localStorage.setItem(DRAFT_PREFIX + tid, text);
    else localStorage.removeItem(DRAFT_PREFIX + tid);
  } catch {
    /* ignore */
  }
}

export const getDraft = (tid: string) => drafts.get()[tid] ?? '';
export const useDrafts = () => useSyncExternalStore(drafts.subscribe, drafts.get);

/** Sign-out: drafts are private too. */
export function clearDrafts() {
  for (const tid of Object.keys(drafts.get())) setDraft(tid, '');
}

// Another tab edited a draft.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key.startsWith(DRAFT_PREFIX)) drafts.set(loadDrafts());
  });
}

// ---------- typing ----------

export interface Typist { key: string; name: string | null; audio: boolean; until: number }

const typing = createStore<Record<string, Typist[]>>({});
let sweepTimer: number | undefined;

function sweep() {
  sweepTimer = undefined;
  const now = Date.now();
  const cur = typing.get();
  let changed = false;
  const next: Record<string, Typist[]> = {};
  let soonest = Infinity;
  for (const [tid, list] of Object.entries(cur)) {
    const live = list.filter((t) => t.until > now);
    if (live.length !== list.length) changed = true;
    if (live.length) next[tid] = live;
    for (const t of live) soonest = Math.min(soonest, t.until);
  }
  if (changed) typing.set(next);
  if (soonest < Infinity) sweepTimer = window.setTimeout(sweep, soonest - now + 50);
}

/**
 * Someone started or stopped typing. Indicators also run out by themselves: services don't always send "stopped",
 * so one that isn't repeated disappears (iMessage sends a single "started", so it gets longer).
 */
export function setTyping(tid: string, key: string, on: boolean, info: { name: string | null; audio: boolean; ttlMs: number }) {
  const cur = typing.get();
  const others = (cur[tid] ?? []).filter((t) => t.key !== key);
  const list = on ? [...others, { key, name: info.name, audio: info.audio, until: Date.now() + info.ttlMs }] : others;
  const next = { ...cur };
  if (list.length) next[tid] = list;
  else delete next[tid];
  typing.set(next);
  if (sweepTimer) clearTimeout(sweepTimer);
  sweep();
}

/** A new message from someone ends their typing indicator. */
export function clearTyping(tid: string) {
  if (!typing.get()[tid]) return;
  const next = { ...typing.get() };
  delete next[tid];
  typing.set(next);
}

export const useTyping = () => useSyncExternalStore(typing.subscribe, typing.get);
