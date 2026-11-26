import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../api.ts';
import { listTime } from '../format.ts';

function QR({ code }: { code: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(code, { margin: 1, width: 264, errorCorrectionLevel: 'L' }).then(setUrl).catch(() => setUrl(null));
  }, [code]);
  return url ? <img className="qr" src={url} alt="WhatsApp link code" width={264} height={264} /> : null;
}

function BlueBubblesForm({ currentUrl, onSaved }: { currentUrl: string | null; onSaved: () => void }) {
  const [url, setUrl] = useState(currentUrl ?? 'http://192.168.1.179:1234');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.saveBlueBubbles(url, password);
      setPassword('');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="bb-form" onSubmit={save}>
      <label htmlFor="bb-url">BlueBubbles server address</label>
      <input id="bb-url" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" />
      <label htmlFor="bb-pw">BlueBubbles server password</label>
      <input id="bb-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="row">
        <button className="btn-primary" disabled={busy || !url || !password}>{busy ? 'Connecting' : 'Connect'}</button>
      </div>
    </form>
  );
}

export function Settings({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: (q) => (q.state.data?.whatsapp.pairing ? 3000 : 15000) });
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  const [busy, setBusy] = useState(false);
  const [editBB, setEditBB] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const bb = status.data?.bluebubbles;
  const wa = status.data?.whatsapp;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['status'] });
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id="settings-title">Settings</h2>
          <button className="text-btn" onClick={onClose}>Close</button>
        </header>

        <section className="setting svc-imessage">
          <h3>iMessage and SMS</h3>
          {!bb && <p className="muted">Checking</p>}
          {bb && !bb.configured && (
            <>
              <p>Connect to BlueBubbles Server on the Mac to bring in iMessage and SMS.</p>
              <BlueBubblesForm currentUrl={bb.url} onSaved={() => qc.invalidateQueries({ queryKey: ['status'] })} />
            </>
          )}
          {bb?.configured && (
            <>
              <p className={`state ${bb.connected ? 'ok' : 'bad'}`}>{bb.connected ? 'Connected to the Mac' : 'Cannot reach the Mac'}</p>
              {bb.importing && <p>Importing message history from the Mac.</p>}
              <dl className="facts">
                {bb.osVersion && (<><dt>macOS</dt><dd>{bb.osVersion}</dd></>)}
                {bb.serverVersion && (<><dt>BlueBubbles</dt><dd>{bb.serverVersion}</dd></>)}
                <dt>Typing, reactions and read receipts</dt><dd>{bb.privateApi ? 'On' : 'Off (Private API not enabled)'}</dd>
                {bb.lastSyncAt && (<><dt>Last sync</dt><dd>{listTime(bb.lastSyncAt)}</dd></>)}
              </dl>
              {bb.error && <p className="form-error">{bb.error}</p>}
              {editBB ? (
                <BlueBubblesForm currentUrl={bb.url} onSaved={() => { setEditBB(false); qc.invalidateQueries({ queryKey: ['status'] }); }} />
              ) : (
                <button className="btn-quiet" onClick={() => setEditBB(true)}>Change connection</button>
              )}
            </>
          )}
        </section>

        <section className="setting svc-whatsapp">
          <h3>WhatsApp</h3>
          {!wa && <p className="muted">Checking</p>}
          {wa && !wa.configured && <p>Not set up. Add the WhatsApp connector address to the hub's settings.</p>}
          {wa?.configured && !wa.reachable && <p className="form-error">Cannot reach the WhatsApp connector. {wa.error}</p>}
          {wa?.reachable && wa.loggedIn && (
            <>
              <p className={`state ${wa.connected ? 'ok' : 'bad'}`}>
                {wa.connected ? 'Linked' : 'Linked, reconnecting'} as {wa.pushName || wa.jid?.split('@')[0]}
              </p>
              <button className="btn-quiet" disabled={busy} onClick={() => act(api.waLogout)}>Unlink WhatsApp</button>
            </>
          )}
          {wa?.reachable && !wa.loggedIn && (
            <>
              {wa.qr ? (
                <div className="pair">
                  <QR code={wa.qr} />
                  <ol>
                    <li>Open WhatsApp on your phone.</li>
                    <li>Go to Settings, then Linked devices, then Link a device.</li>
                    <li>Point the camera at this code.</li>
                  </ol>
                </div>
              ) : (
                <>
                  <p>{wa.pairing ? 'Getting a link code' : 'The link code expired.'}</p>
                  {!wa.pairing && <button className="btn-primary" disabled={busy} onClick={() => act(api.waPair)}>Show a new code</button>}
                </>
              )}
            </>
          )}
        </section>

        <section className="setting">
          <h3>Notifications</h3>
          {notif === 'granted' && <p>On. You'll get a notification when a message arrives while this window isn't showing that conversation.</p>}
          {notif === 'default' && (
            <button className="btn-quiet" onClick={() => Notification.requestPermission().then(setNotif)}>Turn on notifications</button>
          )}
          {notif === 'denied' && <p>Blocked in this browser. Allow notifications for this site in the browser's site settings.</p>}
        </section>

        <footer className="modal-foot">
          <button className="btn-quiet" onClick={() => api.logout().finally(() => qc.setQueryData(['me'], { loggedIn: false, needsSetup: false }))}>Sign out</button>
        </footer>
      </div>
    </div>
  );
}
