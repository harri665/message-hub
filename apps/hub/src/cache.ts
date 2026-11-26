// Small in-memory cache for read queries (inbox, conversations, search), shared by the web API and the MCP server.
// Any live event (new message, reaction, receipt, read, sync finished) moves the data version on, which makes every
// cached entry stale at once, so results are never older than the last change. Entries also expire after a while
// as a safety net for changes that don't announce themselves.
import { bus } from './store.js';

const MAX_ENTRIES = 500;
const TTL_MS = 5 * 60_000;

let version = 0;
bus.on('live', () => {
  version++;
});

interface Entry { version: number; at: number; value: Promise<unknown> }
const entries = new Map<string, Entry>();
let hits = 0;
let misses = 0;

export function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const e = entries.get(key);
  if (e && e.version === version && Date.now() - e.at < TTL_MS) {
    hits++;
    // Refresh its place in the LRU order.
    entries.delete(key);
    entries.set(key, e);
    return e.value as Promise<T>;
  }
  misses++;
  const value = load();
  const entry: Entry = { version, at: Date.now(), value };
  entries.set(key, entry);
  // Failed loads are not kept.
  value.catch(() => entries.get(key) === entry && entries.delete(key));
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  return value;
}

export const cacheStats = () => ({ entries: entries.size, version, hits, misses });
