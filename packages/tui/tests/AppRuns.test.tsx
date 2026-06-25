import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedMarifoldConfig, MarifoldRuntime } from '@marifold/core';
import { App } from '../src/ui/App.js';
import type { Mode } from '../src/core/appState.js';

// Run-routing coverage for the App controller. The companion App.test.tsx uses a
// real runtime for code-only commands (which never call a model); these tests fake
// the runtime so the message → chat/agent dispatch, `/steps` arming, and `/stop`
// wiring can be asserted without a provider or a real terminal. ink-testing-library
// renders to an in-memory frame buffer and accepts keystrokes via stdin.write.

interface RunnerCall {
  objective: string;
  forcePlan?: boolean;
  signal: AbortSignal;
  [key: string]: unknown;
}

function makeRuntime(opts: { agentRun?: (call: RunnerCall) => AsyncGenerator<unknown> } = {}) {
  const runSpy = vi.fn();
  const streamSpy = vi.fn();

  const defaultRun = async function* (): AsyncGenerator<unknown> {
    yield { type: 'done', taskId: 't', status: 'completed' };
  };

  const runtime = {
    listSkills: () => [],
    listProfiles: () => [{ name: 'default' }],
    listSessions: () => [],
    resolveSettings: ({ profile }: { profile: string }) => ({ profile, provider: 'p', model: 'm', mode: 'agent' as Mode }),
    createAgentRunner: () => ({
      run: (call: RunnerCall) => {
        runSpy(call);
        return (opts.agentRun ?? defaultRun)(call);
      },
    }),
    stream: (request: { prompt: string }, onSummary?: (s: { usage?: unknown }) => void) => {
      streamSpy(request);
      return (async function* () {
        yield 'hi';
        onSummary?.({ usage: {} });
      })();
    },
  };

  return { runtime: runtime as unknown as MarifoldRuntime, runSpy, streamSpy };
}

const config = {
  configPath: '/tmp/config.toml',
  config: {
    models: { options: [] },
    providers: {},
    agent: {},
    paths: { profilesDir: '/tmp/profiles' },
    default: { provider: 'p', model: 'm' },
  },
} as unknown as LoadedMarifoldConfig;

function initial(mode: Mode) {
  return { profile: 'default', provider: 'p', model: 'm', think: false, mode, cwd: '/tmp', version: '0.0.0-test' };
}

const delay = () => new Promise(resolve => setTimeout(resolve, 30));

describe('App run routing', () => {
  it('seeds the context gauge from the launch budget (inherited from config/profile)', async () => {
    const { runtime } = makeRuntime();
    const { lastFrame, unmount } = render(
      <App runtime={runtime} loadedConfig={config} initial={{ ...initial('chat'), maxContextTokens: 16000 }} />,
    );
    await delay();
    // The gauge shows the budget at launch, before any turn is measured.
    expect(lastFrame()).toContain('ctx –/16K');
    unmount();
  });

  it('routes a plain message to the agent in agent mode (no forced plan)', async () => {
    const { runtime, runSpy, streamSpy } = makeRuntime();
    const { stdin, unmount } = render(<App runtime={runtime} loadedConfig={config} initial={initial('agent')} />);
    await delay();
    stdin.write('hello');
    await delay();
    stdin.write('\r');
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalled());
    expect(runSpy.mock.calls[0][0]).toMatchObject({ objective: 'hello' });
    expect(runSpy.mock.calls[0][0].forcePlan).toBeUndefined();
    expect(streamSpy).not.toHaveBeenCalled();
    unmount();
  });

  it('routes a plain message to chat (stream) in chat mode', async () => {
    const { runtime, runSpy, streamSpy } = makeRuntime();
    const { stdin, unmount } = render(<App runtime={runtime} loadedConfig={config} initial={initial('chat')} />);
    await delay();
    stdin.write('hello');
    await delay();
    stdin.write('\r');
    await vi.waitFor(() => expect(streamSpy).toHaveBeenCalled());
    expect(streamSpy.mock.calls[0][0]).toMatchObject({ prompt: 'hello' });
    expect(runSpy).not.toHaveBeenCalled();
    unmount();
  });

  it('/steps arms a one-shot forced plan for the next message', async () => {
    const { runtime, runSpy } = makeRuntime();
    const { stdin, unmount } = render(<App runtime={runtime} loadedConfig={config} initial={initial('agent')} />);
    await delay();
    stdin.write('/steps');
    await delay();
    stdin.write('\r');
    await delay();
    stdin.write('hello');
    await delay();
    stdin.write('\r');
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalled());
    expect(runSpy.mock.calls[0][0]).toMatchObject({ objective: 'hello', forcePlan: true });
    unmount();
  });

  it('/stop aborts the in-flight run', async () => {
    let captured: AbortSignal | undefined;
    const blockingRun = (call: RunnerCall) => {
      captured = call.signal;
      return (async function* (): AsyncGenerator<unknown> {
        await new Promise<void>(resolve => call.signal.addEventListener('abort', () => resolve()));
      })();
    };
    const { runtime, runSpy } = makeRuntime({ agentRun: blockingRun });
    const { stdin, unmount } = render(<App runtime={runtime} loadedConfig={config} initial={initial('agent')} />);
    await delay();
    stdin.write('hello');
    await delay();
    stdin.write('\r');
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalled());
    expect(captured?.aborted).toBe(false);
    stdin.write('/stop');
    await delay();
    stdin.write('\r');
    await vi.waitFor(() => expect(captured?.aborted).toBe(true));
    unmount();
  });
});
