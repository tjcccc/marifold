import { useCallback, useEffect, useState } from 'react';
import type { Route } from '../lib/route';
import { formatPath, parseLegacyHash, parsePath } from '../lib/route';

/** React glue over the pure route parser: History API navigation with
 * Back/Forward support and one-time migration of legacy hash URLs. */
export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(readBrowserRoute);

  useEffect(() => {
    const syncRoute = (): void => {
      const next = readBrowserRoute();
      const canonicalPath = formatPath(next);
      if (window.location.pathname !== canonicalPath || window.location.hash) {
        window.history.replaceState(window.history.state, '', `${canonicalPath}${window.location.search}`);
      }
      setRoute(next);
    };

    syncRoute();
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('hashchange', syncRoute);
    return () => {
      window.removeEventListener('popstate', syncRoute);
      window.removeEventListener('hashchange', syncRoute);
    };
  }, []);

  const navigate = useCallback((next: Route) => {
    const path = formatPath(next);
    if (window.location.pathname !== path || window.location.search || window.location.hash) {
      window.history.pushState(null, '', path);
    }
    setRoute(next);
  }, []);

  return [route, navigate];
}

function readBrowserRoute(): Route {
  return parseLegacyHash(window.location.hash) ?? parsePath(window.location.pathname);
}
