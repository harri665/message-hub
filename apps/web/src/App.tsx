import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.ts';
import { useLive } from './live.ts';
import { clearLocalData } from './localCache.ts';
import { Login } from './components/Login.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { ThreadView } from './components/ThreadView.tsx';
import { Settings } from './components/Settings.tsx';
import { SendApprovals } from './components/SendApprovals.tsx';
import { NewMessage } from './components/NewMessage.tsx';

interface Route { tid: string | null; focus: number | null; compose: boolean }

/** #/t/p12 opens a conversation; #/t/p12/m/345 opens it at message 345; #/new starts a new one. */
function readHash(): Route {
  const m = location.hash.match(/^#\/t\/([pc]\d+)(?:\/m\/(\d+))?/);
  return { tid: m ? m[1] : null, focus: m?.[2] ? Number(m[2]) : null, compose: location.hash === '#/new' };
}

export function App() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity });
  const [route, setRoute] = useState<Route>(readHash);
  const { tid, focus, compose } = route;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const loggedIn = !!me.data?.loggedIn;

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    // Session ended (or signed out elsewhere): drop what this device has stored, then show the login.
    const onLoggedOut = () => clearLocalData().finally(() => qc.invalidateQueries({ queryKey: ['me'] }));
    window.addEventListener('hashchange', onHash);
    window.addEventListener('mh:logged-out', onLoggedOut);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('mh:logged-out', onLoggedOut);
    };
  }, [qc]);

  useLive(loggedIn, tid);

  const open = (next: string | null, messageId?: number) => {
    location.hash = next ? `#/t/${next}${messageId ? `/m/${messageId}` : ''}` : '#/';
  };

  if (me.isPending) return <div className="boot" aria-busy="true" />;
  if (!loggedIn) {
    return <Login needsSetup={!!me.data?.needsSetup} onDone={() => qc.setQueryData(['me'], { loggedIn: true, needsSetup: false })} />;
  }

  return (
    <div className={`shell ${tid || compose ? 'has-thread' : ''}`}>
      <Sidebar activeTid={tid} composing={compose} onOpen={open} onNew={() => (location.hash = '#/new')} onSettings={() => setSettingsOpen(true)} />
      <main className="pane glass-thin">
        {compose ? (
          <NewMessage onOpen={(next) => open(next)} onCancel={() => history.length > 1 ? history.back() : open(null)} />
        ) : tid ? (
          <ThreadView
            key={tid}
            tid={tid}
            focus={focus}
            onFocus={(id) => open(tid, id ?? undefined)}
            onBack={() => open(null)}
          />
        ) : (
          <div className="pane-empty">
            <p>Choose a conversation.</p>
          </div>
        )}
      </main>
      <SendApprovals />
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
