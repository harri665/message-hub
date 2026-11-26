import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, SERVICE_LABEL, type SendRequest } from '../api.ts';
import { clock, listTime } from '../format.ts';

/** Messages Claude asked to send. Nothing leaves until the user chooses Send here. */
export function SendApprovals() {
  const qc = useQueryClient();
  // Live events refresh this right away; the interval covers a dropped WebSocket.
  const { data } = useQuery({ queryKey: ['send-requests'], queryFn: () => api.sendRequests('pending'), refetchInterval: 20_000 });
  const [notices, setNotices] = useState<string[]>([]);
  const seen = useRef<Set<number> | null>(null);

  useEffect(() => {
    if (!data) return;
    const fresh = data.filter((r) => !seen.current?.has(r.id));
    // The first load only records what was already waiting.
    if (seen.current && fresh.length && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
      const r = fresh[0];
      const n = new Notification('Claude wants to send a message', {
        body: `To ${r.thread_title ?? 'a conversation'}: ${r.text}`, tag: 'send-request',
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
    seen.current = new Set(data.map((r) => r.id));
  }, [data]);

  if (!data?.length && !notices.length) return null;
  const pending = data ?? [];
  return (
    <aside className="approvals glass" role="region" aria-label="Messages waiting for approval">
      <h2>{pending.length === 0 ? 'Message not sent' : pending.length === 1 ? 'Claude wants to send a message' : `Claude wants to send ${pending.length} messages`}</h2>
      {pending.length > 0 && <p className="note">Nothing is sent until you choose Send.</p>}
      {notices.map((n, i) => (
        <p key={i} className="form-error" role="alert">{n}</p>
      ))}
      {notices.length > 0 && pending.length === 0 && (
        <div className="approval-actions" style={{ paddingBottom: 10 }}>
          <button className="pill-btn" onClick={() => setNotices([])}>Dismiss</button>
        </div>
      )}
      {pending.map((r) => (
        <Request
          key={r.id}
          r={r}
          onNotice={(n) => setNotices((x) => [...x, n])}
          onDone={() => qc.invalidateQueries({ queryKey: ['send-requests'] })}
        />
      ))}
    </aside>
  );
}

function Request({ r, onDone, onNotice }: { r: SendRequest; onDone: () => void; onNotice: (n: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (kind: 'approve' | 'reject') => (kind === 'approve' ? api.approveSendRequest(r.id) : api.rejectSendRequest(r.id)),
    onSuccess: (res) => {
      if (res.status === 'failed') onNotice(`The message to ${r.thread_title ?? 'a conversation'} was not sent: ${res.error ?? 'unknown error'}`);
      onDone();
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : 'Something went wrong';
      setError(msg);
      onNotice(msg);
      onDone();
    },
  });
  return (
    <div className="approval">
      <div className="approval-to">
        To {r.thread_title ?? 'Unknown'} <span className="value">{SERVICE_LABEL[r.service]}, asked {listTime(r.created_at)} {clock(r.created_at)}</span>
      </div>
      {r.reply_to_message_id && (
        <p className="approval-reply">
          Replying to {r.reply_to_from_me ? 'your message' : 'their message'}{r.reply_to_body ? `: "${r.reply_to_body}"` : ''}
        </p>
      )}
      <p className="approval-text">{r.text}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="approval-actions">
        <button className="pill-btn" disabled={act.isPending} onClick={() => act.mutate('reject')}>Don't send</button>
        <button className="pill-btn primary" disabled={act.isPending} onClick={() => act.mutate('approve')}>
          {act.isPending ? 'Sending' : 'Send'}
        </button>
      </div>
    </div>
  );
}
