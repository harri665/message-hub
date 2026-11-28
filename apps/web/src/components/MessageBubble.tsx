import { useState, type CSSProperties } from 'react';
import type { Attachment, Message } from '../api.ts';
import { SERVICE_LABEL } from '../api.ts';
import { clock, fileSize, fullTime, serviceClass } from '../format.ts';

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g;

function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noreferrer noopener">{p}</a>
        ) : (
          p
        ),
      )}
    </>
  );
}

function ImageAttachment({ a, src, box, onOpenImage }: {
  a: Attachment; src: string; box: CSSProperties; onOpenImage: (src: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const url = attempt ? `${src}?retry=${attempt}` : src;
  // Bubbles show a 640px-wide copy made by the server; the full photo loads only when opened.
  const thumb = `${url}${url.includes('?') ? '&' : '?'}w=640`;
  if (failed) {
    return (
      <div className="att-missing" style={{ ...box, aspectRatio: undefined }}>
        <span>Photo didn't load</span>
        <button type="button" className="link-btn" onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <button type="button" className="att-media" style={box} onClick={() => onOpenImage(url)} aria-label={`Open ${a.filename ?? 'photo'}`}>
      <img src={thumb} alt={a.filename ?? 'Image'} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </button>
  );
}

function AttachmentView({ a, onOpenImage }: { a: Attachment; onOpenImage: (src: string) => void }) {
  const src = `/api/attachments/${a.id}`;
  const mime = a.mime ?? '';
  // Reserve the final box before the file loads so the list doesn't jump; tiny images get a readable minimum.
  const box = {
    width: `${Math.max(Math.min(a.width ?? 320, 320), 120)}px`,
    maxWidth: '100%',
    ...(a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : {}),
  };
  if (mime.startsWith('image/')) {
    return <ImageAttachment a={a} src={src} box={box} onOpenImage={onOpenImage} />;
  }
  if (mime.startsWith('video/')) {
    return <video className="att-media" src={src} controls preload="metadata" style={box} />;
  }
  if (mime.startsWith('audio/')) {
    return <audio className="att-audio" src={src} controls preload="none" />;
  }
  return (
    <a className="att-file" href={src} target="_blank" rel="noreferrer" download={a.filename ?? undefined}>
      <span className="att-name">{a.filename ?? 'File'}</span>
      <span className="att-size">{fileSize(a.size)}</span>
    </a>
  );
}

/** A map-pin style glyph, drawn here so it follows the text colour. */
export function PinGlyph({ className, title }: { className?: string; title?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="12" height="12" role="img" aria-label={title} fill="currentColor">
      {title && <title>{title}</title>}
      <path d="M5 1.5h6l-.7 1.2v3.3l2 2.3v1H8.8V14L8 15l-.8-1V9.3H3v-1l2-2.3V2.7z" />
    </svg>
  );
}

function statusText(m: Message) {
  if (m.status === 'failed') return 'Not delivered';
  if (m.read_at) return `Read ${clock(m.read_at)}`;
  if (m.delivered_at) return 'Delivered';
  return 'Sent';
}

export function MessageBubble({
  m, isGroup, firstInRun, lastInRun, showStatus, highlighted, onReply, onTogglePin, onOpenImage,
}: {
  m: Message; isGroup: boolean; firstInRun: boolean; lastInRun: boolean; showStatus: boolean; highlighted?: boolean; onReply: () => void; onTogglePin: () => void;
  onOpenImage: (src: string) => void;
}) {
  if (m.kind === 'system') {
    return (
      <p className={`system-msg ${highlighted ? 'hit' : ''}`} data-mid={m.id}>
        {m.from_me ? 'You' : m.sender_name ?? 'Someone'} {m.body}
      </p>
    );
  }
  const side = m.from_me ? 'out' : 'in';
  const hasText = !!m.body && !m.unsent;
  return (
    <div
      className={`msg ${side} ${serviceClass(m.service)} ${firstInRun ? 'first' : ''} ${lastInRun ? 'last' : ''} ${highlighted ? 'hit' : ''} ${m.pinned_at ? 'pinned' : ''}`}
      data-mid={m.id}
    >
      {isGroup && !m.from_me && firstInRun && <span className="msg-sender">{m.sender_name}</span>}
      <div className="msg-row">
        <div className={`msg-stack ${m.reactions.length ? 'has-reactions' : ''}`} title={`${fullTime(m.sent_at)} via ${SERVICE_LABEL[m.service]}`}>
          {m.reply_to_id && (
            <div className="msg-quote">
              <span className="quote-name">{m.reply_to_from_me ? 'You' : m.reply_to_name ?? 'Someone'}</span>
              <span className="quote-body">{m.reply_to_body ?? 'Attachment'}</span>
            </div>
          )}
          {m.attachments.map((a) => (
            <AttachmentView key={a.id} a={a} onOpenImage={onOpenImage} />
          ))}
          {m.pinned_at && !m.unsent && <PinGlyph className="pin-mark" title="Pinned" />}
          {m.unsent && <div className="bubble unsent">Message unsent</div>}
          {hasText && (
            <div className="bubble">
              <Linkified text={m.body!} />
              {m.edited_at && <span className="edited"> (edited)</span>}
            </div>
          )}
          {m.reactions.length > 0 && (
            <div className="reactions glass" aria-label="Reactions">
              {m.reactions.map((r, i) => (
                <span key={i} className={`reaction ${r.fromMe ? 'mine' : ''}`} title={r.fromMe ? 'You' : r.name ?? ''}>
                  {r.emoji}
                </span>
              ))}
            </div>
          )}
        </div>
        <button className="msg-action" onClick={onReply} aria-label="Reply">Reply</button>
        {!m.unsent && (
          <button className="msg-action" onClick={onTogglePin} aria-label={m.pinned_at ? 'Unpin' : 'Pin'}>
            {m.pinned_at ? 'Unpin' : 'Pin'}
          </button>
        )}
      </div>
      {(lastInRun || showStatus) && (
        <span className="msg-meta">
          {clock(m.sent_at)}
          {showStatus && m.from_me && <>, {statusText(m)}</>}
        </span>
      )}
    </div>
  );
}
