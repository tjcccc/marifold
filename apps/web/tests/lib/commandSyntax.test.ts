import { describe, expect, it } from 'vitest';
import { leadingSkillToken, skillQuery, splitLeadingSkill } from '../../src/lib/commandSyntax';

describe('commandSyntax', () => {
  it('detects a leading $skill token, ignoring args', () => {
    expect(leadingSkillToken('$make-midjourney-prompt #photo1 a cat')).toBe('$make-midjourney-prompt');
    expect(leadingSkillToken('$translate')).toBe('$translate');
  });

  it('returns undefined when there is no leading skill', () => {
    expect(leadingSkillToken('hello world')).toBeUndefined();
    expect(leadingSkillToken('a $skill mid-sentence')).toBeUndefined();
    expect(leadingSkillToken('/command')).toBeUndefined(); // slash is out of scope
    expect(leadingSkillToken('$')).toBeUndefined(); // needs an alphanumeric-led name
  });

  it('splits the leading token from the rest', () => {
    expect(splitLeadingSkill('$translate hola')).toEqual({ token: '$translate', rest: ' hola' });
    expect(splitLeadingSkill('just text')).toEqual({ rest: 'just text' });
  });

  it('yields an autocomplete query only while typing the first token', () => {
    expect(skillQuery('$')).toBe('');
    expect(skillQuery('$make')).toBe('make');
    expect(skillQuery('$make-mid')).toBe('make-mid');
    expect(skillQuery('$make ')).toBeUndefined(); // space → typing args, menu closes
    expect(skillQuery('hello')).toBeUndefined();
    expect(skillQuery('')).toBeUndefined();
  });
});
