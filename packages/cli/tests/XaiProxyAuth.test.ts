import { describe, expect, it, vi } from 'vitest';
import type { LoadedMarifoldConfig } from '@marifold/core';
import { TerminalStyle } from '../src/output/TerminalStyle';

vi.mock('../src/auth/XaiAuth', () => ({
  authorizeXaiWithBrowser: vi.fn(async () => ({
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiresAt: 123,
  })),
}));

import { authorizeXaiWithBrowser } from '../src/auth/XaiAuth';
import { reauthenticateOAuthProvider } from '../src/input/ModelPicker';

describe('xAI OAuth proxy', () => {
  it('uses the saved provider proxy for the browser token exchange', async () => {
    const loadedConfig = {
      configPath: '/tmp/config.toml',
      foundConfig: true,
      config: {
        default: {},
        paths: {},
        memory: {},
        agent: {},
        webSearch: {},
        providers: {
          xai: {
            type: 'openai-compatible',
            proxy: 'http://127.0.0.1:7890',
          },
        },
        models: { options: [] },
      },
    } as unknown as LoadedMarifoldConfig;

    await reauthenticateOAuthProvider(
      loadedConfig,
      () => { throw new Error('The mocked OAuth flow must not prompt.'); },
      new TerminalStyle(),
      'xai',
    );

    expect(authorizeXaiWithBrowser).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      { proxy: 'http://127.0.0.1:7890' },
    );
  });
});
