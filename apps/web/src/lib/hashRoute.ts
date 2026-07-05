/** Hand-rolled hash routing — three views and two params don't justify a
 * router dependency. Pure parse/format pair; the React glue lives in
 * screens (useHashRoute). */
export type Route =
  | { view: 'agent'; profile?: string; session?: string }
  | { view: 'apps' }
  | { view: 'config'; profile?: string };

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
    case 'config':
      return { view: 'config', ...(parts[1] ? { profile: parts[1] } : {}) };
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
    case 'config':
      return route.profile ? `#/config/${encodeURIComponent(route.profile)}` : '#/config';
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
