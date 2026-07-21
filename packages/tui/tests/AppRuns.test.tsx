import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedMarifoldConfig, MarifoldRuntime, SessionDetail, SessionSummary } from '@marifold/core';
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

function makeRuntime(opts: {
  agentRun?: (call: RunnerCall) => AsyncGenerator<unknown>;
  sessions?: SessionSummary[];
  sessionDetail?: SessionDetail;
} = {}) {
  const runSpy = vi.fn();
  const streamSpy = vi.fn();

  const defaultRun = async function* (): AsyncGenerator<unknown> {
    yield { type: 'done', taskId: 't', status: 'completed' };
  };

  const runtime = {
    listSkills: () => [],
    listProfiles: () => [{ name: 'default' }],
    listSessions: () => opts.sessions ?? [],
    getSession: (id: string) => opts.sessionDetail?.id === id ? opts.sessionDetail : undefined,
    resolveSettings: ({ profile }: { profile: string }) => ({ profile, provider: 'p', model: 'm', mode: 'agent' as Mode, think: false }),
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

  it('/retry re-runs the last message (the prompt, not the "/retry" echo)', async () => {
    const { runtime, streamSpy } = makeRuntime();
    const { stdin, unmount } = render(<App runtime={runtime} loadedConfig={config} initial={initial('chat')} />);
    await delay();
    stdin.write('hello');
    await delay();
    stdin.write('\r');
    await vi.waitFor(() => expect(streamSpy).toHaveBeenCalledTimes(1));
    await delay(); // let the run settle so `running` clears before /retry
    stdin.write('/retry');
    await delay();
    stdin.write('\r');
    await vi.waitFor(() => expect(streamSpy).toHaveBeenCalledTimes(2));
    // The re-run replays the prior prompt, not the command echo.
    expect(streamSpy.mock.calls[1][0]).toMatchObject({ prompt: 'hello' });
    unmount();
  });

  it('/attach-original sends its prompt with the one-turn image bypass', async () => {
    const { runtime, runSpy } = makeRuntime();
    const { stdin, unmount } = render(<App runtime={runtime} loadedConfig={config} initial={initial('agent')} />);
    await delay();
    stdin.write('/attach-original inspect this');
    await delay();
    stdin.write('\r');
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalled());
    expect(runSpy.mock.calls[0][0]).toMatchObject({ objective: 'inspect this', originalImages: true });
    unmount();
  });

  it('/resume opens recent sessions by preview and continues the selected transcript', async () => {
    const summary: SessionSummary = {
      id: 'session-12345678', profileName: 'default', turnCount: 2,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      preview: 'Earlier question about Fedora',
    };
    const detail: SessionDetail = {
      ...summary,
      turns: [
        { role: 'user', content: 'Earlier question about Fedora', timestamp: summary.createdAt },
        { role: 'assistant', content: 'Earlier answer', timestamp: summary.updatedAt },
      ],
    };
    const { runtime } = makeRuntime({ sessions: [summary], sessionDetail: detail });
    const { stdin, lastFrame, unmount } = render(<App runtime={runtime} loadedConfig={config} initial={initial('agent')} />);
    await delay();
    stdin.write('/resume');
    await delay();
    stdin.write('\r');
    await delay();
    expect(lastFrame()).toContain('Resume session');
    expect(lastFrame()).toContain('Earlier question about Fedo');
    stdin.write('\r');
    await delay();
    expect(lastFrame()).toContain('Earlier answer');
    expect(lastFrame()).toContain('Resumed session session-');
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
