import { describe, expect, it } from 'vitest';
import { formatDuration, formatElapsed, formatRelativeTime, formatTokens } from '../../src/lib/format';
import { formatHash, parseHash } from '../../src/lib/hashRoute';
import { parseInline, parseMarkdown } from '../../src/lib/markdown';
import { resolveEffectivePermissions } from '../../src/lib/permissions';

describe('hashRoute', () => {
  it('round-trips every route shape', () => {
    const routes = [
      { view: 'agent' as const },
      { view: 'agent' as const, profile: 'default' },
      { view: 'agent' as const, profile: 'writing helper', session: 'sess/1' },
      { view: 'apps' as const },
      { view: 'config' as const },
      { view: 'config' as const, profile: 'default' },
    ];
    for (const route of routes) {
      expect(parseHash(formatHash(route))).toEqual(route);
    }
  });

  it('defaults unknown or empty hashes to the agent view', () => {
    expect(parseHash('')).toEqual({ view: 'agent' });
    expect(parseHash('#/nonsense')).toEqual({ view: 'agent' });
  });
});

describe('format', () => {
  it('formats durations, elapsed clocks, and token counts', () => {
    expect(formatDuration(8_000)).toBe('8s');
    expect(formatDuration(84_000)).toBe('1m 24s');
    expect(formatDuration(3_720_000)).toBe('1h 2m');
    expect(formatElapsed(84_000)).toBe('1:24');
    expect(formatTokens(943)).toBe('943');
    expect(formatTokens(12_444)).toBe('12.4k');
    expect(formatTokens(204_800)).toBe('205k');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-07-05T12:00:00Z');
    expect(formatRelativeTime('2026-07-05T11:59:40Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-07-05T11:10:00Z', now)).toBe('50m ago');
    expect(formatRelativeTime('2026-07-05T03:00:00Z', now)).toBe('9h ago');
    expect(formatRelativeTime('2026-07-04T09:00:00Z', now)).toBe('yesterday');
  });
});

describe('permissions', () => {
  it('merges defaults < global < profile and unions trusted folders', () => {
    const effective = resolveEffectivePermissions(
      {
        approval: { read: 'allow', write: 'ask', shell: 'deny', network: 'ask', delegate: 'allow' },
        trustedFolders: ['/a'],
        maxIterations: 20,
        toolOutputLimit: 100000,
        toolMode: 'auto',
      },
      { approval: { write: 'allow' }, trustedFolders: ['/a', '/b'] },
    );
    expect(effective.approval).toEqual({ read: 'allow', write: 'allow', shell: 'deny', network: 'ask', delegate: 'allow' });
    expect(effective.trustedFolders).toEqual(['/a', '/b']);
  });

  it('falls back to core defaults with nothing configured', () => {
    expect(resolveEffectivePermissions().approval).toEqual({
      read: 'allow',
      write: 'ask',
      shell: 'ask',
      network: 'ask',
      delegate: 'allow',
    });
  });
});

describe('markdown', () => {
  it('parses headings, paragraphs, fences, and lists', () => {
    const blocks = parseMarkdown('# Title\n\nHello **world**.\n\n```ts\nconst a = 1;\n```\n\n- one\n- two\n\n1. first\n2. second');
    expect(blocks.map(b => b.type)).toEqual(['heading', 'paragraph', 'code', 'list', 'list']);
    expect(blocks[2]).toMatchObject({ lang: 'ts', text: 'const a = 1;' });
    expect(blocks[3]).toMatchObject({ ordered: false });
    expect(blocks[4]).toMatchObject({ ordered: true });
  });

  it('parses inline code, bold, italic, and http links only', () => {
    const nodes = parseInline('mix `code` **bold** *em* [site](https://x.dev) [evil](javascript:alert(1))');
    expect(nodes).toEqual([
      { type: 'text', text: 'mix ' },
      { type: 'code', text: 'code' },
      { type: 'text', text: ' ' },
      { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'em' }] },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'https://x.dev', children: [{ type: 'text', text: 'site' }] },
      { type: 'text', text: ' [evil](javascript:alert(1))' },
    ]);
  });

  it('keeps an unclosed fence as code to the end of input', () => {
    const blocks = parseMarkdown('```\nunterminated');
    expect(blocks).toEqual([{ type: 'code', text: 'unterminated' }]);
  });
});
