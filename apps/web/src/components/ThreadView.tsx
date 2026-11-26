import { Fragment, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, SERVICE_LABEL, type Message } from '../api.ts';
import { dayLabel, initials, sameDay, serviceClass } from '../format.ts';
import { MessageBubble } from './MessageBubble.tsx';
import { Composer } from './Composer.tsx';

const PAGE = 60;

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

  // Oldest first, across all loaded pages.
  const list = useMemo(() => {
    const pages = messages.data?.pages ?? [];
    return [...pages].reverse().flat();
  }, [messages.data]);

  const newestId = list[list.length - 1]?.id;
  const unread = (qc.getQueryData<any[]>(['threads']) ?? []).find((t) => t.tid === tid)?.unread ?? 0;
  useEffect(() => {
    if (document.hidden) return;
    api.markRead(tid).then(() => qc.invalidateQueries({ queryKey: ['threads'] })).catch(() => {});
  }, [tid, newestId, unread, qc]);
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) api.markRead(tid).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [tid]);

  const t = thread.data;
  const services = Array.from(new Set(t?.conversations.map((c) => c.lastService) ?? []));
  const lastFromMeId = [...list].reverse().find((m) => m.from_me && m.kind === 'text')?.id;

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // column-reverse: scrollTop is 0 at the bottom and negative going up.
    if (el.scrollHeight + el.scrollTop - el.clientHeight < 400 && messages.hasNextPage && !messages.isFetchingNextPage) {
      messages.fetchNextPage();
    }
  };

  return (
    <section className="thread" aria-label={t?.title ?? 'Conversation'}>
      <header className="thread-head">
        <button className="text-btn back" onClick={onBack}>Back</button>
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
            {t?.isGroup && t.members.length > 0 && <span className="muted"> with {t.members.length} people</span>}
          </p>
        </div>
      </header>

      <div className="messages" onScroll={onScroll}>
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
                {newDay && (
                  <div className="day-sep">
                    <span>{dayLabel(m.sent_at)}</span>
                  </div>
                )}
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
                  showStatus={m.id === lastFromMeId}
                  onReply={() => setReplyTo(m)}
                />
              </Fragment>
            );
          })}
        </div>
      </div>

      {t && <Composer tid={tid} thread={t} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />}
    </section>
  );
}
