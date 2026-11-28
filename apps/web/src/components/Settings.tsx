import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../api.ts';
import { clearLocalData } from '../localCache.ts';
import { listTime } from '../format.ts';
import { useAiStatus } from '../aiStatus.ts';

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

const num = (n: number) => n.toLocaleString();
const modelName = (m: string) => m.split('/').pop() ?? m;

/** AI features through Cloudflare Workers AI: today's share of the free allowance and how far the background work has got. */
function AiFeatures() {
  const status = useAiStatus(30_000);
  const s = status.data;
  if (!s) return <div className="group"><div className="group-row"><span>{status.isError ? status.error.message : 'Loading'}</span></div></div>;
  if (!s.enabled) {
    return (
      <div className="group">
        <div className="group-body">
          <p style={{ margin: 0 }}>
            Off. Photo descriptions, search by meaning, AI answers and reply suggestions run on Cloudflare Workers AI's free daily allowance.
            To turn them on, set CF_ACCOUNT_ID and CF_API_TOKEN in the hub's environment and restart it.
          </p>
        </div>
      </div>
    );
  }
  const share = Math.min(1, s.usedToday / s.limit);
  const reset = new Date(s.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const others = s.account.usedToday === null ? null : Math.max(0, s.usedToday - s.hubUsedToday);
  return (
    <div className="group">
      <div className="group-body">
        <div className="ai-meter" role="meter" aria-valuemin={0} aria-valuemax={s.limit} aria-valuenow={s.usedToday} aria-label="Cloudflare allowance used today">
          <span style={{ width: `${share * 100}%` }} className={share >= 0.8 ? 'high' : ''} />
        </div>
        <p className="note" style={{ margin: 0 }}>
          {num(s.remaining)} of {num(s.limit)} Neurons left today. Resets at {reset}.
          {share >= 0.8 && ' Answers and suggestions now use the cheaper fallback model.'}
        </p>
      </div>
      <div className="group-row">
        <span>{s.owner ? `Used by ${s.owner}` : 'Used by this hub'}</span>
        <span className="value">{num(s.hubUsedToday)} Neurons</span>
      </div>
      <div className="group-row">
        <span>Used by everyone on this Cloudflare account</span>
        <span className="value" title={s.account.error ?? undefined}>
          {s.account.usedToday === null ? 'unknown' : `${num(s.usedToday)} Neurons${others ? ` (${num(others)} from other hubs)` : ''}`}
        </span>
      </div>
      {s.account.error && (
        <div className="group-body"><p className="note" style={{ margin: 0 }}>{s.account.error} Until then, "left today" counts only this hub.</p></div>
      )}
      <div className="group-row">
        <span>Photo descriptions</span>
        <span className="value">{num(s.photos.described)} described{s.photos.pending ? `, ${num(s.photos.pending)} waiting` : ''}</span>
      </div>
      <div className="group-row">
        <span>Search by meaning</span>
        <span className="value">
          {num(s.search.embedded)} stretches of conversation indexed
          {s.search.waitingMessages + s.search.waitingChunks ? `, ${num(s.search.waitingMessages)} messages waiting` : ''}
        </span>
      </div>
      <div className="group-row">
        <span>Models</span>
        <span className="value">
          answers {modelName(s.models.answer)}, replies {modelName(s.models.reply)}, photos {modelName(s.models.vision)}, fallback {modelName(s.models.fallback)}
        </span>
      </div>
      <div className="group-body">
        <p className="note" style={{ margin: 0 }}>
          Message text and photos are sent to Cloudflare to be processed. Old photos and messages are worked through a little each day, while most of the allowance is unused.
        </p>
      </div>
    </div>
  );
}

/** Access tokens for the MCP server, so Claude can search and read messages and ask to send them (you approve each one). */
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
          Let Claude search and read your messages through MCP. Claude can also ask to send a message, but nothing is sent until you approve it here in Message Hub. Every request waits for you to choose Send or Don't send.
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

        <h3 className="group-title">AI features</h3>
        <AiFeatures />

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
          <button className="pill-btn danger" onClick={() => api.logout().finally(() => clearLocalData().finally(() => qc.setQueryData(['me'], { loggedIn: false, needsSetup: false })))}>
            Sign out
          </button>
        </footer>
      </div>
    </div>
  );
}
