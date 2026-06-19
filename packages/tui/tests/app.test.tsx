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
    const initial = { profile: 'default', provider: 'ollama', model: 'test-model', think: false, cwd: '/tmp/work', version: '0.0.0-test' };
    const { lastFrame, stdin, unmount } = render(
      <App runtime={runtime} loadedConfig={loadedConfig} initial={initial} />,
    );
    await delay();

    // Mounts and renders the header (proves the full wiring renders without throwing).
    expect(lastFrame()).toContain('marifold');
    expect(lastFrame()).toContain('default');
    expect(lastFrame()).toContain('agent');

    // /help opens the read-only help overlay.
    stdin.write('/help');
    await delay();
    stdin.write('\r');
    await delay();
    expect(lastFrame()).toContain('Help');

    // Any key closes the overlay back to the input box.
    stdin.write('');
    await delay();
    expect(lastFrame()).not.toContain('Help');

    // /chat switches mode — the plan's required mode-switch smoke.
    stdin.write('/chat');
    await delay();
    stdin.write('\r');
    await delay();
    expect(lastFrame()).toContain('chat');

    unmount();
    runtime.close();
  });
});
