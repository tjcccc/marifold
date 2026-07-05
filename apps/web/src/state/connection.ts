/** Connection settings persisted locally: service base URL + bearer token.
 * The token never leaves the browser except as the authorization header. */
export interface ConnectionSettings {
  baseUrl?: string;
  token?: string;
}

const STORAGE_KEY = 'marifold.connection';

export function loadConnection(): ConnectionSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ConnectionSettings;
    return {
      ...(typeof parsed.baseUrl === 'string' && parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
      ...(typeof parsed.token === 'string' && parsed.token ? { token: parsed.token } : {}),
    };
  } catch {
    return {};
  }
}

export function saveConnection(settings: ConnectionSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Non-persistent storage — the in-page connection still works.
  }
}
