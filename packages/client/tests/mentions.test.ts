import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { matchMention, mentionTokens } from '../src/mentions';

describe('mentions', () => {
  // The host routes with core's parser; a preview that parsed differently
  // would show the wrong speaker.
  it('is the same file as the host parser in core', () => {
    const read = (file: string) => fs.readFileSync(path.join(__dirname, file), 'utf8');
    expect(read('../src/mentions.ts')).toBe(read('../../core/src/agent/Mentions.ts'));
  });

  it('matches a roster name before punctuation', () => {
    const [mention] = mentionTokens('ask @dev_test, then `@painter`');
    expect(matchMention(mention!, ['dev_test', 'painter'], name => [name]).targets).toEqual(['dev_test']);
    expect(mentionTokens('ask @dev_test, then `@painter`')).toHaveLength(1);
  });
});
