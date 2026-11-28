import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { SERVICE_LABEL, type Message, type ThreadDetail } from '../api.ts';
import { caretOffset, findComplete, findTrigger, searchEmoji } from '../emoji/emoji.ts';
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
  // :emoji: shortcodes. `caret` follows the cursor; `closed` remembers an Esc so the popup stays shut for that word.
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState<number | null>(null);
  const nextCaret = useRef<number | null>(null);
  const trigger = useMemo(() => (closed === null ? findTrigger(text, caret) : null), [text, caret, closed]);
  const matches = useMemo(() => (trigger ? searchEmoji(trigger.query) : []), [trigger]);
  const popupOpen = matches.length > 0;
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  useLayoutEffect(() => {
    if (nextCaret.current !== null && areaRef.current) {
      areaRef.current.setSelectionRange(nextCaret.current, nextCaret.current);
      nextCaret.current = null;
    }
  });
  useLayoutEffect(() => {
    const a = areaRef.current;
    if (!popupOpen || !trigger || !a) return setPos(null);
    const r = a.getBoundingClientRect();
    const c = caretOffset(a, trigger.start);
    setPos({ left: Math.max(8, Math.min(r.left + c.left, window.innerWidth - 280)), bottom: window.innerHeight - (r.top + c.top) + 6 });
  }, [popupOpen, trigger, text]);
  useEffect(() => setActive(0), [trigger?.query]);

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

  const track = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.target;
    let value = el.value;
    let at = el.selectionStart ?? value.length;
    // A finished ":smile:" turns into the emoji right away.
    const done = findComplete(value, at);
    if (done) {
      value = value.slice(0, done.start) + done.emoji + value.slice(at);
      at = done.start + done.emoji.length;
      nextCaret.current = at;
    }
    setText(value);
    setCaret(at);
    setClosed(null);
  };

  const pick = (i: number) => {
    const m = matches[i];
    if (!m || !trigger) return;
    const after = text.slice(caret);
    const gap = /^\s/.test(after) ? '' : ' ';
    const next = text.slice(0, trigger.start) + m.emoji + gap + after;
    nextCaret.current = trigger.start + m.emoji.length + gap.length;
    setText(next);
    setCaret(nextCaret.current);
    areaRef.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (popupOpen && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(active);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setClosed(trigger?.start ?? 0);
        return;
      }
    }
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
          onChange={onChange}
          onKeyDown={onKey}
          onKeyUp={(e) => track(e.currentTarget)}
          onClick={(e) => track(e.currentTarget)}
          onBlur={() => setClosed(trigger?.start ?? null)}
          aria-label={`Write a ${label} message`}
        />
        <button className="pill-btn btn-send" disabled={!text.trim()}>Send</button>
      </div>
      {popupOpen && pos && createPortal(
        <ul className="emoji-popup glass" role="listbox" aria-label="Emoji" style={{ left: pos.left, bottom: pos.bottom }}>
          {matches.map((m, i) => (
            <li
              key={m.name}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => { e.preventDefault(); pick(i); }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="emoji-glyph">{m.emoji}</span>
              <span className="emoji-name">:{m.shown}:</span>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </form>
  );
});
