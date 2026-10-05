import { expect, it } from 'vitest';
import { composerTokenBefore } from '../src/composerTokens';

it.each(['$some-skill', '/help', '[image #1]', '\n$some-skill'])('finds whole tokens at the caret: %s', text => {
  const token = composerTokenBefore(text, text.length)!;
  expect(text.slice(token.start, token.end)).toBe(text.trim());
});

it('preserves ordinary text, paths, and editing within tokens', () => {
  expect(composerTokenBefore('word', 4)).toBeUndefined();
  expect(composerTokenBefore('/tmp/image.png', 14)).toBeUndefined();
  expect(composerTokenBefore('$some-skill', 5)).toBeUndefined();
  expect(composerTokenBefore('cost$some', 9)).toBeUndefined();
});
