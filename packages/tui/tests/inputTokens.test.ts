import { expect, it } from 'vitest';
import { inputTokens } from '../src/core/inputTokens.js';

it('finds inline and multiline skill/command ranges while excluding paths and embedded sigils', () => {
  const text = 'Update $make-\n/help /tmp/file https://site/path word$skill $';
  expect(inputTokens(text).map(token => text.slice(token.start, token.end))).toEqual(['$make-', '/help', '$']);
});
