import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApiClient, MarifoldApiError } from './api/client';
import { getStatus } from './api/misc';
import { ConnectionPopover } from './components/ConnectionPopover';
import { MarigoldLogo } from './components/MarigoldLogo';
import type { WorkspaceView } from './components/WorkspaceTabs';
import type { Route } from './lib/route';
import { AgentScreen } from './screens/agent/AgentScreen';
import { ConfigScreen } from './screens/config/ConfigScreen';
import { useRoute } from './screens/useRoute';
import type { ServerConnection } from './state/connection';
import {
  activeConnection,
  apiSettings,
  loadConnections,
  removeConnection,
  saveConnections,
  upsertAndActivateConnection,
} from './state/connection';
import { useTheme } from './theme/theme';
import styles from './App.module.css';

const LAST_AGENT_ROUTE_PREFIX = 'marifold.lastAgentRoute.';

/** Root shell: clean-path desktop views and the service connection. */
export function App() {
  const [route, navigate] = useRoute();
  const [theme, setTheme] = useTheme();
  const [connections, setConnections] = useState(loadConnections);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionProblem, setConnectionProblem] = useState<string | undefined>();
  const currentConnection = useMemo(() => activeConnection(connections), [connections]);
  const lastAgentRoute = useRef<Extract<Route, { view: 'agent' }>>(
    route.view === 'agent' ? route : loadLastAgentRoute(currentConnection.id),
  );
  const settingsReturnRoute = useRef<Extract<Route, { view: 'agent' | 'apps' }>>(
    route.view === 'apps' ? route : lastAgentRoute.current,
  );

  useEffect(() => {
    if (route.view !== 'agent') return;
    lastAgentRoute.current = route;
    try {
      window.sessionStorage.setItem(lastAgentRouteKey(currentConnection.id), JSON.stringify(route));
    } catch {
      // In-memory continuity still works when storage is unavailable.
    }
  }, [currentConnection.id, route]);

  const client = useMemo(
    () => createApiClient(apiSettings(currentConnection)),
    [currentConnection.baseUrl, currentConnection.token],
  );

  const onUnauthorized = useCallback(() => {
    setConnectionProblem('The service rejected the request — set the bearer token it expects.');
    setConnectionOpen(true);
  }, []);

  const onConnect = useCallback(async (connection: ServerConnection): Promise<string | undefined> => {
    try {
      const status = await getStatus(createApiClient(apiSettings(connection)));
      if (status.service !== 'marifold' || status.apiVersion !== 'v1') {
        return 'The endpoint responded, but it is not a compatible Marifold service.';
      }
    } catch (error) {
      if (error instanceof MarifoldApiError && error.code === 'UNAUTHORIZED') {
        return 'The service rejected this bearer token.';
      }
      return error instanceof Error ? error.message : String(error);
    }

    const switchingServers = currentConnection.id !== connection.id;
    const next = upsertAndActivateConnection(connections, connection);
    saveConnections(next);
    setConnections(next);
    setConnectionEpoch(epoch => epoch + 1);
    setConnectionProblem(undefined);
    if (switchingServers) {
      const nextAgentRoute = loadLastAgentRoute(connection.id);
      lastAgentRoute.current = nextAgentRoute;
      settingsReturnRoute.current = route.view === 'apps' ? { view: 'apps' } : nextAgentRoute;
      navigate(route.view === 'apps' ? { view: 'apps' } : nextAgentRoute);
    }
    return undefined;
  }, [connections, currentConnection.id, navigate, route.view]);

  const onRemoveConnection = useCallback((id: string) => {
    const removingActive = connections.activeId === id;
    const next = removeConnection(connections, id);
    saveConnections(next);
    setConnections(next);
    setConnectionProblem(undefined);
    if (!removingActive) return;
    setConnectionEpoch(epoch => epoch + 1);
    const nextConnection = activeConnection(next);
    const nextRoute = loadLastAgentRoute(nextConnection.id);
    lastAgentRoute.current = nextRoute;
    settingsReturnRoute.current = nextRoute;
    navigate(nextRoute);
  }, [connections, navigate]);

  const onWorkspaceViewChange = useCallback((view: WorkspaceView) => {
    if (view === 'agent') navigate(lastAgentRoute.current);
    else navigate({ view: 'apps' });
  }, [navigate]);

  const onOpenSettings = useCallback(() => {
    if (route.view === 'agent' || route.view === 'apps') settingsReturnRoute.current = route;
    navigate({ view: 'config', section: 'profiles' });
  }, [navigate, route]);

  return (
    <div className={styles.shell}>
      <main key={`${currentConnection.id}:${connectionEpoch}`} className={styles.content}>
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
            connectionName={currentConnection.name}
            onDone={() => navigate(settingsReturnRoute.current)}
          />
        ) : (
          <AgentScreen
            client={client}
            route={route.view === 'agent' ? route : lastAgentRoute.current}
            navigate={navigate}
            onUnauthorized={onUnauthorized}
            theme={theme}
            onThemeChange={setTheme}
            onOpenConnection={() => setConnectionOpen(true)}
            onOpenSettings={onOpenSettings}
            connectionId={currentConnection.id}
            connectionName={currentConnection.name}
            workspaceView={route.view}
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
          store={connections}
          problem={connectionProblem}
          onConnect={onConnect}
          onRemove={onRemoveConnection}
          onClose={() => setConnectionOpen(false)}
        />
      ) : null}
    </div>
  );
}

function loadLastAgentRoute(connectionId: string): Extract<Route, { view: 'agent' }> {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(lastAgentRouteKey(connectionId)) ?? 'null') as unknown;
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

function lastAgentRouteKey(connectionId: string): string {
  return `${LAST_AGENT_ROUTE_PREFIX}${encodeURIComponent(connectionId)}`;
}
