import { describe, expect, it } from 'vitest';
import { markSourceCitations } from '../src/search/SourceCitations';

describe('source citation normalization', () => {
  it('marks only matching source URLs, allowing fragments and URL normalization', () => {
    expect(markSourceCitations('[Go](https://go.example/rank#top) [Other](https://go.example/about)', ['https://go.example/rank']))
      .toBe('[Go](https://go.example/rank#top "source") [Other](https://go.example/about)');
  });
  it('preserves code, existing titles, and unrelated links', () => {
    const source = '`[code](https://example.com)`\n```md\n[fenced](https://example.com)\n```\n[Title](https://example.com "source") [File](sandbox:/file)';
    expect(markSourceCitations(source, ['https://example.com'])).toBe(source);
  });
  it('does not mark links without successful source evidence', () => {
    const source = '[Title](https://example.com)';
    expect(markSourceCitations(source, [])).toBe(source);
    expect(markSourceCitations(source, ['invalid', 'file:///tmp/file'])).toBe(source);
  });
});
