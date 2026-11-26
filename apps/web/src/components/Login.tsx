import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';

export function Login({ needsSetup, onDone }: { needsSetup: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (needsSetup && password !== confirm) {
      setError("The two passwords don't match");
      return;
    }
    setBusy(true);
    try {
      if (needsSetup) await api.setup(password, code);
      else await api.login(password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card glass" onSubmit={submit}>
        <img className="login-icon" src="/icons/icon-192.png" alt="" width={72} height={72} />
        <h1>Messages</h1>
        <p className="login-sub">
          {needsSetup ? 'Create the password you will use to sign in.' : 'iMessage, SMS and WhatsApp in one place.'}
        </p>
        {needsSetup && (
          <>
            <label htmlFor="code">Setup code</label>
            <input id="code" className="field" autoComplete="off" autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
            <p className="field-hint">Printed in the hub's logs when it starts.</p>
          </>
        )}
        <label htmlFor="pw">{needsSetup ? 'New password' : 'Password'}</label>
        <input
          id="pw"
          className="field"
          type="password"
          autoComplete={needsSetup ? 'new-password' : 'current-password'}
          autoFocus={!needsSetup}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {needsSetup && (
          <>
            <label htmlFor="pw2">Type it again</label>
            <input id="pw2" className="field" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="pill-btn primary" disabled={busy || !password || (needsSetup && (!code || !confirm))}>
          {busy ? (needsSetup ? 'Creating' : 'Signing in') : needsSetup ? 'Create password' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
