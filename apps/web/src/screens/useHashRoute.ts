import { useCallback, useEffect, useState } from 'react';
import type { Route } from '../lib/hashRoute';
import { formatHash, parseHash } from '../lib/hashRoute';

/** React glue over the pure lib/hashRoute pair: hashchange ↔ state, so
 * back/forward and deep links work without a router dependency. */
export function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    const hash = formatHash(next);
    if (window.location.hash !== hash) window.location.hash = hash;
    setRoute(next);
  }, []);

  return [route, navigate];
}
