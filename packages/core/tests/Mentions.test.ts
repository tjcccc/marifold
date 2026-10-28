import { describe, expect, it } from 'vitest';
import { artifactMentions, matchMention, mentionTokens } from '../src/agent/Mentions';

const names = ['dev_test', 'painter', 'STJC-M1P-2.local', 'Office Mac'];
const match = (text: string) => {
  const [mention] = mentionTokens(text);
  if (!mention) { return undefined; }
  const { targets, end } = matchMention(mention, names, name => [name]);
  return { targets, rest: text.slice(end) };
};

describe('mentions', () => {
  it('finds mentions at the start or after whitespace, never in e-mail addresses or code', () => {
    expect(mentionTokens('@painter hi, ask @"Office Mac" too').map(m => m.token)).toEqual(['painter', 'Office Mac']);
    expect(mentionTokens('mail me@example.com')).toEqual([]);
    expect(mentionTokens('run `npm i @types/node` and\n```\n@scope/pkg\n```')).toEqual([]);
  });

  it('ends a name at punctuation, a possessive, CJK text, or a path', () => {
    expect(match('@dev_test, which engine?')).toEqual({ targets: ['dev_test'], rest: ', which engine?' });
    expect(match('@painter，给我一个提示词')?.targets).toEqual(['painter']);
    expect(match('@painter给我一个提示词')).toEqual({ targets: ['painter'], rest: '给我一个提示词' });
    expect(match("@stjc-m1p-2.local's ~/x")?.targets).toEqual(['STJC-M1P-2.local']);
    expect(match('@"Office Mac", hello')).toEqual({ targets: ['Office Mac'], rest: ', hello' });
    expect(match('@painter/~/tempfiles')?.rest).toBe('/~/tempfiles');
  });

  it('does not match a longer name or a partial quoted name', () => {
    expect(match('@painter2 hi')?.targets).toEqual([]);
    expect(match('@dev hi')?.targets).toEqual([]);
    expect(match('@"Office" hi')?.targets).toEqual([]);
  });

  it('reports every candidate an ambiguous name matches', () => {
    const [mention] = mentionTokens('@home run');
    expect(matchMention(mention!, ['Home', 'home'], name => [name]).targets).toEqual(['Home', 'home']);
  });

  it('reads @[title] as an artifact, never as a device or profile', () => {
    const text = '@[AI News — 2026-10-28] summarize, then ask @painter about @[k3m7q2x9ab]';
    expect(artifactMentions(text).map(m => m.ref)).toEqual(['AI News — 2026-10-28', 'k3m7q2x9ab']);
    expect(mentionTokens(text).map(m => m.token)).toEqual(['painter']);
    expect(artifactMentions('see `@[code]` and a@[mail] or @[ ]')).toEqual([]);
  });
});
