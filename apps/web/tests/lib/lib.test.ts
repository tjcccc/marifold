import { describe, expect, it } from 'vitest';
import { formatDuration, formatElapsed, formatRelativeTime, formatTokens } from '../../src/lib/format';
import { formatPath, parseLegacyHash, parsePath } from '../../src/lib/route';
import { parseInline, parseMarkdown } from '../../src/lib/markdown';
import { withPendingSession } from '../../src/lib/sessionSummaries';
import { resolveEffectivePermissions } from '../../src/lib/permissions';

describe('route', () => {
  it('round-trips every route shape', () => {
    const routes = [
      { view: 'agent' as const },
      { view: 'agent' as const, profile: 'default' },
      { view: 'agent' as const, profile: 'writing helper', session: 'sess/1' },
      { view: 'apps' as const },
      { view: 'config' as const, section: 'profiles' as const },
      { view: 'config' as const, section: 'profiles' as const, item: 'default' },
      { view: 'config' as const, section: 'providers' as const, item: 'ollama' },
      { view: 'config' as const, section: 'models' as const },
      { view: 'config' as const, section: 'service' as const },
    ];
    for (const route of routes) {
      expect(parsePath(formatPath(route))).toEqual(route);
    }
  });

  it('formats clean paths and defaults unknown or empty paths to the agent view', () => {
    expect(formatPath({ view: 'agent' })).toBe('/agent');
    expect(formatPath({ view: 'apps' })).toBe('/apps');
    expect(formatPath({ view: 'config', section: 'profiles', item: 'writing helper' }))
      .toBe('/config/profiles/writing%20helper');
    expect(parsePath('')).toEqual({ view: 'agent' });
    expect(parsePath('/nonsense')).toEqual({ view: 'agent' });
  });

  it('maps old clean and hash bookmarks onto current route shapes', () => {
    expect(parsePath('/config/painter')).toEqual({ view: 'config', section: 'profiles', item: 'painter' });
    expect(parseLegacyHash('#/agent/writer/session_1'))
      .toEqual({ view: 'agent', profile: 'writer', session: 'session_1' });
    expect(parseLegacyHash('#/config/painter'))
      .toEqual({ view: 'config', section: 'profiles', item: 'painter' });
    expect(parseLegacyHash('#section')).toBeUndefined();
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

  it('parses blockquotes as their own block, even without a preceding blank line', () => {
    // The exact shape from translation replies: a bold label line, then quote lines.
    const blocks = parseMarkdown('**おすすめ：**\n> *Shanghai, 1920s.*\n> *Time changes. Beauty stays.*\n\nafter');
    expect(blocks.map(b => b.type)).toEqual(['paragraph', 'quote', 'paragraph']);
    const quote = blocks[1];
    if (quote.type !== 'quote') throw new Error('expected quote');
    expect(quote.blocks).toHaveLength(1);
    expect(quote.blocks[0]).toMatchObject({ type: 'paragraph' });
    // No literal '>' survives anywhere in the quote's text nodes.
    expect(JSON.stringify(quote.blocks)).not.toContain('"> ');
  });

  it('parses nested quote content and horizontal rules', () => {
    const blocks = parseMarkdown('> # Quoted heading\n> - a\n> - b\n\n---\n\ntail');
    expect(blocks.map(b => b.type)).toEqual(['quote', 'rule', 'paragraph']);
    const quote = blocks[0];
    if (quote.type !== 'quote') throw new Error('expected quote');
    expect(quote.blocks.map(b => b.type)).toEqual(['heading', 'list']);
  });

  it('parses pipe tables with alignment and mixed-language inline markup', () => {
    const blocks = parseMarkdown([
      'Options:',
      '| 选项 | 感觉 | Link |',
      '| :--- | :---: | ---: |',
      '| **Just some portraits.** | 干净、低调 | [site](https://x.dev) |',
      '| Portraits. | 更冷 | |',
    ].join('\n'));

    expect(blocks.map(block => block.type)).toEqual(['paragraph', 'table']);
    const table = blocks[1];
    if (table.type !== 'table') throw new Error('expected table');
    expect(table.alignments).toEqual(['left', 'center', 'right']);
    expect(table.header).toHaveLength(3);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0][0]).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'Just some portraits.' }] },
    ]);
    expect(table.rows[1][2]).toEqual([]);
  });

  it('keeps escaped and inline-code pipes inside table cells', () => {
    const blocks = parseMarkdown('| value | code |\n| --- | --- |\n| a \\| b | `x|y` |');
    const table = blocks[0];
    if (table.type !== 'table') throw new Error('expected table');
    expect(table.rows[0]).toEqual([
      [{ type: 'text', text: 'a | b' }],
      [{ type: 'code', text: 'x|y' }],
    ]);
  });

  it('keeps malformed table syntax as ordinary paragraph text', () => {
    const blocks = parseMarkdown('| one | two |\n| -- | nope |\n| a | b |');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
  });
});

describe('session summaries', () => {
  it('adds one pending first-turn session with a server-compatible preview', () => {
    const sessions = withPendingSession([], {
      id: 'session_new',
      profileName: 'prompt-maker',
      prompt: `  Make a prompt\nabout ${'portraits '.repeat(20)}`,
      now: '2026-07-22T00:00:00.000Z',
    });

    expect(sessions[0]).toMatchObject({
      id: 'session_new',
      profileName: 'prompt-maker',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      turnCount: 1,
    });
    expect(sessions[0].preview?.startsWith('Make a prompt about portraits')).toBe(true);
    expect(sessions[0].preview?.endsWith('…')).toBe(true);
    expect(sessions[0].preview?.length).toBeLessThanOrEqual(80);
  });

  it('does not duplicate an existing durable or pending session', () => {
    const existing = [{
      id: 'session_1',
      profileName: 'default',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      turnCount: 2,
      preview: 'Existing',
    }];
    expect(withPendingSession(existing, {
      id: 'session_1',
      profileName: 'default',
      prompt: 'Replacement',
    })).toBe(existing);
  });
});
