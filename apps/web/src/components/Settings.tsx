import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../api.ts';
import { listTime } from '../format.ts';

function QR({ code }: { code: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(code, { margin: 1, width: 232, errorCorrectionLevel: 'L' }).then(setUrl).catch(() => setUrl(null));
  }, [code]);
  return url ? <img className="qr" src={url} alt="WhatsApp link code" width={232} height={232} /> : null;
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
      <input id="bb-url" className="field" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" />
      <label htmlFor="bb-pw">BlueBubbles server password</label>
      <input id="bb-pw" className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div>
        <button className="pill-btn primary" disabled={busy || !url || !password}>{busy ? 'Connecting' : 'Connect'}</button>
      </div>
    </form>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <span className="copy-label">{label}</span>
      <code>{value}</code>
      <button
        type="button"
        className="link-btn"
        onClick={() => navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** Access tokens for the MCP server, so Claude can search and read messages. */
function ClaudeAccess() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['mcp-tokens'], queryFn: api.mcpTokens });
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const origin = location.origin;
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setCreated(await api.createMcpToken('Claude'));
      qc.invalidateQueries({ queryKey: ['mcp-tokens'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a token');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    await api.deleteMcpToken(id).catch(() => {});
    qc.invalidateQueries({ queryKey: ['mcp-tokens'] });
  };
  return (
    <div className="group">
      <div className="group-body">
        <p style={{ margin: 0 }}>
          Let Claude search and read your messages through MCP. Access is read-only: Claude can't send anything.
        </p>
        {created ? (
          <>
            <p className="note">Copy this now. The token won't be shown again.</p>
            <CopyField
              label="Claude Code"
              value={`claude mcp add --transport http --scope user messages ${origin}/mcp --header "Authorization: Bearer ${created.token}"`}
            />
            <CopyField label="Connector URL (claude.ai, needs an https address)" value={`${origin}/mcp/${created.token}`} />
            <div><button className="pill-btn" onClick={() => setCreated(null)}>Done</button></div>
          </>
        ) : (
          <div><button className="pill-btn primary" disabled={busy} onClick={create}>{busy ? 'Creating' : 'Create access token'}</button></div>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      {list.data?.map((t) => (
        <div key={t.id} className="group-row">
          <span>
            {t.name}
            <span className="value"> created {listTime(t.createdAt)}, {t.lastUsedAt ? `last used ${listTime(t.lastUsedAt)}` : 'not used yet'}</span>
          </span>
          <button className="link-btn danger" onClick={() => revoke(t.id)}>Revoke</button>
        </div>
      ))}
    </div>
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
  const refresh = () => qc.invalidateQueries({ queryKey: ['status'] });
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="sheet glass" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2 id="settings-title">Settings</h2>
          <button className="pill-btn" onClick={onClose}>Done</button>
        </header>

        <h3 className="group-title">iMessage and SMS</h3>
        <div className="group">
          {!bb && <div className="group-row muted">Checking</div>}
          {bb && !bb.configured && (
            <div className="group-body">
              <p style={{ margin: 0 }}>Connect to BlueBubbles Server on the Mac to bring in iMessage and SMS.</p>
              <BlueBubblesForm currentUrl={bb.url} onSaved={refresh} />
            </div>
          )}
          {bb?.configured && (
            <>
              <div className="group-row">
                <span>Mac</span>
                <span className={`state ${bb.connected ? 'ok' : 'bad'}`}>{bb.connected ? 'Connected' : 'Unreachable'}</span>
              </div>
              {bb.importing && <div className="group-row"><span>History</span><span className="value">Importing</span></div>}
              {bb.osVersion && <div className="group-row"><span>macOS</span><span className="value">{bb.osVersion}</span></div>}
              {bb.serverVersion && <div className="group-row"><span>BlueBubbles</span><span className="value">{bb.serverVersion}</span></div>}
              <div className="group-row">
                <span>Typing, tapbacks and read receipts</span>
                <span className="value">{bb.privateApi ? 'On' : 'Off'}</span>
              </div>
              {bb.lastSyncAt && <div className="group-row"><span>Last sync</span><span className="value">{listTime(bb.lastSyncAt)}</span></div>}
              {bb.error && <div className="group-row"><span className="form-error">{bb.error}</span></div>}
              <div className="group-row">
                {editBB ? (
                  <div className="group-body" style={{ width: '100%' }}>
                    <BlueBubblesForm currentUrl={bb.url} onSaved={() => { setEditBB(false); refresh(); }} />
                  </div>
                ) : (
                  <>
                    <span className="value">{bb.url}</span>
                    <button className="link-btn" onClick={() => setEditBB(true)}>Change</button>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        <h3 className="group-title">WhatsApp</h3>
        <div className="group">
          {!wa && <div className="group-row muted">Checking</div>}
          {wa && !wa.configured && <div className="group-row">The WhatsApp connector isn't set up on the server.</div>}
          {wa?.configured && !wa.reachable && <div className="group-row form-error">Can't reach the WhatsApp connector. {wa.error}</div>}
          {wa?.reachable && wa.loggedIn && (
            <>
              <div className="group-row">
                <span>{wa.pushName || wa.jid?.split('@')[0]}</span>
                <span className={`state ${wa.connected ? 'ok' : 'bad'}`}>{wa.connected ? 'Linked' : 'Reconnecting'}</span>
              </div>
              <div className="group-row">
                <span className="value">Shows as "Message Hub" under Linked devices</span>
                <button className="link-btn" disabled={busy} onClick={() => act(api.waLogout)}>Unlink</button>
              </div>
            </>
          )}
          {wa?.reachable && !wa.loggedIn && (
            <div className="group-body">
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
                <div className="group-row">
                  <span>{wa.pairing ? 'Getting a link code' : 'The link code expired.'}</span>
                  {!wa.pairing && <button className="pill-btn primary" disabled={busy} onClick={() => act(api.waPair)}>Show a new code</button>}
                </div>
              )}
            </div>
          )}
        </div>

        <h3 className="group-title">Claude</h3>
        <ClaudeAccess />

        <h3 className="group-title">Notifications</h3>
        <div className="group">
          <div className="group-row">
            {notif === 'granted' && <span>On while this window is open in the background.</span>}
            {notif === 'default' && (
              <>
                <span>Get notified about new messages.</span>
                <button className="pill-btn primary" onClick={() => Notification.requestPermission().then(setNotif)}>Turn on</button>
              </>
            )}
            {notif === 'denied' && <span>Blocked. Allow notifications for this site in the browser's site settings.</span>}
          </div>
        </div>

        <footer className="sheet-foot">
          <button className="pill-btn danger" onClick={() => api.logout().finally(() => qc.setQueryData(['me'], { loggedIn: false, needsSetup: false }))}>
            Sign out
          </button>
        </footer>
      </div>
    </div>
  );
}
