// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/screens/agent/AgentScreen', () => ({
  AgentScreen: (props: {
    appName?: string;
    workspaceView: 'agent' | 'apps';
    onWorkspaceViewChange: (view: 'agent' | 'apps') => void;
  }) => (
    <div>
      <span data-testid="active-app">{props.appName ?? 'none'}</span>
      <span data-testid="workspace-view">{props.workspaceView}</span>
      <button onClick={() => props.onWorkspaceViewChange('agent')} type="button">Show Agent</button>
      <button onClick={() => props.onWorkspaceViewChange('apps')} type="button">Show Apps</button>
    </div>
  ),
}));

import { App } from '../../src/App';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/apps/short-article-generator');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('App workspace routing', () => {
  it('keeps the selected App supplied while Agent is visible and returns to its route', async () => {
    render(<App />);

    expect(screen.getByTestId('active-app').textContent).toBe('short-article-generator');
    fireEvent.click(screen.getByRole('button', { name: 'Show Agent' }));
    await waitFor(() => expect(window.location.pathname).toBe('/agent'));
    expect(screen.getByTestId('workspace-view').textContent).toBe('agent');
    expect(screen.getByTestId('active-app').textContent).toBe('short-article-generator');

    fireEvent.click(screen.getByRole('button', { name: 'Show Apps' }));
    await waitFor(() => expect(window.location.pathname).toBe('/apps/short-article-generator'));
    expect(screen.getByTestId('workspace-view').textContent).toBe('apps');
    expect(screen.getByTestId('active-app').textContent).toBe('short-article-generator');
  });
});
