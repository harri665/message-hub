import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.ts';
import { useLive } from './live.ts';
import { Login } from './components/Login.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { ThreadView } from './components/ThreadView.tsx';
import { Settings } from './components/Settings.tsx';

function readHash(): string | null {
  const m = location.hash.match(/^#\/t\/([pc]\d+)/);
  return m ? m[1] : null;
}

export function App() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity });
  const [tid, setTid] = useState<string | null>(readHash);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const loggedIn = !!me.data?.loggedIn;

  useEffect(() => {
    const onHash = () => setTid(readHash());
    const onLoggedOut = () => qc.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener('hashchange', onHash);
    window.addEventListener('mh:logged-out', onLoggedOut);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('mh:logged-out', onLoggedOut);
    };
  }, [qc]);

  useLive(loggedIn, tid);

  const open = (next: string | null) => {
    location.hash = next ? `#/t/${next}` : '#/';
  };

  if (me.isPending) return <div className="boot" aria-busy="true" />;
  if (!loggedIn) {
    return <Login needsSetup={!!me.data?.needsSetup} onDone={() => qc.setQueryData(['me'], { loggedIn: true, needsSetup: false })} />;
  }

  return (
    <div className={`shell ${tid ? 'has-thread' : ''}`}>
      <Sidebar activeTid={tid} onOpen={open} onSettings={() => setSettingsOpen(true)} />
      <main className="pane">
        {tid ? (
          <ThreadView key={tid} tid={tid} onBack={() => open(null)} />
        ) : (
          <div className="pane-empty">
            <p>Pick a conversation to start reading.</p>
          </div>
        )}
      </main>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
