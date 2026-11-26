import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, SERVICE_LABEL, type Message, type Service } from '../api.ts';
import { dayLabel, initials, sameDay, serviceClass } from '../format.ts';
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

export function ThreadView({ tid, onBack }: { tid: string; onBack: () => void }) {
  const qc = useQueryClient();
  const thread = useQuery({ queryKey: ['thread', tid], queryFn: () => api.thread(tid) });
  const messages = useInfiniteQuery({
    queryKey: ['messages', tid],
    queryFn: ({ pageParam }) => api.messages(tid, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last[0]?.sent_at),
  });
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
    [tid, qc],
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
        <span className={`avatar small ${t?.isGroup ? 'group' : ''}`} aria-hidden="true">{initials(t?.title ?? '')}</span>
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
      </header>

      {farFromBottom && (
        <button className="jump glass" onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}>
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
