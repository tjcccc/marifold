import { startupWorkspaces } from '@marifold/client';
import { useWorkspaceChangePublisher } from './state/workspaceChanges';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApiClient, MarifoldApiError } from './api/client';
import { getStatus } from './api/misc';
import { WorkspacePopover } from './components/WorkspacePopover';
import type { WorkspaceSummary } from './api/types';
import type { WorkspaceView } from './components/WorkspaceTabs';
import type { ChatRoute, Route } from './lib/route';
import { visualViewportGeometry } from './lib/visualViewport';
import { AgentScreen } from './screens/agent/AgentScreen';
import { ConfigScreen } from './screens/config/ConfigScreen';
import { useRoute } from './screens/useRoute';
import type { ServerConnection } from './state/connection';
import {
  THIS_SERVER_ID,
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
const LAST_PROJECTS_ROUTE_PREFIX = 'marifold.lastProjectsRoute.';
const LAST_APPS_ROUTE_PREFIX = 'marifold.lastAppsRoute.';

/** Root shell: clean-path desktop views and the service connection. */
export function App() {
  const [route, navigate] = useRoute();
  const [theme, setTheme] = useTheme();
  const [openingWorkspace, setOpeningWorkspace] = useState(true);
  const [connections, setConnections] = useState(loadConnections);
  const executionDevice = useRef<string | undefined>(undefined);
  const [selectedDevice, setSelectedDevice] = useState<string | undefined>();
  const [workspaceAvailable, setWorkspaceAvailable] = useState(true);
  const [workspaceNotice, setWorkspaceNotice] = useState<string | undefined>();
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionProblem, setConnectionProblem] = useState<string | undefined>();
  const currentConnection = useMemo(() => activeConnection(connections), [connections]);
  const lastAgentRoute = useRef<Extract<Route, { view: 'agent' }>>(
    route.view === 'agent' ? route : loadLastChatRoute(currentConnection.id, 'agent'),
  );
  const lastProjectsRoute = useRef<Extract<Route, { view: 'projects' }>>(
    route.view === 'projects' ? route : loadLastChatRoute(currentConnection.id, 'projects'),
  );
  // Apps keep the conversation screen mounted: the chat view used last.
  const lastChatView = useRef<ChatRoute['view']>(route.view === 'projects' ? 'projects' : 'agent');
  const lastAppsRoute = useRef<Extract<Route, { view: 'apps' }>>(
    route.view === 'apps' ? route : loadLastAppsRoute(currentConnection.id),
  );
  const settingsReturnRoute = useRef<Extract<Route, { view: 'agent' | 'projects' | 'apps' }>>(
    route.view === 'apps' || route.view === 'projects' ? route : lastAgentRoute.current,
  );

  useEffect(() => {
    if (route.view !== 'agent' && route.view !== 'projects') { return; }
    if (route.view === 'agent') { lastAgentRoute.current = route; } else { lastProjectsRoute.current = route; }
    lastChatView.current = route.view;
    try {
      window.sessionStorage.setItem(lastChatRouteKey(currentConnection.id, route.view), JSON.stringify(route));
    } catch {
      // In-memory continuity still works when storage is unavailable.
    }
  }, [currentConnection.id, route]);

  useEffect(() => {
    if (route.view !== 'apps') { return; }
    lastAppsRoute.current = route;
    try {
      window.sessionStorage.setItem(lastAppsRouteKey(currentConnection.id), JSON.stringify(route));
    } catch {
      // In-memory continuity still works when storage is unavailable.
    }
  }, [currentConnection.id, route]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    let firstFrame: number | undefined;
    let secondFrame: number | undefined;
    let settleTimer: number | undefined;

    const updateViewport = (): void => {
      const geometry = visualViewportGeometry(viewport, window.innerHeight, window.scrollY);
      root.style.setProperty('--marifold-viewport-height', `${geometry.height}px`);
      root.style.setProperty('--marifold-viewport-offset-top', `${geometry.offsetTop}px`);
    };

    // WebKit may dispatch its viewport event before the keyboard animation has
    // committed the final offset. Re-read after two paints as well as now.
    const updateAfterPaint = (): void => {
      if (firstFrame !== undefined) { window.cancelAnimationFrame(firstFrame); }
      if (secondFrame !== undefined) { window.cancelAnimationFrame(secondFrame); }
      firstFrame = window.requestAnimationFrame(() => {
        firstFrame = undefined;
        secondFrame = window.requestAnimationFrame(() => {
          secondFrame = undefined;
          updateViewport();
        });
      });
    };

    const onViewportChange = (): void => {
      updateViewport();
      updateAfterPaint();
    };

    const onEditableFocusChange = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches('input, textarea, [contenteditable="true"]')) { return; }
      onViewportChange();
      if (settleTimer !== undefined) { window.clearTimeout(settleTimer); }
      settleTimer = window.setTimeout(onViewportChange, 400);
    };

    updateViewport();
    viewport?.addEventListener('resize', onViewportChange);
    viewport?.addEventListener('scroll', onViewportChange);
    window.addEventListener('resize', onViewportChange);
    document.addEventListener('focusin', onEditableFocusChange);
    document.addEventListener('focusout', onEditableFocusChange);
    return () => {
      viewport?.removeEventListener('resize', onViewportChange);
      viewport?.removeEventListener('scroll', onViewportChange);
      window.removeEventListener('resize', onViewportChange);
      document.removeEventListener('focusin', onEditableFocusChange);
      document.removeEventListener('focusout', onEditableFocusChange);
      if (firstFrame !== undefined) { window.cancelAnimationFrame(firstFrame); }
      if (secondFrame !== undefined) { window.cancelAnimationFrame(secondFrame); }
      if (settleTimer !== undefined) { window.clearTimeout(settleTimer); }
      root.style.removeProperty('--marifold-viewport-height');
      root.style.removeProperty('--marifold-viewport-offset-top');
    };
  }, []);

  const client = useMemo(
    () => createApiClient({ ...apiSettings(currentConnection), executionDevice: () => executionDevice.current }),
    [currentConnection.baseUrl, currentConnection.token, currentConnection.workspaceId],
  );

  useEffect(() => {
    let cancelled = false;
    const local = connections.servers.find(c => c.id === THIS_SERVER_ID)!;
    // A reload in Projects stays in Projects on the workspace it opens.
    const startView = route.view === 'projects' ? 'projects' : 'agent';
    void startupWorkspaces<WorkspaceSummary>(createApiClient(apiSettings(local))).then(result => {
      if (cancelled) { return; }
      const preferred = result.workspaces.find(w => w.id === result.defaultId);
      if (!preferred && !currentConnection.workspaceId) { return; }
      const target: ServerConnection = preferred?.online
        ? { id: `workspace-${preferred.id}`, name: preferred.name, workspaceId: preferred.id, token: local.token }
        : local;
      const next = upsertAndActivateConnection(connections, target);
      saveConnections(next); setConnections(next); setConnectionEpoch(epoch => epoch + 1);
      navigate(loadLastChatRoute(target.id, startView));
      if (preferred && !preferred.online) { setWorkspaceNotice(preferred.versionError ?? `${preferred.name} is offline. Opened Local for this launch.`); }
    }).catch(() => {
      if (!cancelled && currentConnection.workspaceId) {
        const next = upsertAndActivateConnection(connections, local); saveConnections(next); setConnections(next);
        setWorkspaceNotice('Workspace unavailable. Opened Local for this launch.'); navigate(loadLastChatRoute(local.id, startView));
      }
    }).finally(() => { if (!cancelled) { setOpeningWorkspace(false); } });
    return () => { cancelled = true; };
  }, []);

  useWorkspaceChangePublisher(client, setWorkspaceAvailable);

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
    if (switchingServers) { executionDevice.current = undefined; setSelectedDevice(undefined); }
    setWorkspaceNotice(undefined);
    const next = upsertAndActivateConnection(connections, connection);
    saveConnections(next);
    setConnections(next);
    setConnectionEpoch(epoch => epoch + 1);
    setConnectionProblem(undefined);
    if (switchingServers) {
      const nextAgentRoute = loadLastChatRoute(connection.id, 'agent');
      const nextProjectsRoute = loadLastChatRoute(connection.id, 'projects');
      const nextAppsRoute = loadLastAppsRoute(connection.id);
      lastAgentRoute.current = nextAgentRoute;
      lastProjectsRoute.current = nextProjectsRoute;
      lastAppsRoute.current = nextAppsRoute;
      const next = route.view === 'apps' ? nextAppsRoute : route.view === 'projects' ? nextProjectsRoute : nextAgentRoute;
      settingsReturnRoute.current = next;
      navigate(next);
    }
    return undefined;
  }, [connections, currentConnection.id, navigate, route]);

  const onRemoveConnection = useCallback((id: string) => {
    const removingActive = connections.activeId === id;
    const next = removeConnection(connections, id);
    saveConnections(next);
    setConnections(next);
    setConnectionProblem(undefined);
    if (!removingActive) { return; }
    setConnectionEpoch(epoch => epoch + 1);
    const nextConnection = activeConnection(next);
    const nextRoute = loadLastChatRoute(nextConnection.id, 'agent');
    lastProjectsRoute.current = loadLastChatRoute(nextConnection.id, 'projects');
    lastAppsRoute.current = loadLastAppsRoute(nextConnection.id);
    lastAgentRoute.current = nextRoute;
    settingsReturnRoute.current = nextRoute;
    navigate(nextRoute);
  }, [connections, navigate]);

  const onWorkspaceViewChange = useCallback((view: WorkspaceView) => {
    navigate(view === 'agent' ? lastAgentRoute.current : view === 'projects' ? lastProjectsRoute.current : lastAppsRoute.current);
  }, [navigate]);

  const onOpenSettings = useCallback(() => {
    if (route.view === 'agent' || route.view === 'projects' || route.view === 'apps') { settingsReturnRoute.current = route; }
    navigate({ view: 'config', section: 'profiles' });
  }, [navigate, route]);

  const chatRoute: ChatRoute = route.view === 'agent' || route.view === 'projects'
    ? route
    : lastChatView.current === 'projects' ? lastProjectsRoute.current : lastAgentRoute.current;

  return (
    <div className={styles.shell}>
      {currentConnection.workspaceId && !workspaceAvailable && <div role="status" className={styles.workspaceNotice}>{currentConnection.name} is unavailable. This conversation stays in its workspace; reconnect or choose Local explicitly.</div>}
      {workspaceNotice && <div role="status" className={styles.workspaceNotice}>{workspaceNotice}<button onClick={() => setWorkspaceNotice(undefined)}>Dismiss</button></div>}
      <main key={`${currentConnection.id}:${connectionEpoch}`} className={styles.content}>
        {openingWorkspace ? <div role="status" className={styles.workspaceNotice}>Opening workspace…</div> : route.view === 'config' ? (
          <ConfigScreen
            client={client}
            route={route}
            navigate={navigate}
            onUnauthorized={onUnauthorized}
            theme={theme}
            onThemeChange={setTheme}
            onOpenConnection={() => setConnectionOpen(true)}
            onOpenSettings={onOpenSettings}
            connectionName={currentConnection.workspaceId && selectedDevice ? `${currentConnection.name} · tools: ${selectedDevice === 'host' ? 'host' : 'selected device'}` : currentConnection.name}
            onDone={() => navigate(settingsReturnRoute.current)}
            onOpenAgent={() => navigate(lastAgentRoute.current)}
            onOpenProjects={() => navigate(lastProjectsRoute.current)}
            onOpenApps={() => navigate(lastAppsRoute.current)}
          />
        ) : (
          <AgentScreen
            key={chatRoute.view}
            client={client}
            route={chatRoute}
            appName={route.view === 'apps' ? route.app : lastAppsRoute.current.app}
            navigate={navigate}
            onUnauthorized={onUnauthorized}
            theme={theme}
            onThemeChange={setTheme}
            onOpenConnection={() => setConnectionOpen(true)}
            onOpenSettings={onOpenSettings}
            connectionId={currentConnection.id}
            connectionName={currentConnection.workspaceId && selectedDevice ? `${currentConnection.name} · tools: ${selectedDevice === 'host' ? 'host' : 'selected device'}` : currentConnection.name}
            workspaceView={route.view}
            onWorkspaceViewChange={onWorkspaceViewChange}
          />
        )}
      </main>
      {connectionOpen ? (
        <WorkspacePopover
          executionDevice={selectedDevice}
          onExecutionDevice={id => { executionDevice.current = id; setSelectedDevice(id); }}
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

function loadLastChatRoute<V extends ChatRoute['view']>(connectionId: string, view: V): Extract<ChatRoute, { view: V }> {
  const empty = { view } as Extract<ChatRoute, { view: V }>;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(lastChatRouteKey(connectionId, view)) ?? 'null') as unknown;
    if (!value || typeof value !== 'object' || !('view' in value) || value.view !== view) { return empty; }
    const candidate = value as { profile?: unknown; project?: unknown; session?: unknown };
    const ownerKey = view === 'agent' ? 'profile' : 'project';
    const owner = candidate[ownerKey];
    if (typeof owner !== 'string') { return empty; }
    return {
      view,
      [ownerKey]: owner,
      ...(typeof candidate.session === 'string' ? { session: candidate.session } : {}),
    } as Extract<ChatRoute, { view: V }>;
  } catch {
    return empty;
  }
}

function lastChatRouteKey(connectionId: string, view: ChatRoute['view']): string {
  return `${view === 'agent' ? LAST_AGENT_ROUTE_PREFIX : LAST_PROJECTS_ROUTE_PREFIX}${encodeURIComponent(connectionId)}`;
}

function loadLastAppsRoute(connectionId: string): Extract<Route, { view: 'apps' }> {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(lastAppsRouteKey(connectionId)) ?? 'null') as unknown;
    if (!value || typeof value !== 'object' || !('view' in value) || value.view !== 'apps') {
      return { view: 'apps' };
    }
    const candidate = value as { app?: unknown };
    return {
      view: 'apps',
      ...(typeof candidate.app === 'string' ? { app: candidate.app } : {}),
    };
  } catch {
    return { view: 'apps' };
  }
}

function lastAppsRouteKey(connectionId: string): string {
  return `${LAST_APPS_ROUTE_PREFIX}${encodeURIComponent(connectionId)}`;
}
