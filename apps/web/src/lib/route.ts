/** Small dependency-free route model for the desktop Web UI. Pure path
 * parsing/formatting lives here; browser History API glue lives in screens. */

export type ConfigSection = 'profiles' | 'providers' | 'models' | 'agent' | 'web-search' | 'appearance' | 'service';

export type Route =
  | { view: 'agent'; profile?: string; session?: string }
  | { view: 'apps' }
  | { view: 'config'; section: ConfigSection; item?: string };

const CONFIG_SECTIONS: ConfigSection[] = ['profiles', 'providers', 'models', 'agent', 'web-search', 'appearance', 'service'];
const LEGACY_HASH_ROUTE = /^#\/(?:agent|apps|config)(?:\/|$)/;

export function parsePath(pathname: string): Route {
  const parts = pathname
    .replace(/^\/?/, '')
    .split('/')
    .map(part => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .filter(part => part.length > 0);

  switch (parts[0]) {
    case 'apps':
      return { view: 'apps' };
    case 'config': {
      const section = CONFIG_SECTIONS.find(candidate => candidate === parts[1]);
      if (section) {
        return { view: 'config', section, ...(parts[2] ? { item: parts[2] } : {}) };
      }
      // Preserve the old /config/<profile> deep-link shape.
      if (parts[1]) return { view: 'config', section: 'profiles', item: parts[1] };
      return { view: 'config', section: 'profiles' };
    }
    case 'agent':
    default:
      return {
        view: 'agent',
        ...(parts[1] ? { profile: parts[1] } : {}),
        ...(parts[2] ? { session: parts[2] } : {}),
      };
  }
}

export function formatPath(route: Route): string {
  switch (route.view) {
    case 'apps':
      return '/apps';
    case 'config': {
      const parts = ['/config', route.section];
      if (route.item) parts.push(encodeURIComponent(route.item));
      return parts.join('/');
    }
    case 'agent': {
      const parts = ['/agent'];
      if (route.profile) {
        parts.push(encodeURIComponent(route.profile));
        if (route.session) parts.push(encodeURIComponent(route.session));
      }
      return parts.join('/');
    }
  }
}

/** Recognize bookmarks made before clean History API routes were introduced. */
export function parseLegacyHash(hash: string): Route | undefined {
  if (!LEGACY_HASH_ROUTE.test(hash)) return undefined;
  return parsePath(hash.slice(1));
}
