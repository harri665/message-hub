import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { Attachment, Message } from '../api.ts';
import { api, SERVICE_LABEL } from '../api.ts';
import { clock, fileSize, fullTime, serviceClass } from '../format.ts';
import { LinkCard, useLinkPreview } from './LinkPreview.tsx';
import { useLongPress } from '../longPress.ts';

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g;

/** A long link is shown shortened ("example.com/some/long/pa..."); the whole address stays in the href and tooltip. */
function shortLink(url: string) {
  const t = url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  return t.length > 48 ? `${t.slice(0, 46)}…` : t;
}

function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noreferrer noopener" title={p}>{shortLink(p)}</a>
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
    <button
      type="button"
      className="att-media"
      style={box}
      onClick={() => onOpenImage(url)}
      aria-label={`Open ${a.description ? `photo: ${a.description}` : (a.filename ?? 'photo')}`}
      title={a.description ? `AI description: ${a.description}` : undefined}
    >
      <img src={thumb} alt={a.description ?? a.filename ?? 'Image'} loading="lazy" decoding="async" onError={() => setFailed(true)} />
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

function statusText(m: Message) {
  if (m.status === 'failed') return 'Not delivered';
  if (m.read_at) return `Read ${clock(m.read_at)}`;
  if (m.delivered_at) return 'Delivered';
  return 'Sent';
}

/** Sends my reaction to a message. Picking my current reaction again removes it. */
function useReact(m: Message, onDone: () => void) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mine = m.reactions.find((r) => r.fromMe)?.emoji ?? null;
  const pick = async (emoji: string) => {
    setBusy(emoji);
    setError(null);
    try {
      await api.react(m.id, emoji === mine ? null : emoji);
      await qc.invalidateQueries({ queryKey: ['messages'] });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not react');
    } finally {
      setBusy(null);
    }
  };
  return { mine, busy, error, pick };
}

