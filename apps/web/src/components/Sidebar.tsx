import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, SERVICE_LABEL, type MessagePage, type ThreadSummary } from '../api.ts';
import { listTime, serviceClass } from '../format.ts';
import { Avatar } from './Avatar.tsx';
import { Highlight } from './Highlight.tsx';
import { allOperators, complete, freeText, type Completion, type Suggestion } from '../searchSuggest.ts';

type Filter = 'all' | 'unread' | 'apple' | 'whatsapp';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'apple', label: 'iMessage' },
  { key: 'whatsapp', label: 'WhatsApp' },
];

function mutedLabel(until: string | null) {
  if (!until || !Number.isFinite(Date.parse(until)) || new Date(until).getFullYear() > 9000) return 'Muted';
  return `Muted until ${new Date(until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

function preview(t: ThreadSummary) {
  if (t.last_unsent) return 'Message unsent';
  const body = t.last_body ?? (t.last_has_attachment ? 'Attachment' : '');
  if (t.last_kind === 'system') return `${t.last_sender_name ?? 'Someone'} ${body}`;
  if (t.last_from_me) return `You: ${body}`;
  if (t.is_group && t.last_sender_name) return `${t.last_sender_name}: ${body}`;
  return body;
}

const SEARCH_PAGE = 40;

export function Sidebar({ activeTid, onOpen, onSettings }: {
  activeTid: string | null;
  onOpen: (tid: string, messageId?: number) => void;
  onSettings: () => void;
}) {
  const qc = useQueryClient();
  const threads = useQuery({ queryKey: ['threads'], queryFn: api.threads, refetchInterval: 60_000 });
  // Pointing at a conversation starts loading it, so it's usually ready by the time it's clicked.
  const prefetch = (tid: string) => {
    qc.prefetchQuery({ queryKey: ['thread', tid], queryFn: () => api.thread(tid) });
    qc.prefetchInfiniteQuery({
      queryKey: ['messages', tid, 'latest'],
      queryFn: ({ pageParam }: { pageParam: MessagePage }) => api.messages(tid, pageParam),
      initialPageParam: {} as MessagePage,
      // Same paging rule as the conversation view (only the first page is fetched here).
      getNextPageParam: (last: { sent_at: string }[]) => (last.length < 60 ? undefined : { before: last[0].sent_at }),
    });
  };
  const status = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 30_000 });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const searchRef = useRef<HTMLInputElement>(null);
  // Suggestions for "from:", "has:" and the other filters, shown under the box while it has focus.
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const completion: Completion | null = useMemo(
    () => (!focused || dismissed ? null : query ? complete(query, caret, threads.data ?? []) : allOperators()),
    [focused, dismissed, query, caret, threads.data],
  );
  const choices = completion?.items.filter((i) => !i.info) ?? [];
  useEffect(() => setActive(0), [completion?.start, completion?.items.length, query]);
  const apply = (item: Suggestion) => {
    if (!completion) return;
    const next = query.slice(0, completion.start) + item.insert + query.slice(completion.end);
    const at = completion.start + item.insert.length;
    setQuery(next);
    setCaret(at);
    setDismissed(false);
    requestAnimationFrame(() => searchRef.current?.setSelectionRange(at, at));
  };
  const deferred = useDeferredValue(query.trim());
  const searchService = filter === 'apple' || filter === 'whatsapp' ? filter : '';
  const search = useInfiniteQuery({
    queryKey: ['search', deferred, searchService],
    queryFn: ({ pageParam }) => api.search(deferred, { service: searchService, limit: SEARCH_PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.length < SEARCH_PAGE ? undefined : all.length * SEARCH_PAGE),
    enabled: deferred.length >= 2,
  });
  const hits = useMemo(() => search.data?.pages.flat() ?? [], [search.data]);

  // Ctrl/Cmd+K jumps to search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filtered = useMemo(() => {
    let list = threads.data ?? [];
    if (filter === 'unread') list = list.filter((t) => t.unread > 0);
    else if (filter !== 'all') list = list.filter((t) => t.networks.includes(filter));
    if (deferred) {
      // "from: mom pizza" narrows the people list by "pizza" only, and by nothing but the words when there are none.
      const { text, hasFilters } = freeText(deferred);
      if (hasFilters && !text) return [];
      const needle = text.toLowerCase();
      list = list.filter((t) => t.title.toLowerCase().includes(needle));
    }
    return list;
  }, [threads.data, filter, deferred]);

  const s = status.data;
  let banner: { text: string; warn: boolean } | null = null;
  if (s?.bluebubbles.importing) banner = { text: 'Importing your iMessage history. This can take a while.', warn: false };
  else if (s) {
    const problems: string[] = [];
    if (!s.bluebubbles.configured) problems.push('iMessage is not connected');
    else if (!s.bluebubbles.connected) problems.push('iMessage is offline');
    if (s.whatsapp.configured && !s.whatsapp.loggedIn) problems.push('WhatsApp is not linked');
    else if (s.whatsapp.configured && !s.whatsapp.connected) problems.push('WhatsApp is offline');
    if (problems.length) banner = { text: `${problems.join('. ')}. Open Settings to fix it.`, warn: true };
  }

  return (
    <aside className="sidebar glass">
      <header className="sidebar-head">
        <h1>Messages</h1>
        <button className="pill-btn" onClick={onSettings}>Settings</button>
      </header>
      <div className="sidebar-tools">
        <div className="search-wrap">
        <input
          ref={searchRef}
          className="search-field"
          type="search"
          placeholder="Search people and messages (Ctrl+K)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setDismissed(false); }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onFocus={() => { setFocused(true); setDismissed(false); }}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (completion && choices.length && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                apply(choices[active] ?? choices[0]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDismissed(true);
                return;
              }
            }
            if (e.key === 'Escape') setQuery('');
          }}
          role="combobox"
          aria-expanded={!!completion}
          aria-autocomplete="list"
          aria-controls="search-suggestions"
          aria-label="Search people and messages"
          autoComplete="off"
        />
        {completion && (
          <ul id="search-suggestions" className="search-suggest glass" role="listbox">
            {completion.items.map((item) => {
              const idx = choices.indexOf(item);
              return (
                <li
                  key={item.label + item.insert}
                  role={item.info ? undefined : 'option'}
                  aria-selected={idx === active}
                  className={`${item.info ? 'info' : ''} ${idx === active ? 'active' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); if (!item.info) apply(item); }}
                  onMouseEnter={() => idx >= 0 && setActive(idx)}
                >
                  <span className="suggest-label">{item.label}</span>
                  {item.hint && <span className="suggest-hint">{item.hint}</span>}
                </li>
              );
            })}
          </ul>
        )}
        </div>
        <div className="segmented" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.key} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {banner && (
        <button className={`banner ${banner.warn ? 'warn' : ''}`} onClick={onSettings}>
          {banner.text}
        </button>
      )}
      <nav className="thread-list" aria-label="Conversations">
        {threads.isPending && <p className="list-note">Loading conversations</p>}
        {threads.isError && <p className="list-note">Could not load conversations. {threads.error.message}</p>}
        {threads.data && !threads.data.length && (
          <p className="list-note">No conversations yet. Connect iMessage or link WhatsApp in Settings.</p>
        )}
        {threads.data && threads.data.length > 0 && !filtered.length && !deferred && (
          <p className="list-note">{filter === 'unread' ? "You're all caught up." : 'No conversations here.'}</p>
        )}
        {filtered.map((t) => (
          <button
            key={t.tid}
            className={`thread-row ${t.tid === activeTid ? 'active' : ''} ${t.unread ? 'unread' : ''} ${t.muted ? 'muted' : ''}`}
            onClick={() => onOpen(t.tid)}
            onPointerEnter={() => prefetch(t.tid)}
            onFocus={() => prefetch(t.tid)}
            aria-current={t.tid === activeTid ? 'page' : undefined}
          >
            <Avatar tid={t.tid} title={t.title} isGroup={t.is_group} version={t.avatar} />
            <span className="thread-main">
              <span className="thread-top">
                <span className="thread-title">{t.title}</span>
                <time className="thread-time">{listTime(t.last_at)}</time>
              </span>
              <span className="thread-bottom">
                <span className="thread-preview">{preview(t)}</span>
                <span className="thread-badges">
                  {t.muted && <span className="muted-tag" title={mutedLabel(t.muted_until)}>Muted</span>}
                  {t.last_service && (
                    <span className={`svc-dot ${serviceClass(t.last_service)}`} title={`Last message via ${SERVICE_LABEL[t.last_service]}`} />
                  )}
                  {t.unread > 0 && <span className="unread-count">{t.unread}</span>}
                </span>
              </span>
            </span>
          </button>
        ))}
        {deferred.length >= 2 && (
          <section className="search-results" aria-label="Matching messages">
            <h2>Messages</h2>
            {search.isPending && <p className="list-note">Searching</p>}
            {search.isError && <p className="list-note">Search failed. {search.error.message}</p>}
            {search.data && !hits.length && <p className="list-note">No messages match "{deferred}".</p>}
            {hits.map((m) => (
              <button key={m.id} className="search-row" onClick={() => onOpen(m.tid, m.id)}>
                <span className="thread-top">
                  <span className="thread-title">{m.thread_title ?? m.sender_name}</span>
                  <time className="thread-time">{listTime(m.sent_at)}</time>
                </span>
                <span className="search-body">
                  <span className={`svc-dot ${serviceClass(m.service)}`} title={SERVICE_LABEL[m.service]} />
                  {m.from_me ? 'You: ' : m.is_group && m.sender_name ? `${m.sender_name}: ` : ''}
                  <Highlight text={m.snippet ?? m.body ?? ''} />
                </span>
              </button>
            ))}
            {search.hasNextPage && (
              <button className="pill-btn more" onClick={() => search.fetchNextPage()} disabled={search.isFetchingNextPage}>
                {search.isFetchingNextPage ? 'Loading' : 'Show more results'}
              </button>
            )}
          </section>
        )}
      </nav>
    </aside>
  );
}
