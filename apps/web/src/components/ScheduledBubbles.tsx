import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Scheduled } from '../api.ts';
import { serviceClass, sendsLabel } from '../format.ts';
import { ScheduleDialog } from './ScheduleDialog.tsx';

export function ClockGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.3 1.4" />
    </svg>
  );
}

/** Messages waiting to be sent, shown below the conversation as dimmed outgoing bubbles. */
export function ScheduledBubbles({ items }: { items: Scheduled[] }) {
  // The labels say "tomorrow" and "today", so re-render once a minute.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!items.length) return;
    const t = window.setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [items.length]);
  return <>{items.map((s) => <ScheduledBubble key={s.id} s={s} />)}</>;
}

function ScheduledBubble({ s }: { s: Scheduled }) {
  const qc = useQueryClient();
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState<'both' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const failed = s.status === 'failed';
  const sending = s.status === 'sending';

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => !wrap.current?.contains(e.target as Node) && setMenu(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menu]);

  const run = async (fn: () => Promise<unknown>) => {
    setMenu(false);
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['scheduled'] });
      qc.invalidateQueries({ queryKey: ['messages', s.tid] });
    }
  };

  return (
    <div className={`msg out first last scheduled ${serviceClass(s.service)} ${failed ? 'failed' : ''}`}>
      <div className="msg-row">
        <div className="msg-stack">
          <div className="bubble">{s.text}</div>
        </div>
        {!sending && (
          <div className="sched-menu-wrap" ref={wrap}>
            <button className="msg-action sched-more" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-haspopup="menu" aria-label="Scheduled message options" disabled={busy}>
              More
            </button>
            {menu && (
              <div className="sched-menu glass" role="menu">
                <button role="menuitem" onClick={() => setEditing('both')}>{failed ? 'Edit and reschedule' : 'Edit text or time'}</button>
                <button role="menuitem" onClick={() => run(() => api.sendScheduledNow(s.id))}>{failed ? 'Retry now' : 'Send now'}</button>
                <button role="menuitem" className="danger" onClick={() => run(() => api.cancelScheduled(s.id))}>{failed ? 'Discard' : 'Cancel'}</button>
              </div>
            )}
          </div>
        )}
      </div>
      <span className={`msg-meta sched-meta ${failed ? 'bad' : ''}`}>
        <ClockGlyph />
        {sending ? ' Sending…' : failed ? ` ${s.error || 'Not sent'}` : ` Sends ${sendsLabel(s.sendAt)}`}
        {!failed && !sending && s.error && s.retryAt ? ` (${s.error}; trying again soon)` : ''}
        {failed && (
          <>
            <button className="link-btn retry" disabled={busy} onClick={() => run(() => api.sendScheduledNow(s.id))}>Retry</button>
            <button className="link-btn" disabled={busy} onClick={() => run(() => api.cancelScheduled(s.id))}>Discard</button>
          </>
        )}
        {error && <span className="sched-error" role="alert"> {error}</span>}
      </span>
      {editing && (
        <ScheduleDialog
          title="Edit scheduled message"
          submitLabel={failed ? 'Reschedule' : 'Save'}
          text={s.text}
          editableText
          initial={new Date(s.sendAt)}
          onClose={() => setEditing(null)}
          onSubmit={async (text, at) => {
            await api.editScheduled(s.id, { text, sendAt: at.toISOString() });
            setEditing(null);
            qc.invalidateQueries({ queryKey: ['scheduled'] });
          }}
        />
      )}
    </div>
  );
}
