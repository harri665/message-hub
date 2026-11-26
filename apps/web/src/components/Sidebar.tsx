import { useDeferredValue, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, SERVICE_LABEL, type ThreadSummary } from '../api.ts';
import { initials, listTime, serviceClass } from '../format.ts';

function preview(t: ThreadSummary) {
  if (t.last_unsent) return 'Message unsent';
  const body = t.last_body ?? (t.last_has_attachment ? 'Attachment' : '');
  if (t.last_kind === 'system') return `${t.last_sender_name ?? 'Someone'} ${body}`;
  if (t.last_from_me) return `You: ${body}`;
  if (t.is_group && t.last_sender_name) return `${t.last_sender_name}: ${body}`;
  return body;
}

export function Sidebar({ activeTid, onOpen, onSettings }: { activeTid: string | null; onOpen: (tid: string) => void; onSettings: () => void }) {
  const threads = useQuery({ queryKey: ['threads'], queryFn: api.threads, refetchInterval: 60_000 });
  const status = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 30_000 });
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim());
  const search = useQuery({
    queryKey: ['search', deferred],
    queryFn: () => api.search(deferred),
    enabled: deferred.length >= 2,
  });

  const filtered = useMemo(() => {
    const list = threads.data ?? [];
    if (!deferred) return list;
    const needle = deferred.toLowerCase();
    return list.filter((t) => t.title.toLowerCase().includes(needle));
  }, [threads.data, deferred]);

  const s = status.data;
  const problems: string[] = [];
  if (s) {
    if (s.bluebubbles.configured && !s.bluebubbles.connected) problems.push('iMessage is offline');
    if (s.whatsapp.configured && !s.whatsapp.loggedIn) problems.push('WhatsApp is not linked');
    else if (s.whatsapp.configured && !s.whatsapp.connected) problems.push('WhatsApp is offline');
  }
  const importing = s?.bluebubbles.importing;

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <h1>Messages</h1>
        <button className="text-btn" onClick={onSettings}>Settings</button>
      </header>
      <div className="search">
        <input
          type="search"
          placeholder="Search people and messages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search people and messages"
        />
      </div>
      {(problems.length > 0 || importing) && (
        <button className="banner" onClick={onSettings}>
          {importing ? 'Importing your iMessage history. This can take a while.' : problems.join('. ') + '.'}
        </button>
      )}
      <nav className="thread-list" aria-label="Conversations">
        {threads.isPending && <p className="list-note">Loading conversations</p>}
        {threads.isError && <p className="list-note">Could not load conversations. {threads.error.message}</p>}
        {threads.data && !threads.data.length && (
          <p className="list-note">No conversations yet. Connect iMessage or link WhatsApp in Settings.</p>
        )}
        {filtered.map((t) => (
          <button
            key={t.tid}
            className={`thread-row ${t.tid === activeTid ? 'active' : ''} ${t.unread ? 'unread' : ''}`}
            onClick={() => onOpen(t.tid)}
          >
            <span className={`avatar ${t.is_group ? 'group' : ''}`} aria-hidden="true">{initials(t.title)}</span>
            <span className="thread-main">
              <span className="thread-top">
                <span className="thread-title">{t.title}</span>
                <time className="thread-time">{listTime(t.last_at)}</time>
              </span>
              <span className="thread-bottom">
                <span className="thread-preview">{preview(t)}</span>
                <span className="thread-badges">
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
            {search.data && !search.data.length && <p className="list-note">No messages match "{deferred}".</p>}
            {search.data?.map((m) => (
              <button key={m.id} className="search-row" onClick={() => onOpen(m.tid)}>
                <span className="thread-top">
                  <span className="thread-title">{m.thread_title ?? m.sender_name}</span>
                  <time className="thread-time">{listTime(m.sent_at)}</time>
                </span>
                <span className="search-body">{m.from_me ? 'You: ' : ''}{m.body}</span>
              </button>
            ))}
          </section>
        )}
      </nav>
    </aside>
  );
}
