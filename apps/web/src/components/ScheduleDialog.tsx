import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';
import { browserZone, inZone, localWhen, quickPicks, sendsLabel, toLocalInput } from '../format.ts';

interface Props {
  title: string;
  submitLabel: string;
  /** The message. When editable it is a text box; otherwise it is shown as a preview. */
  text: string;
  editableText?: boolean;
  /** The time to start from (editing); otherwise tomorrow at 9:00. */
  initial?: Date;
  onSubmit: (text: string, at: Date) => Promise<void>;
  onClose: () => void;
}

/** "Schedule message": quick picks and a date and time. Times are in the browser's time zone; the hub's zone is shown when it differs. */
export function ScheduleDialog({ title, submitLabel, text, editableText, initial, onSubmit, onClose }: Props) {
  const hubZone = useQuery({ queryKey: ['status'], queryFn: api.status, staleTime: 5 * 60_000 }).data?.timeZone;
  const zone = browserZone();
  const picks = useMemo(() => quickPicks(), []);
  const [body, setBody] = useState(text);
  const [value, setValue] = useState(() => toLocalInput(initial ?? picks.find((p) => p.label === 'Tomorrow')!.at));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const at = value ? new Date(value) : null;
  const valid = !!at && !Number.isNaN(+at);
  const inPast = valid && +at! < Date.now() + 5_000;

  useEffect(() => {
    sheetRef.current?.querySelector<HTMLElement>('input, textarea')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const submit = async () => {
    if (!valid || inPast || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body.trim(), at!);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not schedule the message');
      setBusy(false);
    }
  };

  const differs = !!hubZone && hubZone !== zone && valid && inZone(at!, hubZone) !== localWhen(at!);

  return createPortal(
    <div className="backdrop" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="sheet glass schedule-sheet" ref={sheetRef}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="pill-btn" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
        {editableText ? (
          <textarea className="field schedule-text" rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} aria-label="Message" />
        ) : (
          <p className="schedule-preview">{text}</p>
        )}
        <div className="schedule-picks" role="group" aria-label="Quick times">
          {picks.map((p) => (
            <button key={p.label} type="button" className={`pill-btn ${value === toLocalInput(p.at) ? 'primary' : ''}`} onClick={() => setValue(toLocalInput(p.at))}>
              {p.label}<span className="pick-time">{sendsLabel(p.at).replace(/^.* at /, '')}</span>
            </button>
          ))}
        </div>
        <label className="schedule-when">
          <span>Date and time</span>
          <input
            className="field"
            type="datetime-local"
            value={value}
            min={toLocalInput(new Date())}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), submit())}
          />
        </label>
        <p className="note schedule-zone" role="status">
          {valid && !inPast ? <>Sends {sendsLabel(at!)}. </> : valid ? 'Pick a time in the future. ' : 'Pick a date and time. '}
          {hubZone && hubZone !== zone ? <>Your time zone is {zone}.{differs && valid ? <> In the hub's time zone ({hubZone}) that is {inZone(at!, hubZone)}.</> : null}</> : <>Time zone: {zone}.</>}
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="sheet-foot">
          <button type="button" className="pill-btn primary" disabled={busy || !valid || inPast || !body.trim()} onClick={submit}>
            {busy ? 'Saving' : submitLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
