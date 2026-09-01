// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useRoute } from '../../src/screens/useRoute';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('useRoute', () => {
  it('navigates with clean paths and follows browser history events', () => {
    window.history.replaceState(null, '', '/agent/default/session_1');
    render(<RouteHarness />);
    expect(screen.getByTestId('route').textContent).toBe('agent:default:session_1');

    fireEvent.click(screen.getByText('Open Apps'));
    expect(window.location.pathname).toBe('/apps');
    expect(window.location.hash).toBe('');
    expect(screen.getByTestId('route').textContent).toBe('apps');

    window.history.pushState(null, '', '/apps/painers-room');
    fireEvent(window, new PopStateEvent('popstate'));
    expect(screen.getByTestId('route').textContent).toBe('apps:painers-room');

    window.history.pushState(null, '', '/config/models');
    fireEvent(window, new PopStateEvent('popstate'));
    expect(screen.getByTestId('route').textContent).toBe('config:models');
  });

  it('migrates a legacy hash bookmark to its canonical clean path', async () => {
    window.history.replaceState(null, '', '/#/config/painter');
    render(<RouteHarness />);
    expect(screen.getByTestId('route').textContent).toBe('config:profiles:painter');

    await waitFor(() => {
      expect(window.location.pathname).toBe('/config/profiles/painter');
      expect(window.location.hash).toBe('');
    });
  });
});

function RouteHarness() {
  const [route, navigate] = useRoute();
  const label = route.view === 'agent'
    ? ['agent', route.profile, route.session].filter(Boolean).join(':')
    : route.view === 'config'
      ? ['config', route.section, route.item].filter(Boolean).join(':')
      : ['apps', route.app].filter(Boolean).join(':');
  return (
    <>
      <span data-testid="route">{label}</span>
      <button onClick={() => navigate({ view: 'apps' })}>Open Apps</button>
    </>
  );
}
