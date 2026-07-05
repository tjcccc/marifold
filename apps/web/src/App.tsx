import { useCallback, useMemo, useState } from 'react';
import { createApiClient } from './api/client';
import { ConnectionPopover } from './components/ConnectionPopover';
import type { AppView } from './components/TopNav';
import { TopNav } from './components/TopNav';
import { AgentScreen } from './screens/agent/AgentScreen';
import { AppsScreen } from './screens/apps/AppsScreen';
import { ConfigScreen } from './screens/config/ConfigScreen';
import { useHashRoute } from './screens/useHashRoute';
import type { ConnectionSettings } from './state/connection';
import { loadConnection, saveConnection } from './state/connection';
import { useTheme } from './theme/theme';
import styles from './App.module.css';

/** Root shell: toolbar, hash-routed views, and the service connection. */
export function App() {
  const [route, navigate] = useHashRoute();
  const [theme, setTheme] = useTheme();
  const [connection, setConnection] = useState<ConnectionSettings>(() => loadConnection());
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionProblem, setConnectionProblem] = useState<string | undefined>();

  const client = useMemo(() => createApiClient(connection), [connection]);

  const onUnauthorized = useCallback(() => {
    setConnectionProblem('The service rejected the request — set the bearer token it expects.');
    setConnectionOpen(true);
  }, []);

  const onSaveConnection = useCallback((settings: ConnectionSettings) => {
    saveConnection(settings);
    setConnection(settings);
    setConnectionProblem(undefined);
  }, []);

  const onViewChange = useCallback(
    (view: AppView) => {
      if (view === 'agent') navigate({ view: 'agent', ...(route.view === 'agent' ? route : {}) });
      else navigate({ view });
    },
    [navigate, route],
  );

  return (
    <div className={styles.shell}>
      <TopNav
        view={route.view}
        onViewChange={onViewChange}
        theme={theme}
        onThemeChange={setTheme}
        onOpenConnection={() => setConnectionOpen(true)}
      />
      <main className={styles.content}>
        {route.view === 'agent' ? (
          <AgentScreen client={client} route={route} navigate={navigate} onUnauthorized={onUnauthorized} />
        ) : route.view === 'config' ? (
          <ConfigScreen client={client} route={route} navigate={navigate} onUnauthorized={onUnauthorized} />
        ) : (
          <AppsScreen />
        )}
      </main>
      {connectionOpen ? (
        <ConnectionPopover
          settings={connection}
          problem={connectionProblem}
          onSave={onSaveConnection}
          onClose={() => setConnectionOpen(false)}
        />
      ) : null}
    </div>
  );
}
