import { Fragment, useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type AiAnswer, type MeaningHit } from '../api.ts';
import { listTime } from '../format.ts';

/** Shown under the word search when AI features are on: messages that match by meaning, and an answer on request. */
export function AiSearch({ query, onOpen }: { query: string; onOpen: (tid: string, messageId?: number) => void }) {
  // Wait for a pause in typing, so every keystroke doesn't become a request.
  const [settled, setSettled] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSettled(query), 600);
    return () => clearTimeout(t);
  }, [query]);
  const hits = useQuery({
    queryKey: ['ai-search', settled],
    queryFn: () => api.aiSearch(settled),
    enabled: settled.length >= 3,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const askQ = useMutation({ mutationFn: (q: string) => api.aiAsk(q) });
  const answered = askQ.data && askQ.variables === query ? askQ.data : null;
  const shown = (hits.data ?? []).filter((h) => h.score >= 0.3).slice(0, 8);
  if (query.length < 3) return null;

  return (
    <section className="search-results ai-results" aria-label="Matches by meaning">
      <div className="ai-head">
        <h2>By meaning</h2>
        <button
          type="button"
          className="pill-btn"
          onClick={() => askQ.mutate(query)}
          disabled={askQ.isPending}
          title="An AI answer from your messages, with the messages it used"
        >
          {askQ.isPending ? 'Asking' : 'Ask AI'}
        </button>
      </div>
      {askQ.isError && askQ.variables === query && <p className="list-note">{askQ.error.message}</p>}
      {answered && <AnswerCard a={answered} onOpen={onOpen} />}
      {settled !== query || hits.isPending ? (
        <p className="list-note">Searching by meaning</p>
      ) : hits.isError ? (
        <p className="list-note">{hits.error.message}</p>
      ) : !shown.length ? (
        <p className="list-note">Nothing close in meaning yet. Messages are indexed in the background.</p>
      ) : (
        shown.map((h) => <HitRow key={h.chunkId} h={h} onOpen={onOpen} />)
      )}
    </section>
  );
}

function HitRow({ h, onOpen, n }: { h: MeaningHit; onOpen: (tid: string, messageId?: number) => void; n?: number }) {
  const text = h.text.split('\n').slice(0, 3).join(' · ');
  return (
    <button className="search-row" onClick={() => onOpen(h.tid, h.messageId)}>
      <span className="thread-top">
        <span className="thread-title">{n ? `[${n}] ` : ''}{h.threadTitle}</span>
        <time className="thread-time">{listTime(h.firstSentAt)}</time>
      </span>
      <span className="search-body ai-snippet">{text.length > 220 ? `${text.slice(0, 220)}…` : text}</span>
    </button>
  );
}

/** The answer, with its [1] [2] citations as links to the messages they came from. */
function AnswerCard({ a, onOpen }: { a: AiAnswer; onOpen: (tid: string, messageId?: number) => void }) {
  const byN = new Map(a.sources.map((s) => [s.n, s]));
  return (
    <div className="ai-answer">
      <p>
        {a.answer.split(/(\[\d+\])/).map((part, i) => {
          const n = Number(part.match(/^\[(\d+)\]$/)?.[1]);
          const s = byN.get(n);
          return s ? (
            <button key={i} type="button" className="cite" onClick={() => onOpen(s.tid, s.messageId)} title={`${s.threadTitle}, ${listTime(s.firstSentAt)}`}>
              {n}
            </button>
          ) : (
            <Fragment key={i}>{part}</Fragment>
          );
        })}
      </p>
      {a.sources.length > 0 && (
        <details>
          <summary>From {a.sources.length} conversation{a.sources.length === 1 ? '' : 's'}</summary>
          {a.sources.map((s) => <HitRow key={s.chunkId} h={s} n={s.n} onOpen={onOpen} />)}
        </details>
      )}
      <p className="ai-meta">AI answer{a.model ? ` (${a.model.split('/').pop()})` : ''}. Check the messages before relying on it.</p>
    </div>
  );
}
