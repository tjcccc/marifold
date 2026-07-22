import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApiClient } from './api/client';
import { ConnectionPopover } from './components/ConnectionPopover';
import { MarigoldLogo } from './components/MarigoldLogo';
import type { WorkspaceView } from './components/WorkspaceTabs';
import type { Route } from './lib/route';
import { AgentScreen } from './screens/agent/AgentScreen';
import { ConfigScreen } from './screens/config/ConfigScreen';
import { useRoute } from './screens/useRoute';
import type { ConnectionSettings } from './state/connection';
import { loadConnection, saveConnection } from './state/connection';
import { useTheme } from './theme/theme';
import styles from './App.module.css';

const LAST_AGENT_ROUTE_KEY = 'marifold.lastAgentRoute';

/** Root shell: clean-path desktop views and the service connection. */
export function App() {
  const [route, navigate] = useRoute();
  const [theme, setTheme] = useTheme();
  const [connection, setConnection] = useState<ConnectionSettings>(() => loadConnection());
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionProblem, setConnectionProblem] = useState<string | undefined>();
  const lastAgentRoute = useRef<Extract<Route, { view: 'agent' }>>(
    route.view === 'agent' ? route : loadLastAgentRoute(),
  );

  useEffect(() => {
    if (route.view !== 'agent') return;
    lastAgentRoute.current = route;
    try {
      window.sessionStorage.setItem(LAST_AGENT_ROUTE_KEY, JSON.stringify(route));
    } catch {
      // In-memory continuity still works when storage is unavailable.
    }
  }, [route]);

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

  const onWorkspaceViewChange = useCallback((view: WorkspaceView) => {
    if (view === 'agent') navigate(lastAgentRoute.current);
    else navigate({ view: 'apps' });
  }, [navigate]);

  const onOpenSettings = useCallback(() => {
    navigate({ view: 'config', section: 'profiles' });
  }, [navigate]);

  return (
    <div className={styles.shell}>
      <main className={styles.content}>
        {route.view === 'config' ? (
          <ConfigScreen
            client={client}
            route={route}
            navigate={navigate}
            onUnauthorized={onUnauthorized}
            theme={theme}
            onThemeChange={setTheme}
            onOpenConnection={() => setConnectionOpen(true)}
            onOpenSettings={onOpenSettings}
            onDone={() => navigate(lastAgentRoute.current)}
          />
        ) : (
          <AgentScreen
            client={client}
            route={route.view === 'agent' ? route : lastAgentRoute.current}
            workspaceView={route.view}
            navigate={navigate}
            onUnauthorized={onUnauthorized}
            theme={theme}
            onThemeChange={setTheme}
            onOpenConnection={() => setConnectionOpen(true)}
            onOpenSettings={onOpenSettings}
            onWorkspaceViewChange={onWorkspaceViewChange}
          />
        )}
      </main>
      <div className={styles.narrowWindow} role="status">
        <span className={styles.narrowLogo}><MarigoldLogo size={42} /></span>
        <div className={styles.narrowTitle}>Marifold needs a wider window</div>
        <div className={styles.narrowHint}>This Web UI is designed for desktop-sized windows.</div>
      </div>
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

function loadLastAgentRoute(): Extract<Route, { view: 'agent' }> {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(LAST_AGENT_ROUTE_KEY) ?? 'null') as unknown;
    if (!value || typeof value !== 'object' || !('view' in value) || value.view !== 'agent') {
      return { view: 'agent' };
    }
    const candidate = value as { profile?: unknown; session?: unknown };
    return {
      view: 'agent',
      ...(typeof candidate.profile === 'string' ? { profile: candidate.profile } : {}),
      ...(typeof candidate.profile === 'string' && typeof candidate.session === 'string'
        ? { session: candidate.session }
        : {}),
    };
  } catch {
    return { view: 'agent' };
  }
}
