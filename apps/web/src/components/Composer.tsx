import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, SERVICE_LABEL, type Message, type ThreadDetail } from '../api.ts';
import { serviceClass } from '../format.ts';

export function Composer({
  tid, thread, replyTo, onClearReply,
}: { tid: string; thread: ThreadDetail; replyTo: Message | null; onClearReply: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default to the conversation with the most recent activity; a reply goes back where the original came from.
  const [convId, setConvId] = useState<number>(thread.conversations[0]?.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (replyTo) {
      setConvId(replyTo.conversation_id);
      areaRef.current?.focus();
    }
  }, [replyTo]);

  const conv = thread.conversations.find((c) => c.id === convId) ?? thread.conversations[0];
  const label = conv ? SERVICE_LABEL[conv.lastService] : '';

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['messages', tid] });
    qc.invalidateQueries({ queryKey: ['threads'] });
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.send(tid, { text: body, conversationId: conv?.id, replyToId: replyTo?.id });
      setText('');
      onClearReply();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Message not sent');
    } finally {
      setBusy(false);
      areaRef.current?.focus();
    }
  };

  const sendFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      await api.sendFile(tid, file, conv?.id, text.trim() || undefined);
      setText('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'File not sent');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape' && replyTo) onClearReply();
  };

  if (!conv) return null;

  return (
    <form className={`composer ${serviceClass(conv.lastService)}`} onSubmit={send}>
      {replyTo && (
        <div className="composer-reply">
          <span>
            Replying to {replyTo.from_me ? 'yourself' : replyTo.sender_name ?? 'message'}: <em>{replyTo.body?.slice(0, 80) ?? 'Attachment'}</em>
          </span>
          <button type="button" className="text-btn" onClick={onClearReply}>Cancel</button>
        </div>
      )}
      {thread.conversations.length > 1 && (
        <div className="send-via" role="radiogroup" aria-label="Send with">
          {thread.conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={c.id === conv.id}
              className={`via ${serviceClass(c.lastService)} ${c.id === conv.id ? 'on' : ''}`}
              onClick={() => setConvId(c.id)}
            >
              {SERVICE_LABEL[c.lastService]}
            </button>
          ))}
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="composer-row">
        <button type="button" className="text-btn attach" onClick={() => fileRef.current?.click()} disabled={busy}>
          Attach
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => e.target.files?.[0] && sendFile(e.target.files[0])}
        />
        <textarea
          ref={areaRef}
          rows={1}
          value={text}
          placeholder={`${label} message`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          aria-label={`Write a ${label} message`}
        />
        <button className="btn-send" disabled={busy || !text.trim()}>
          {busy ? 'Sending' : 'Send'}
        </button>
      </div>
    </form>
  );
}
