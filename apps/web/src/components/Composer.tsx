import { forwardRef, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { SERVICE_LABEL, type Message, type ThreadDetail } from '../api.ts';
import { serviceClass } from '../format.ts';
import type { Pending } from './ThreadView.tsx';

interface Props {
  thread: ThreadDetail;
  replyTo: Message | null;
  onClearReply: () => void;
  onSend: (p: Omit<Pending, 'key' | 'status'>) => void;
}

export const Composer = forwardRef<HTMLFormElement, Props>(function Composer({ thread, replyTo, onClearReply, onSend }, ref) {
  const [text, setText] = useState('');
  // Default to the conversation with the most recent activity; a reply goes back where the original came from.
  const [convId, setConvId] = useState<number>(thread.conversations[0]?.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);
  useEffect(() => {
    if (replyTo) {
      setConvId(replyTo.conversation_id);
      areaRef.current?.focus();
    }
  }, [replyTo]);

  const conv = thread.conversations.find((c) => c.id === convId) ?? thread.conversations[0];
  if (!conv) return null;
  const label = SERVICE_LABEL[conv.lastService];

  // The box clears immediately and the message shows as "Sending…", so it can't be sent twice by accident.
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    onSend({ text: body, conversationId: conv.id, service: conv.lastService, replyToId: replyTo?.id });
    setText('');
    onClearReply();
    areaRef.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape' && replyTo) onClearReply();
  };

  return (
    <form ref={ref} className={`composer glass ${serviceClass(conv.lastService)}`} onSubmit={submit}>
      {replyTo && (
        <div className="composer-reply">
          <span>
            Replying to {replyTo.from_me ? 'yourself' : replyTo.sender_name ?? 'message'}: <em>{replyTo.body?.slice(0, 80) ?? 'Attachment'}</em>
          </span>
          <button type="button" className="link-btn" onClick={onClearReply}>Cancel</button>
        </div>
      )}
      <div className="composer-row">
        {thread.conversations.length > 1 && (
          <div className="segmented" role="radiogroup" aria-label="Send with">
            {thread.conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={c.id === conv.id}
                className={serviceClass(c.lastService)}
                onClick={() => setConvId(c.id)}
              >
                {SERVICE_LABEL[c.lastService]}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="pill-btn" onClick={() => fileRef.current?.click()}>Attach</button>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onSend({ file, text: text.trim() || undefined, conversationId: conv.id, service: conv.lastService });
            setText('');
            e.target.value = '';
          }}
        />
        <textarea
          ref={areaRef}
          rows={1}
          value={text}
          placeholder={label}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          aria-label={`Write a ${label} message`}
        />
        <button className="pill-btn btn-send" disabled={!text.trim()}>Send</button>
      </div>
    </form>
  );
});
