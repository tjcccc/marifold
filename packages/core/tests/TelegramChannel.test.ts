import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { TelegramChannel } from '../src/channels/TelegramChannel';
import type { TelegramBridge, TelegramBridgeStatus } from '../src/channels/TelegramBridge';
import type { LoadedMarifoldConfig, MarifoldConfig } from '../src/config/ConfigSchema';
import type { MarifoldRuntime } from '../src';

const TOKEN_A = '111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = '222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const dirs: string[] = [];

afterEach(() => { for (const dir of dirs.splice(0)) { rmSync(dir, { recursive: true, force: true }); } });

/** A bridge double that is busy until `finish()` is called. */
function fakeBridge(token: string) {
  let busy = true;
  let idle: () => void = () => undefined;
  const bridge = {
    token,
    stopped: false,
    start: () => undefined,
    stop: () => { bridge.stopped = true; },
    status: (): TelegramBridgeStatus => ({ polling: !bridge.stopped, busy, ignoredSenders: [] }),
    whenIdle: () => busy ? new Promise<void>(resolve => { idle = resolve; }) : Promise.resolve(),
    finish: () => { busy = false; idle(); },
  };
  return bridge;
}

describe('TelegramChannel', () => {
  it('defers a token restart until the current reply finishes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'marifold-tg-'));
    dirs.push(dir);
    const loadedConfig = {
      config: {
        default: { provider: 'ollama', model: 'gemma4:e4b', profile: 'default', deep: false },
        models: { options: [] },
        memory: { sizeLimit: 50000, contextLimit: 2400 },
        paths: { profilesDir: join(dir, 'profiles') },
        providers: {},
        channels: { telegram: { botToken: TOKEN_A, allowlist: [42], profile: 'default', defaultMode: 'agent' } },
      } as unknown as MarifoldConfig,
      configPath: join(dir, 'config.toml'),
      foundConfig: true,
    } as LoadedMarifoldConfig;
    const bridges: Array<ReturnType<typeof fakeBridge>> = [];
    const channel = new TelegramChannel({
      runtime: {} as MarifoldRuntime,
      loadedConfig,
      createBridge: token => {
        const bridge = fakeBridge(token);
        bridges.push(bridge);
        return bridge as unknown as TelegramBridge;
      },
    });
    channel.start();
    expect(bridges.map(b => b.token)).toEqual([TOKEN_A]);

    const view = channel.update({ botToken: TOKEN_B });
    expect(view.state).toBe('restarting');
    expect(bridges[0].stopped).toBe(false);

    bridges[0].finish();
    await new Promise(resolve => setImmediate(resolve));
    expect(bridges[0].stopped).toBe(true);
    expect(bridges.map(b => b.token)).toEqual([TOKEN_A, TOKEN_B]);
    expect(channel.view().state).toBe('polling');
    channel.stop();
  });
});
