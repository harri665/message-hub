import { forwardRef, useCallback, useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import { api, SERVICE_LABEL, type Message, type ThreadDetail } from '../api.ts';
import { fileSize, serviceClass } from '../format.ts';
import { getDraft, setDraft } from '../stores.ts';
import type { Pending } from './ThreadView.tsx';

interface Props {
  thread: ThreadDetail;
  replyTo: Message | null;
  onClearReply: () => void;
  onSend: (p: Omit<Pending, 'key' | 'status'>) => void;
}

interface Staged { id: string; file: File; preview: string | null }

const MAX_FILES = 10;
const MAX_BYTES = 100 * 1024 * 1024;

export const Composer = forwardRef<HTMLFormElement, Props>(function Composer({ thread, replyTo, onClearReply, onSend }, ref) {
  const tid = thread.tid;
  const [text, setText] = useState(() => getDraft(tid));
  const [staged, setStaged] = useState<Staged[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Default to the conversation with the most recent activity; a reply goes back where the original came from.
  const [convId, setConvId] = useState<number>(thread.conversations[0]?.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const conv = thread.conversations.find((c) => c.id === convId) ?? thread.conversations[0];

  // ---------- typing indicator: "typing" repeats every 3 s while keys are pressed, "stopped" after 5 s of quiet ----------
  const typingRef = useRef<{ on: boolean; at: number; conv: number | null; idle?: number }>({ on: false, at: 0, conv: null });
  const stopTyping = useCallback(() => {
    const t = typingRef.current;
    if (t.idle) clearTimeout(t.idle);
    if (t.on && t.conv) api.typing(tid, t.conv, false).catch(() => {});
    typingRef.current = { on: false, at: 0, conv: null };
  }, [tid]);
  const noteTyping = useCallback((value: string, audio = false) => {
    if (!conv) return;
    const t = typingRef.current;
    if (!value.trim() && !audio) return stopTyping();
    if (t.on && t.conv !== conv.id) stopTyping();
    const now = Date.now();
    if (!typingRef.current.on || now - typingRef.current.at > 3000) {
      api.typing(tid, conv.id, true, audio).catch(() => {});
      typingRef.current = { on: true, at: now, conv: conv.id };
    }
    if (typingRef.current.idle) clearTimeout(typingRef.current.idle);
    if (!audio) typingRef.current.idle = window.setTimeout(stopTyping, 5000);
  }, [conv, tid, stopTyping]);
  useEffect(() => stopTyping, [stopTyping]);

  useEffect(() => {
    areaRef.current?.focus();
    const el = areaRef.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    if (replyTo) {
      setConvId(replyTo.conversation_id);
      areaRef.current?.focus();
    }
  }, [replyTo]);

  // Previews are object URLs: free them when a file is removed or the composer goes away.
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  useEffect(() => () => stagedRef.current.forEach((s) => s.preview && URL.revokeObjectURL(s.preview)), []);

  const addFiles = useCallback((files: File[]) => {
    if (!files.length) return;
    setNotice(null);
    setStaged((cur) => {
      const room = MAX_FILES - cur.length;
      const ok = files.filter((f) => f.size > 0 && f.size <= MAX_BYTES);
      if (ok.length < files.length) setNotice(`Files over ${fileSize(MAX_BYTES)} can't be sent.`);
      if (ok.length > room) setNotice(`Up to ${MAX_FILES} files at a time.`);
      return [
        ...cur,
        ...ok.slice(0, Math.max(0, room)).map((file) => ({
          id: `${Date.now()}-${Math.random()}`,
          file,
          preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        })),
      ];
    });
    areaRef.current?.focus();
  }, []);

  const unstage = (id: string) =>
    setStaged((cur) => {
      const s = cur.find((x) => x.id === id);
      if (s?.preview) URL.revokeObjectURL(s.preview);
      return cur.filter((x) => x.id !== id);
    });

  // Files dropped anywhere on the conversation go into the composer.
  useEffect(() => {
    const zone = formRef.current?.closest('.thread');
    if (!zone) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: Event) => {
      if (!hasFiles(e as DragEvent)) return;
      depth++;
      setDragging(true);
    };
    const over = (e: Event) => {
      if (!hasFiles(e as DragEvent)) return;
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = 'copy';
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: Event) => {
      const d = e as DragEvent;
      if (!hasFiles(d)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      addFiles(Array.from(d.dataTransfer!.files));
    };
    zone.addEventListener('dragenter', enter);
    zone.addEventListener('dragover', over);
    zone.addEventListener('dragleave', leave);
    zone.addEventListener('drop', drop);
    return () => {
      zone.removeEventListener('dragenter', enter);
      zone.removeEventListener('dragover', over);
      zone.removeEventListener('dragleave', leave);
      zone.removeEventListener('drop', drop);
    };
  }, [addFiles]);

  const recorder = useRecorder();

  if (!conv) return null;
  const label = SERVICE_LABEL[conv.lastService];

  const changeText = (value: string) => {
    setText(value);
    setDraft(tid, value);
    noteTyping(value);
  };

  // The box clears immediately and the message shows as "Sending…", so it can't be sent twice by accident.
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body && !staged.length) return;
    stopTyping();
    if (staged.length) {
      // Files go one by one; the text rides along with the last one (as its caption on WhatsApp).
      staged.forEach((s, i) =>
        onSend({ file: s.file, previewUrl: s.preview ?? undefined, text: i === staged.length - 1 ? body || undefined : undefined, conversationId: conv.id, service: conv.lastService }),
      );
      setStaged([]);
    } else {
      onSend({ text: body, conversationId: conv.id, service: conv.lastService, replyToId: replyTo?.id });
    }
    setText('');
    setDraft(tid, '');
    setNotice(null);
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

  // Pasted images and files are attached; pasted text is typed as usual.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `Pasted image ${i + 1}.${f.type.split('/')[1] || 'png'}`, { type: f.type }))));
  };

  const startRecording = async () => {
    setNotice(null);
    const err = await recorder.start();
    if (err) setNotice(err);
    else noteTyping('', true);
  };
  const finishRecording = async () => {
    const rec = await recorder.stop();
    stopTyping();
    if (!rec) return;
    if (rec.seconds < 1) {
      setNotice('That recording was too short.');
      return;
    }
    onSend({ file: rec.file, voice: true, conversationId: conv.id, service: conv.lastService });
  };
  const cancelRecording = () => {
    recorder.cancel();
    stopTyping();
  };

  const setFormRef = (el: HTMLFormElement | null) => {
    formRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  return (
    <form ref={setFormRef} className={`composer glass ${serviceClass(conv.lastService)}`} onSubmit={submit}>
      {dragging && <div className="drop-hint">Drop to attach</div>}
      {replyTo && (
        <div className="composer-reply">
          <span>
            Replying to {replyTo.from_me ? 'yourself' : replyTo.sender_name ?? 'message'}: <em>{replyTo.body?.slice(0, 80) ?? 'Attachment'}</em>
          </span>
          <button type="button" className="link-btn" onClick={onClearReply}>Cancel</button>
        </div>
      )}
      {staged.length > 0 && (
        <ul className="staged" aria-label="Attachments to send">
          {staged.map((s) => (
            <li key={s.id} className="staged-item">
              {s.preview ? <img src={s.preview} alt="" /> : <span className="staged-file">{s.file.name}</span>}
              <span className="staged-size">{fileSize(s.file.size)}</span>
              <button type="button" className="staged-remove" onClick={() => unstage(s.id)} aria-label={`Remove ${s.file.name}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="composer-notice" role="status">{notice}</p>}
      {recorder.state !== 'idle' ? (
        <div className="composer-row recording">
          <button type="button" className="pill-btn" onClick={cancelRecording}>Cancel</button>
          <span className="rec-status" role="status">
            <span className="rec-dot" aria-hidden="true" />
            {recorder.state === 'starting' ? 'Starting microphone' : `Recording ${clockTime(recorder.seconds)}`}
          </span>
          <button type="button" className="pill-btn btn-send" disabled={recorder.state !== 'recording'} onClick={finishRecording}>
            Send voice message
          </button>
        </div>
      ) : (
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
                  onClick={() => {
                    stopTyping();
                    setConvId(c.id);
                  }}
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
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <textarea
            ref={areaRef}
            rows={1}
            value={text}
            placeholder={staged.length ? 'Add a message (optional)' : label}
            onChange={(e) => changeText(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
            onBlur={stopTyping}
            aria-label={`Write a ${label} message`}
          />
          {!text.trim() && !staged.length ? (
            <button type="button" className="pill-btn" onClick={startRecording} title="Record a voice message">Record</button>
          ) : (
            <button className="pill-btn btn-send">Send</button>
          )}
        </div>
      )}
    </form>
  );
});

function clockTime(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Records from the microphone with MediaRecorder. The hub converts the result for each service. */
function useRecorder() {
  const [state, setState] = useState<'idle' | 'starting' | 'recording'>('idle');
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; started: number; tick: number } | null>(null);

  const release = () => {
    const r = rec.current;
    if (!r) return;
    clearInterval(r.tick);
    r.stream.getTracks().forEach((t) => t.stop());
    rec.current = null;
    setState('idle');
    setSeconds(0);
  };
  useEffect(() => () => {
    if (rec.current?.mr.state === 'recording') rec.current.mr.stop();
    release();
  }, []);

  const start = async (): Promise<string | null> => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return 'Voice messages need the secure (https) address of Message Hub.';
    }
    setState('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      setState('idle');
      return e instanceof DOMException && e.name === 'NotAllowedError'
        ? "The microphone is blocked. Allow it for this site in the browser's site settings."
        : 'No microphone was found.';
    }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 48_000 } : undefined);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.start(250);
    const started = Date.now();
    const tick = window.setInterval(() => {
      const s = (Date.now() - started) / 1000;
      setSeconds(s);
      // Long enough for any voice note; keeps uploads reasonable.
      if (s >= 600) mr.stop();
    }, 250);
    rec.current = { mr, stream, chunks, started, tick };
    setState('recording');
    return null;
  };

  const stop = (): Promise<{ file: File; seconds: number } | null> =>
    new Promise((resolve) => {
      const r = rec.current;
      if (!r) return resolve(null);
      const finish = () => {
        const type = r.mr.mimeType || 'audio/webm';
        const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
        const secs = (Date.now() - r.started) / 1000;
        const file = new File(r.chunks, `Voice message.${ext}`, { type: type.split(';')[0] });
        release();
        resolve({ file, seconds: secs });
      };
      if (r.mr.state === 'inactive') return finish();
      r.mr.onstop = finish;
      r.mr.stop();
    });

  const cancel = () => {
    const r = rec.current;
    if (r && r.mr.state !== 'inactive') {
      r.mr.onstop = null;
      r.mr.stop();
    }
    release();
  };

  return { state, seconds, start, stop, cancel };
}
