import { PassThrough } from 'node:stream';
import { render as renderTerminal } from 'ink';
import { sessionPromptHistory } from '../src/core/promptHistory.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ConfigLoader, MarifoldRuntime, SessionResolver, WorkspaceInitializer } from '@marifold/core';
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
  it('blocks a resumed session held by another runtime and clears its transcript', async () => {
    const { runtime: owner, loadedConfig } = workspace();
    const second = new MarifoldRuntime({ loadedConfig });
    owner.acquireSession('occupied');
    const { lastFrame, unmount } = render(<App runtime={second} loadedConfig={loadedConfig} initial={{
      profile: 'default', provider: 'ollama', model: 'test-model', think: false,
      cwd: '/tmp/work', version: 'test', sessionId: 'occupied',
      transcript: [{ kind: 'assistant', text: 'other client conversation' }],
    }} />);
    try {
      await vi.waitFor(() => expect(lastFrame()).toContain('in use in another page or terminal'));
      expect(lastFrame()).not.toContain('other client conversation');
      expect(() => owner.acquireSession('occupied')).not.toThrow();
    } finally { unmount(); second.close(); owner.close(); }
  });

  it('sends only image #3 from a recalled prompt with two unused missing paths', async () => {
    const { runtime, loadedConfig } = workspace();
    const runner = runtime.createAgentRunner('default');
    const run = vi.spyOn(runner, 'run').mockImplementation(async function* () {});
    const createRunner = vi.spyOn(runtime, 'createAgentRunner').mockReturnValue(runner);
    const { stdin, unmount } = render(<App runtime={runtime} loadedConfig={loadedConfig} initial={{
      profile: 'default', provider: 'ollama', model: 'test-model', think: false,
      cwd: '/tmp/work', version: 'test', history: [{ text: 'describe [image #3]',
        images: ['/tmp/missing-first.png', '/tmp/missing-second.png', '/tmp/current.png'] }],
    }} />);
    try {
      await delay();
      stdin.write('\x1b[A');
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0][0]).toMatchObject({ objective: 'describe [image #1]', images: [{ path: '/tmp/current.png' }] });
    } finally { unmount(); run.mockRestore(); createRunner.mockRestore(); runtime.close(); }
  });

  it('reattaches a dropped image when a sent prompt is recalled and edited', async () => {
    const { runtime, loadedConfig } = workspace();
    const image = path.join(tempDirs.at(-1)!, 'source.png');
    fs.writeFileSync(image, 'fixture');
    const runner = runtime.createAgentRunner('default');
    const run = vi.spyOn(runner, 'run').mockImplementation(async function* () {});
    const createRunner = vi.spyOn(runtime, 'createAgentRunner').mockReturnValue(runner);
    const { stdin, unmount } = render(<App runtime={runtime} loadedConfig={loadedConfig} initial={{
      profile: 'default', provider: 'ollama', model: 'test-model',
      think: false, cwd: '/tmp/work', version: '0.0.0-test',
    }} />);
    try {
      await delay();
      stdin.write(image);
      await delay();
      stdin.write(' describe');
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      await delay();
      stdin.write('\x1b[A');
      await delay();
      stdin.write(' in pink');
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      expect(run.mock.calls[0][0].images).toEqual([{ path: image }]);
      expect(run.mock.calls[1][0]).toMatchObject({
        objective: '[image #1] describe in pink', images: [{ path: image }],
      });
    } finally { unmount(); run.mockRestore(); createRunner.mockRestore(); runtime.close(); }
  });

  it.each(['startup', 'picker'])('recalls saved prompts and lazily restores images after %s resume', async mode => {
    const { runtime, loadedConfig } = workspace();
    const sessions = new SessionResolver(loadedConfig.config.paths.sessionsDb);
    await sessions.appendExchange('saved', 'default', 'first prompt', 'first answer');
    await sessions.appendExchange('saved', 'default', 'describe [image #1]', 'second answer', [{ data: 'aW1hZ2U=', mediaType: 'image/png' }]);
    await sessions.appendExchange('saved', 'default', 'newer [image #1]', 'newer answer', [{ data: 'bmV3ZXI=', mediaType: 'image/png' }]);
    sessions.close();
    const saved = runtime.getSession('saved')!;
    const attachment = vi.spyOn(runtime, 'getSessionAttachment');
    const runner = runtime.createAgentRunner('default');
    const run = vi.spyOn(runner, 'run').mockImplementation(async function* () {});
    const createRunner = vi.spyOn(runtime, 'createAgentRunner').mockReturnValue(runner);
    const { stdin, lastFrame, unmount } = render(<App runtime={runtime} loadedConfig={loadedConfig} initial={{
      profile: 'default', provider: 'ollama', model: 'test-model',
      think: false, cwd: '/tmp/work', version: '0.0.0-test',
      ...(mode === 'startup' ? {
        sessionId: saved.id,
        transcript: saved.turns.map(turn => ({ kind: turn.role, text: turn.content })),
        history: sessionPromptHistory(saved),
      } : {}),
    }} />);
    try {
      await delay();
      if (mode === 'picker') {
        stdin.write('/resume');
        await delay();
        stdin.write('\r');
        await vi.waitFor(() => expect(lastFrame()).toContain('Resume session'));
        stdin.write('\r');
        await vi.waitFor(() => expect(lastFrame()).toContain('Resumed session saved'));
      }
      stdin.write('\x1b[A'); // newer upload with the same image number
      await delay();
      stdin.write('\x1b[A'); // original image-bearing prompt
      await delay();
      stdin.write('\x1b[A'); // previous saved prompt
      await delay();
      stdin.write('\x1b[B'); // back to latest
      await delay();
      expect(attachment).not.toHaveBeenCalled();
      stdin.write(' in pink');
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0][0]).toMatchObject({
        sessionId: 'saved', objective: 'describe [image #1] in pink',
        images: [{ data: 'aW1hZ2U=', mediaType: 'image/png' }],
      });
      expect(attachment).toHaveBeenCalledWith('saved', 1, 0);
    } finally { unmount(); run.mockRestore(); createRunner.mockRestore(); attachment.mockRestore(); runtime.close(); }
  });

  it.each(['recalled orphan', 'typed reference'])('rejects a %s without its own attachment after restart', async mode => {
    const { runtime, loadedConfig } = workspace();
    const sessions = new SessionResolver(loadedConfig.config.paths.sessionsDb);
    await sessions.appendExchange('saved', 'default', 'original [image #1]', 'answer', [{ data: 'aW1hZ2U=', mediaType: 'image/png' }]);
    await sessions.appendExchange('saved', 'default', 'describe [image #1]', 'missing image');
    sessions.close();
    const saved = runtime.getSession('saved')!;
    const runner = runtime.createAgentRunner('default');
    const run = vi.spyOn(runner, 'run').mockImplementation(async function* () {});
    const createRunner = vi.spyOn(runtime, 'createAgentRunner').mockReturnValue(runner);
    const { stdin, lastFrame, unmount } = render(<App runtime={runtime} loadedConfig={loadedConfig} initial={{
      profile: 'default', provider: 'ollama', model: 'test-model', think: false,
      cwd: '/tmp/work', version: 'test', sessionId: saved.id, history: sessionPromptHistory(saved),
    }} />);
    try {
      await delay();
      stdin.write(mode === 'recalled orphan' ? '\x1b[A' : 'describe [image #1]');
      await delay();
      stdin.write('\r');
      await vi.waitFor(() => expect(lastFrame()).toContain('without a matching attachment'));
      expect(run).not.toHaveBeenCalled();
    } finally { unmount(); run.mockRestore(); createRunner.mockRestore(); runtime.close(); }
  });

  it('redraws the alternate screen after width and height changes without losing the draft', async () => {
    const { runtime, loadedConfig } = workspace();
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 24 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    let output = '';
    stdout.on('data', chunk => { output += chunk.toString(); });
    const app = renderTerminal(<App runtime={runtime} loadedConfig={loadedConfig} fullscreen initial={{
      profile: 'default', provider: 'ollama', model: 'test-model',
      think: false, cwd: '/tmp/work', version: '0.0.0-test',
      transcript: [{ kind: 'assistant', text: 'A response that wraps as terminal geometry changes. '.repeat(4) }],
    }} />, { stdin, stdout, stderr: new PassThrough(), alternateScreen: true, incrementalRendering: true, exitOnCtrlC: false, patchConsole: false });
    try {
      await vi.waitFor(() => expect(output).toContain('message the agent'));
      stdin.write('resize draft');
      await vi.waitFor(() => expect(output).toContain('resize draft'));
      for (const [columns, rows] of [[40, 18], [120, 30], [120, 20]]) {
        const count = output.split('\x1b[?1049h').length;
        stdout.columns = columns;
        stdout.rows = rows;
        stdout.emit('resize');
        await vi.waitFor(() => expect(output.split('\x1b[?1049h').length).toBeGreaterThan(count));
        const fresh = output.slice(output.lastIndexOf('\x1b[?1049h'));
        expect(fresh).toContain('resize draft');
        expect(fresh).toContain('geometry changes.');
        expect(fresh.split('resize draft')).toHaveLength(2);
        expect(fresh.split('\n').length).toBeLessThanOrEqual(rows);
      }
    } finally { app.unmount(); await app.waitUntilExit(); runtime.close(); stdin.destroy(); stdout.destroy(); }
  });

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
    expect(lastFrame()).not.toContain('Mode:');

    // It stays in the transcript — typing does not dismiss it.
    stdin.write('x');
    await delay();
    expect(lastFrame()).toContain('Profile:');

    unmount();
    runtime.close();
  });

  it('preserves the full-screen draft when Ctrl+L redraws the terminal', async () => {
    const { runtime, loadedConfig } = workspace();
    const initial = { profile: 'default', provider: 'ollama', model: 'test-model', think: false, cwd: '/tmp/work', version: '0.0.0-test' };
    const { lastFrame, stdin, unmount } = render(<App runtime={runtime} loadedConfig={loadedConfig} initial={initial} fullscreen />);
    try {
      await vi.waitFor(() => expect(lastFrame()).toContain('marifold'));
      stdin.write('keep this draft');
      await vi.waitFor(() => expect(lastFrame()).toContain('keep this draft'));
      stdin.write('\x0c');
      await delay();
      await vi.waitFor(() => expect(lastFrame()).toContain('keep this draft'));
    } finally { unmount(); runtime.close(); }
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

  it('installs skills globally by default and only scopes them with --profile', async () => {
    const { runtime, loadedConfig } = workspace();
    const root = path.dirname(loadedConfig.configPath);
    const globalSource = path.join(root, 'global-skill.md');
    const profileSource = path.join(root, 'profile-skill.md');
    fs.writeFileSync(globalSource, '---\nname: everywhere\ndescription: Global test.\n---\n\nHelp everywhere.\n');
    fs.writeFileSync(profileSource, '---\nname: private-helper\ndescription: Profile test.\n---\n\nHelp this profile.\n');
    const initial = { profile: 'default', provider: 'ollama', model: 'test-model', think: false, cwd: root, version: '0.0.0-test' };
    const { stdin, unmount } = render(
      <App runtime={runtime} loadedConfig={loadedConfig} initial={initial} />,
    );
    await delay();

    stdin.write(`/install-skill ${globalSource}`);
    await delay();
    stdin.write('\r');
    await delay();
    expect(fs.existsSync(path.join(loadedConfig.config.paths.skillsDir!, 'everywhere', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(loadedConfig.config.paths.profilesDir, 'default', 'skills', 'everywhere', 'SKILL.md'))).toBe(false);

    stdin.write(`/install-skill --profile default ${profileSource}`);
    await delay();
    stdin.write('\r');
    await delay();
    expect(fs.existsSync(path.join(loadedConfig.config.paths.profilesDir, 'default', 'skills', 'private-helper', 'SKILL.md'))).toBe(true);

    unmount();
    runtime.close();
  });
});
