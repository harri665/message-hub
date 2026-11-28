import { Fragment, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, SERVICE_LABEL, type Message, type MessagePage, type Service } from '../api.ts';
import { dayLabel, listTime, sameDay, serviceClass } from '../format.ts';
import { Avatar } from './Avatar.tsx';
import { Highlight } from './Highlight.tsx';
import { MessageBubble } from './MessageBubble.tsx';
import { Composer } from './Composer.tsx';

const PAGE = 60;

/** A message typed here that the server hasn't confirmed yet. */
export interface Pending {
  key: string;
  text?: string;
  file?: File;
  conversationId: number;
  service: Service;
  replyToId?: number;
  status: 'sending' | 'failed';
  error?: string;
}

export function ThreadView({ tid, focus, onFocus, onBack }: {
  tid: string;
  /** A message to open the conversation at (from search), or null for the latest messages. */
  focus: number | null;
  onFocus: (messageId: number | null) => void;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const thread = useQuery({ queryKey: ['thread', tid], queryFn: () => api.thread(tid) });
  // Pages: older ones are appended (next), newer ones prepended (previous) when opened at a message.
  const messages = useInfiniteQuery({
    queryKey: ['messages', tid, focus ?? 'latest'],
    queryFn: ({ pageParam }) => api.messages(tid, pageParam),
    initialPageParam: (focus ? { around: focus } : {}) as MessagePage,
    getNextPageParam: (last, _all, param) =>
      !last.length || (!param.around && last.length < PAGE) ? undefined : { before: last[0].sent_at },
    getPreviousPageParam: (first, _all, param) =>
      !focus || !first.length || (param.after && first.length < PAGE) || (!param.around && !param.after)
        ? undefined
        : { after: first[first.length - 1].sent_at },
  });
  const [findOpen, setFindOpen] = useState(false);
  const [flash, setFlash] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [farFromBottom, setFarFromBottom] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);

  const list = useMemo(() => [...(messages.data?.pages ?? [])].reverse().flat(), [messages.data]);

  // Keep the scroll area clear of the floating composer, whatever its height.
  useLayoutEffect(() => {
    const el = composerRef.current;
    const root = rootRef.current;
    if (!el || !root) return;
    const ro = new ResizeObserver(() => root.style.setProperty('--composer-space', `${el.offsetHeight + 24}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [thread.data]);

  // Opened at a message: bring it to the middle of the screen and flash it once.
  const focusLoaded = !!focus && list.some((m) => m.id === focus);
  useEffect(() => {
    if (!focus || !focusLoaded) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-mid="${focus}"]`);
    el?.scrollIntoView({ block: 'center' });
    setFlash(focus);
    const t = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(t);
  }, [focus, focusLoaded]);

  // Back to the latest messages: start at the bottom again.
  useEffect(() => {
    if (!focus) scrollRef.current?.scrollTo({ top: 0 });
  }, [focus]);

  // Mark read when opened, when new messages arrive, and when the window comes back.
  const newestId = list[list.length - 1]?.id;
  useEffect(() => {
    if (document.hidden) return;
    api.markRead(tid).then(() => qc.invalidateQueries({ queryKey: ['threads'] })).catch(() => {});
  }, [tid, newestId, qc]);
  useEffect(() => {
    const onVisible = () => !document.hidden && api.markRead(tid).catch(() => {});
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [tid]);

  const send = useCallback(
    async (p: Omit<Pending, 'key' | 'status'>, retryKey?: string) => {
      const key = retryKey ?? `${Date.now()}-${Math.random()}`;
      if (focus) onFocus(null);
      setPending((cur) =>
        retryKey ? cur.map((x) => (x.key === key ? { ...x, status: 'sending', error: undefined } : x)) : [...cur, { ...p, key, status: 'sending' }],
      );
      scrollRef.current?.scrollTo({ top: 0 });
      try {
        if (p.file) await api.sendFile(tid, p.file, p.conversationId, p.text);
        else await api.send(tid, { text: p.text!, conversationId: p.conversationId, replyToId: p.replyToId });
        await qc.invalidateQueries({ queryKey: ['messages', tid] });
        qc.invalidateQueries({ queryKey: ['threads'] });
        setPending((cur) => cur.filter((x) => x.key !== key));
      } catch (err) {
        setPending((cur) => cur.map((x) => (x.key === key ? { ...x, status: 'failed', error: err instanceof Error ? err.message : 'Not sent' } : x)));
      }
    },
    [tid, qc, focus, onFocus],
  );

  const t = thread.data;
  const services = Array.from(new Set(t?.conversations.map((c) => c.lastService) ?? []));
  const lastFromMeId = [...list].reverse().find((m) => m.from_me && m.kind === 'text')?.id;

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // column-reverse: scrollTop is 0 at the newest message and negative going up.
    setFarFromBottom(-el.scrollTop > 500);
    if (el.scrollHeight + el.scrollTop - el.clientHeight < 500 && messages.hasNextPage && !messages.isFetchingNextPage) {
      messages.fetchNextPage();
    }
  };

  return (
    <section className="thread" ref={rootRef} aria-label={t?.title ?? 'Conversation'}>
      <div className="messages" ref={scrollRef} onScroll={onScroll}>
        <div className="messages-inner">
          {messages.isFetchingNextPage && <p className="list-note center">Loading older messages</p>}
          {!messages.hasNextPage && list.length > 0 && <p className="list-note center">Start of conversation</p>}
          {messages.isError && <p className="list-note center">Could not load messages. {messages.error.message}</p>}
          {list.map((m, i) => {
            const prev = list[i - 1];
            const next = list[i + 1];
            const newDay = !prev || !sameDay(prev.sent_at, m.sent_at);
            const serviceChanged = !!prev && !newDay && prev.service !== m.service;
            const grouped = (a?: Message, b?: Message) =>
              !!a && !!b && a.from_me === b.from_me && a.sender_person_id === b.sender_person_id && a.kind === 'text' && b.kind === 'text' &&
              a.service === b.service && Math.abs(new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime()) < 5 * 60_000;
            return (
              <Fragment key={m.id}>
                {newDay && <div className="day-sep">{dayLabel(m.sent_at)}</div>}
                {(serviceChanged || (newDay && services.length > 1)) && (
                  <div className={`seam ${serviceClass(m.service)}`}>
                    <span>{SERVICE_LABEL[m.service]}</span>
                  </div>
                )}
                <MessageBubble
                  m={m}
                  highlighted={m.id === flash}
                  isGroup={!!t?.isGroup}
                  firstInRun={newDay || serviceChanged || !grouped(prev, m)}
                  lastInRun={!grouped(m, next) || (!!next && !sameDay(m.sent_at, next.sent_at))}
                  showStatus={m.id === lastFromMeId && !pending.length}
                  onReply={() => setReplyTo(m)}
                  onOpenImage={setLightbox}
                />
              </Fragment>
            );
          })}
          {messages.hasPreviousPage && (
            <button className="pill-btn newer" onClick={() => messages.fetchPreviousPage()} disabled={messages.isFetchingPreviousPage}>
              {messages.isFetchingPreviousPage ? 'Loading' : 'Show newer messages'}
            </button>
          )}
          {pending.map((p) => (
            <div key={p.key} className={`msg out first last ${serviceClass(p.service)} ${p.status === 'failed' ? 'failed' : 'pending'}`}>
              <div className="msg-row">
                <div className="msg-stack">
                  {p.file && <div className="att-file"><span className="att-name">{p.file.name}</span></div>}
                  {p.text && <div className="bubble">{p.text}</div>}
                </div>
              </div>
              <span className="msg-meta">
                {p.status === 'sending' ? 'Sending…' : `Not delivered. ${p.error ?? ''}`}
                {p.status === 'failed' && (
                  <>
                    <button className="link-btn retry" onClick={() => send(p, p.key)}>Retry</button>
                    <button className="link-btn" onClick={() => setPending((cur) => cur.filter((x) => x.key !== p.key))}>Discard</button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      <header className="thread-head glass">
        <button className="pill-btn back" onClick={onBack}>Back</button>
        <Avatar tid={tid} title={t?.title ?? ''} isGroup={!!t?.isGroup} version={t?.avatar} small />
        <div className="thread-head-main">
          <h2>{t?.title ?? ''}</h2>
          <p className="thread-head-sub">
            {services.map((s, i) => (
              <Fragment key={s}>
                {i > 0 && ', '}
                <span className={`svc-text ${serviceClass(s)}`}>{SERVICE_LABEL[s]}</span>
              </Fragment>
            ))}
            {t?.isGroup && t.members.length > 0 && <span> with {t.members.length} people</span>}
          </p>
        </div>
        {t && <MuteControl tid={tid} muted={t.muted} hasWhatsApp={t.conversations.some((c) => c.network === 'whatsapp')} />}
        <button className="pill-btn" onClick={() => setFindOpen((o) => !o)} aria-expanded={findOpen}>
          {findOpen ? 'Done' : 'Search'}
        </button>
      </header>

      {findOpen && <FindInThread tid={tid} onPick={(id) => onFocus(id)} onClose={() => setFindOpen(false)} />}

      {(farFromBottom || !!focus) && (
        <button
          className="jump glass"
          onClick={() => (focus ? onFocus(null) : scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))}
        >
          Jump to latest
        </button>
      )}

      {t && <Composer ref={composerRef} thread={t} replyTo={replyTo} onClearReply={() => setReplyTo(null)} onSend={send} />}

      {lightbox && (
        <div className="backdrop lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label="Photo">
          <img src={lightbox} alt="" onClick={(e) => e.stopPropagation()} />
          <button className="pill-btn close glass" onClick={() => setLightbox(null)}>Close</button>
        </div>
      )}
    </section>
  );
}

/** Search inside one conversation; picking a result opens the conversation at that message. */
function FindInThread({ tid, onPick, onClose }: { tid: string; onPick: (id: number) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const query = useDeferredValue(text.trim());
  const results = useQuery({
    queryKey: ['search', query, tid],
    queryFn: () => api.search(query, { tid, limit: 50 }),
    enabled: query.length >= 2,
  });
  return (
    <div className="find glass" role="search">
      <input
        className="search-field"
        type="search"
        autoFocus
        placeholder="Search this conversation"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        aria-label="Search this conversation"
      />
      {query.length >= 2 && (
        <div className="find-results">
          {results.isPending && <p className="list-note">Searching</p>}
          {results.data && !results.data.length && <p className="list-note">No messages match "{query}".</p>}
          {results.data?.map((m) => (
            <button key={m.id} className="search-row" onClick={() => onPick(m.id)}>
              <span className="thread-top">
                <span className="thread-title">{m.from_me ? 'You' : (m.sender_name ?? 'Unknown')}</span>
                <time className="thread-time">{listTime(m.sent_at)}</time>
              </span>
              <span className="search-body"><Highlight text={m.snippet ?? m.body ?? ''} /></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Mute or unmute this conversation. WhatsApp chats change on the WhatsApp account too, so the phone matches. */
function MuteControl({ tid, muted, hasWhatsApp }: { tid: string; muted: boolean; hasWhatsApp: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async (next: boolean, hours: number | null = null) => {
    setBusy(true);
    setError(null);
    try {
      await api.mute(tid, next, hours);
      setOpen(false);
      await Promise.all([qc.invalidateQueries({ queryKey: ['thread', tid] }), qc.invalidateQueries({ queryKey: ['threads'] })]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the mute setting');
    } finally {
      setBusy(false);
    }
  };
  if (muted) {
    return (
      <button className="pill-btn" disabled={busy} onClick={() => apply(false)} title={error ?? undefined}>
        {busy ? 'Unmuting' : 'Unmute'}
      </button>
    );
  }
  return (
    <div className="mute">
      <button className="pill-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Mute</button>
      {open && (
        <div className="mute-menu glass" role="menu">
          <button role="menuitem" disabled={busy} onClick={() => apply(true, 8)}>For 8 hours</button>
          <button role="menuitem" disabled={busy} onClick={() => apply(true, 24 * 7)}>For 1 week</button>
          <button role="menuitem" disabled={busy} onClick={() => apply(true)}>Always</button>
          <p className="note">{hasWhatsApp ? 'Also mutes it in WhatsApp on your phone.' : 'Mutes it here. iPhone mute settings stay as they are.'}</p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
