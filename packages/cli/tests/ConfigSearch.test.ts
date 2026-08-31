import { describe, expect, it } from 'vitest';
import { searchUpdateFromFlags } from '../src/commands/config';

describe('config search flags', () => {
  it('selects Ollama Cloud with its conventional API-key environment variable', () => {
    expect(searchUpdateFromFlags({ provider: 'ollama' })).toEqual({
      provider: 'ollama',
      enabled: true,
      apiKeyEnv: 'OLLAMA_API_KEY',
    });
  });

  it('preserves an explicit Ollama Cloud API-key environment variable', () => {
    expect(searchUpdateFromFlags({
      provider: 'ollama',
      apiKeyEnv: 'MY_OLLAMA_SEARCH_KEY',
    })).toEqual({
      provider: 'ollama',
      enabled: true,
      apiKeyEnv: 'MY_OLLAMA_SEARCH_KEY',
    });
  });
});
