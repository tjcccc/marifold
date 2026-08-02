/** One Marifold service that the Web shell can use as its data source. The
 * built-in entry has no baseUrl: requests go to the origin serving the shell. */
export interface ServerConnection {
  id: string;
  name: string;
  baseUrl?: string;
  token?: string;
}

export interface ConnectionStore {
  activeId: string;
  servers: ServerConnection[];
}

export interface ConnectionSettings {
  baseUrl?: string;
  token?: string;
}

export const THIS_SERVER_ID = 'this-server';
const STORAGE_KEY = 'marifold.connections.v1';
const LEGACY_STORAGE_KEY = 'marifold.connection';

export function defaultConnectionStore(): ConnectionStore {
  return {
    activeId: THIS_SERVER_ID,
    servers: [{ id: THIS_SERVER_ID, name: 'This server' }],
  };
}

export function loadConnections(): ConnectionStore {
  try {
    const current = window.localStorage.getItem(STORAGE_KEY);
    if (current) return normalizeStore(JSON.parse(current) as unknown);

    const migrated = migrateLegacyConnection(window.localStorage.getItem(LEGACY_STORAGE_KEY));
    saveConnections(migrated);
    return migrated;
  } catch {
    return defaultConnectionStore();
  }
}

export function saveConnections(store: ConnectionStore): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeStore(store)));
  } catch {
    // The in-page connection still works when storage is unavailable.
  }
}

export function activeConnection(store: ConnectionStore): ServerConnection {
  return store.servers.find(server => server.id === store.activeId)
    ?? store.servers.find(server => server.id === THIS_SERVER_ID)
    ?? defaultConnectionStore().servers[0]!;
}

export function apiSettings(server: ServerConnection): ConnectionSettings {
  return {
    ...(server.baseUrl ? { baseUrl: server.baseUrl } : {}),
    ...(server.token ? { token: server.token } : {}),
  };
}

export function upsertAndActivateConnection(
  store: ConnectionStore,
  connection: ServerConnection,
): ConnectionStore {
  const normalized = normalizeConnection(connection);
  const servers = store.servers.some(server => server.id === normalized.id)
    ? store.servers.map(server => server.id === normalized.id ? normalized : server)
    : [...store.servers, normalized];
  return normalizeStore({ activeId: normalized.id, servers });
}

export function removeConnection(store: ConnectionStore, id: string): ConnectionStore {
  if (id === THIS_SERVER_ID) return normalizeStore(store);
  return normalizeStore({
    activeId: store.activeId === id ? THIS_SERVER_ID : store.activeId,
    servers: store.servers.filter(server => server.id !== id),
  });
}

export function newConnectionId(): string {
  try {
    return `server-${crypto.randomUUID()}`;
  } catch {
    return `server-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function normalizeServerName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error('Server name is required.');
  if (name.length > 80) throw new Error('Server name must be 80 characters or fewer.');
  return name;
}

export function normalizeServerUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('Service URL is required.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS service URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Service URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) throw new Error('Service URL must not contain credentials.');
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Service URL must point to the server root without a path, query, or fragment.');
  }
  return url.origin;
}

function normalizeStore(value: unknown): ConnectionStore {
  const fallback = defaultConnectionStore();
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as { activeId?: unknown; servers?: unknown };
  const storedServers = Array.isArray(candidate.servers) ? candidate.servers : [];
  const servers: ServerConnection[] = [];
  for (const entry of storedServers) {
    try {
      const normalized = normalizeStoredConnection(entry);
      if (normalized && !servers.some(server => server.id === normalized.id)) servers.push(normalized);
    } catch {
      // Ignore an invalid saved endpoint without discarding the other ones.
    }
  }

  const storedThisServer = servers.find(server => server.id === THIS_SERVER_ID);
  const thisServer: ServerConnection = {
    id: THIS_SERVER_ID,
    name: 'This server',
    ...(storedThisServer?.token ? { token: storedThisServer.token } : {}),
  };
  const normalizedServers = [thisServer, ...servers.filter(server => server.id !== THIS_SERVER_ID)];
  const activeId = typeof candidate.activeId === 'string'
    && normalizedServers.some(server => server.id === candidate.activeId)
    ? candidate.activeId
    : THIS_SERVER_ID;
  return { activeId, servers: normalizedServers };
}

function normalizeStoredConnection(value: unknown): ServerConnection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { id?: unknown; name?: unknown; baseUrl?: unknown; token?: unknown };
  if (typeof candidate.id !== 'string' || !candidate.id) return undefined;
  const token = typeof candidate.token === 'string' && candidate.token ? candidate.token : undefined;
  if (candidate.id === THIS_SERVER_ID) {
    return { id: THIS_SERVER_ID, name: 'This server', ...(token ? { token } : {}) };
  }
  if (typeof candidate.name !== 'string' || typeof candidate.baseUrl !== 'string') return undefined;
  return {
    id: candidate.id,
    name: normalizeServerName(candidate.name),
    baseUrl: normalizeServerUrl(candidate.baseUrl),
    ...(token ? { token } : {}),
  };
}

function normalizeConnection(connection: ServerConnection): ServerConnection {
  const token = connection.token?.trim();
  if (connection.id === THIS_SERVER_ID) {
    return { id: THIS_SERVER_ID, name: 'This server', ...(token ? { token } : {}) };
  }
  return {
    id: connection.id,
    name: normalizeServerName(connection.name),
    baseUrl: normalizeServerUrl(connection.baseUrl ?? ''),
    ...(token ? { token } : {}),
  };
}

function migrateLegacyConnection(raw: string | null): ConnectionStore {
  if (!raw) return defaultConnectionStore();
  try {
    const legacy = JSON.parse(raw) as { baseUrl?: unknown; token?: unknown };
    const token = typeof legacy.token === 'string' && legacy.token ? legacy.token : undefined;
    if (typeof legacy.baseUrl !== 'string' || !legacy.baseUrl) {
      return {
        activeId: THIS_SERVER_ID,
        servers: [{ id: THIS_SERVER_ID, name: 'This server', ...(token ? { token } : {}) }],
      };
    }
    const baseUrl = normalizeServerUrl(legacy.baseUrl);
    const url = new URL(baseUrl);
    const remote: ServerConnection = {
      id: 'migrated-server',
      name: url.host,
      baseUrl,
      ...(token ? { token } : {}),
    };
    return {
      activeId: remote.id,
      servers: [{ id: THIS_SERVER_ID, name: 'This server' }, remote],
    };
  } catch {
    return defaultConnectionStore();
  }
}
