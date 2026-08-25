import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ConfigLoader, MarifoldRuntime, WorkspaceInitializer } from '@marifold/core';
import { App } from '../src/ui/App.js';

const tempDirs: string[] = [];
const delay = () => new Promise(resolve => setTimeout(resolve, 30));

function workspace(): { runtime: MarifoldRuntime; loadedConfig: ReturnType<ConfigLoader['load']> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-tui-app-'));
  tempDirs.push(dir);
  const configPath = path.join(dir, 'config.toml');
  new WorkspaceInitializer().initialize({
    configPath,
    profilesDir: path.join(dir, 'profiles'),
    sessionsDb: path.join(dir, 's.db'),
    tasksDir: path.join(dir, 'tasks'),
    schedulesDir: path.join(dir, 'sched'),
    skillsDir: path.join(dir, 'skills'),
    provider: 'ollama',
    model: 'test-model',
  });
  const loadedConfig = new ConfigLoader().load({ configPath });
  return { runtime: new MarifoldRuntime({ loadedConfig }), loadedConfig };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('App', () => {
  it('mounts, shows the header, and handles code-only commands incl. mode switch', async () => {
    const { runtime, loadedConfig } = workspace();
    const initial = {
      profile: 'default', displayName: 'Display Name', provider: 'ollama', model: 'test-model',
      think: false, cwd: '/tmp/work', version: '0.0.0-test',
    };
    const { lastFrame, stdin, unmount } = render(
      <App runtime={runtime} loadedConfig={loadedConfig} initial={initial} />,
    );
    await delay();

    // Mounts and renders the header (proves the full wiring renders without throwing).
    expect(lastFrame()).toContain('marifold');
    expect(lastFrame()).toContain('Display Name (default)');
    expect(lastFrame()).toContain('agent');

    // /status prints into the transcript (not a modal overlay).
    stdin.write('/status');
    await delay();
    stdin.write('\r');
    await delay();
    expect(lastFrame()).toContain('Profile:');

    // It stays in the transcript — typing does not dismiss it.
    stdin.write('x');
    await delay();
    expect(lastFrame()).toContain('Profile:');

    // /chat switches mode — the plan's required mode-switch smoke.
    stdin.write('/chat');
    await delay();
    stdin.write('\r');
    await delay();
    expect(lastFrame()).toContain('chat');

    unmount();
    runtime.close();
  });

  it('switches profile via the picker (Enter) and the direct /profile <name> form', async () => {
    const { runtime, loadedConfig } = workspace();
    const initial = { profile: 'default', provider: 'ollama', model: 'test-model', think: false, cwd: '/tmp/work', version: '0.0.0-test' };
    const { lastFrame, stdin, unmount } = render(
      <App runtime={runtime} loadedConfig={loadedConfig} initial={initial} />,
    );
    await delay();

    // Bare /profile opens the picker.
    stdin.write('/profile');
    await delay();
    stdin.write('\r');
    await delay();
    expect(lastFrame()).toContain('Select profile');

    // Enter selects the highlighted profile → confirmation in the transcript.
    stdin.write('\r');
    await delay();
    expect(lastFrame()).toContain('Switched to profile');

    // Direct form: /profile <name> switches without the picker.
    stdin.write('/profile default');
    await delay();
    stdin.write('\r');
    await delay();
    expect(lastFrame()).toContain('Switched to profile');

    unmount();
    runtime.close();
  });
});
