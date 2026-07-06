/** Hand-rolled hash routing — three views and a few params don't justify a
 * router dependency. Pure parse/format pair; the React glue lives in
 * screens (useHashRoute). */

export type ConfigSection = 'profiles' | 'providers' | 'models' | 'service';

export type Route =
  | { view: 'agent'; profile?: string; session?: string }
  | { view: 'apps' }
  | { view: 'config'; section: ConfigSection; item?: string };

const CONFIG_SECTIONS: ConfigSection[] = ['profiles', 'providers', 'models', 'service'];

export function parseHash(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, '')
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
      // Legacy `#/config/<profile>` deep links land on the profiles section.
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

export function formatHash(route: Route): string {
  switch (route.view) {
    case 'apps':
      return '#/apps';
    case 'config': {
      const parts = ['#/config', route.section];
      if (route.item) parts.push(encodeURIComponent(route.item));
      return parts.join('/');
    }
    case 'agent': {
      const parts = ['#/agent'];
      if (route.profile) {
        parts.push(encodeURIComponent(route.profile));
        if (route.session) parts.push(encodeURIComponent(route.session));
      }
      return parts.join('/');
    }
  }
}