function ReactionRow({ choices, mine, busy, pick }: { choices: string[]; mine: string | null; busy: string | null; pick: (e: string) => void }) {
  return (
    <div className="react-choices" role="group" aria-label="React">
      {choices.map((e) => (
        <button
          key={e}
          type="button"
          role="menuitemradio"
          aria-checked={e === mine}
          className={e === mine ? 'mine' : ''}
          disabled={!!busy}
          onClick={() => pick(e)}
          title={e === mine ? 'Remove your reaction' : undefined}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/** Picks my reaction. iMessage offers its six tapbacks, WhatsApp a row of common emoji. Picking the current one removes it. */
function ReactionPicker({ m, choices, onClose }: { m: Message; choices: string[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { mine, busy, error, pick } = useReact(m, onClose);

  useEffect(() => {
    // The React button toggles the picker itself, so clicks on it don't count as outside.
    const onDown = (e: PointerEvent) => !ref.current?.parentElement?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="react-picker glass" role="menu" aria-label="React">
      <ReactionRow choices={choices} mine={mine} busy={busy} pick={pick} />
      {busy && <p className="note">Sending</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

/**
 * The message menu, opened by right-clicking a message or pressing and holding it on a touch screen: the reactions
 * on top, then Reply and Copy. It opens at the pointer and is kept inside the window.
 */
function MessageMenu({ m, at, link, choices, onReply, onClose }: {
  m: Message; at: { x: number; y: number }; link: string | null; choices?: string[]; onReply: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { mine, busy, error, pick } = useReact(m, onClose);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      x: Math.max(pad, Math.min(at.x, window.innerWidth - r.width - pad)),
      y: at.y + r.height + pad > window.innerHeight ? Math.max(pad, at.y - r.height) : at.y,
    });
  }, [at]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onScroll = () => onClose();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    document.addEventListener('scroll', onScroll, true);
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    onClose();
  };
  const canReact = !m.unsent && !!choices?.length;
  return createPortal(
    <div ref={ref} className="msg-menu glass" role="menu" aria-label="Message" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {canReact && <ReactionRow choices={choices!} mine={mine} busy={busy} pick={pick} />}
      {busy && <p className="note">Sending</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="msg-menu-items">
        <button type="button" role="menuitem" onClick={() => { onReply(); onClose(); }}>Reply</button>
        {!m.unsent && !!m.body && <button type="button" role="menuitem" onClick={() => copy(m.body!)}>Copy</button>}
        {link && <button type="button" role="menuitem" onClick={() => copy(link)}>Copy Link</button>}
      </div>
    </div>,
    document.body,
  );
}

/** Right-click, or press and hold on a touch screen, opens the message menu. */
function useMessageMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; link: string | null } | null>(null);
  const handlers = useLongPress((x, y, target) => {
    const a = (target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    setMenu({ x, y, link: a?.href ?? null });
  });
  const close = useCallback(() => setMenu(null), []);
  return { menu, close, handlers };
}

export function MessageBubble({
  m, isGroup, firstInRun, lastInRun, showStatus, highlighted, onReply, onOpenImage, reactionChoices,
}: {
  m: Message; isGroup: boolean; firstInRun: boolean; lastInRun: boolean; showStatus: boolean; highlighted?: boolean; onReply: () => void;
  onOpenImage: (src: string) => void;
  /** Reactions this message's service can send; none while they're loading. */
  reactionChoices?: string[];
}) {
  const [picking, setPicking] = useState(false);
  const { menu, close: closeMenu, handlers: menuHandlers } = useMessageMenu();
  if (m.kind === 'system') {
    return (
      <p className={`system-msg ${highlighted ? 'hit' : ''}`} data-mid={m.id}>
        {m.from_me ? 'You' : m.sender_name ?? 'Someone'} {m.body}
      </p>
    );
  }
  const side = m.from_me ? 'out' : 'in';
  // A link with a preview shows as a card; the text bubble keeps only the words around it.
  const card = useLinkPreview(m);
  const text = card ? card.rest : m.body;
  const hasText = !!text && !m.unsent;
  return (
    <div
      className={`msg ${side} ${serviceClass(m.service)} ${firstInRun ? 'first' : ''} ${lastInRun ? 'last' : ''} ${highlighted ? 'hit' : ''} ${menu ? 'menu-open' : ''}`}
      data-mid={m.id}
    >
      {isGroup && !m.from_me && firstInRun && <span className="msg-sender">{m.sender_name}</span>}
      <div className="msg-row">
        <div
          className={`msg-stack ${m.reactions.length ? 'has-reactions' : ''}`}
          title={`${fullTime(m.sent_at)} via ${SERVICE_LABEL[m.service]}`}
          {...menuHandlers}
        >
          {m.reply_to_id && (
            <div className="msg-quote">
              <span className="quote-name">{m.reply_to_from_me ? 'You' : m.reply_to_name ?? 'Someone'}</span>
              <span className="quote-body">{m.reply_to_body ?? 'Attachment'}</span>
            </div>
          )}
          {m.attachments.map((a) => (
            <AttachmentView key={a.id} a={a} onOpenImage={onOpenImage} />
          ))}
          {m.unsent && <div className="bubble unsent">Message unsent</div>}
          {hasText && (
            <div className="bubble">
              <Linkified text={text!} />
              {m.edited_at && <span className="edited"> (edited)</span>}
            </div>
          )}
          {card && <LinkCard p={card} />}
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
        <div className={`msg-actions ${picking ? 'open' : ''}`}>
          {!m.unsent && !!reactionChoices?.length && (
            <button className="msg-action" onClick={() => setPicking((p) => !p)} aria-expanded={picking} aria-label="React">React</button>
          )}
          <button className="msg-action" onClick={onReply} aria-label="Reply">Reply</button>
          {picking && reactionChoices && <ReactionPicker m={m} choices={reactionChoices} onClose={() => setPicking(false)} />}
        </div>
      </div>
      {menu && <MessageMenu m={m} at={menu} link={menu.link} choices={reactionChoices} onReply={onReply} onClose={closeMenu} />}
      {(lastInRun || showStatus) && (
        <span className="msg-meta">
          {clock(m.sent_at)}
          {showStatus && m.from_me && <>, {statusText(m)}</>}
        </span>
      )}
    </div>
  );
}
