import { describe, expect, it } from 'vitest';
import { isUnfulfilledSearchPromise } from '../src/search/WebResearchContinuation';

describe('search promise recovery scope', () => {
  it.each(['I need to search for the article.', 'Let me look up the original.', '我需要搜索原文，才能对此议题进行看法。'])(
    'recognizes an unfulfilled promise: %s', text => expect(isUnfulfilledSearchPromise(text)).toBe(true));
  it.each(['Hello!', 'The source reports a temperature of 24°C.', 'I cannot search the web.', '我不需要搜索。', '> I need to search.', 'You should search for the original.'])(
    'leaves ordinary answers and limitations alone: %s', text => expect(isUnfulfilledSearchPromise(text)).toBe(false));
});
