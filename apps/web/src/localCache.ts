// Keeps the inbox and recently opened conversations in IndexedDB, so the app shows them instantly on the next visit
// and then refreshes in the background. Everything here is wiped on sign-out.
import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

export const MEDIA_CACHE = 'mh-media-v1';
const DAY = 24 * 60 * 60_000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: DAY,
      refetchOnWindowFocus: true,
      retry: (n, err: any) => err?.status !== 401 && n < 2,
    },
  },
});

/** Only the inbox, conversation details and the newest page of each conversation are kept. */
const PERSISTED = new Set(['threads', 'thread', 'messages']);

export const persister = createAsyncStoragePersister({
  storage: typeof indexedDB === 'undefined' ? null : { getItem: get, setItem: set, removeItem: del },
  key: 'mh-query-cache',
  throttleTime: 2000,
  serialize: (client: PersistedClient) => {
    const queries = client.clientState.queries
      .filter((q) => PERSISTED.has(String(q.queryKey[0])) && q.state.status === 'success')
      .filter((q) => q.queryKey[0] !== 'messages' || q.queryKey[2] === 'latest')
      .map((q) => {
        if (q.queryKey[0] !== 'messages') return q;
        const data = q.state.data as { pages: unknown[]; pageParams: unknown[] } | undefined;
        return data ? { ...q, state: { ...q.state, data: { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } } } : q;
      });
    return JSON.stringify({ ...client, clientState: { ...client.clientState, queries, mutations: [] } });
  },
});

export const persistOptions = { persister, maxAge: DAY, buster: 'v1' };

/** Sign-out: forget everything stored on this device. */
export async function clearLocalData() {
  // Keep the login state itself so the app can switch to the sign-in screen.
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
  await persister.removeClient();
  if (typeof caches !== 'undefined') await caches.delete(MEDIA_CACHE).catch(() => false);
}
