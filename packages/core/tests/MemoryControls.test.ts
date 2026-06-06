import { describe, expect, it } from 'vitest';
import {
  MemoryControlStripper,
  extractPromptForgetQueries,
  extractPromptMemoryInputs,
  stripMemoryControls,
} from '../src';

describe('MemoryControls', () => {
  it('strips split memory control blocks from streamed output', () => {
    const stripper = new MemoryControlStripper();

    const visible = [
      stripper.feed('Before <memo'),
      stripper.feed('ry_save>{"memories":['),
      stripper.feed('{"kind":"user","text":"Name: Jack"}'),
      stripper.feed(']}</memory_save> after'),
      stripper.flush(),
    ].join('');

    expect(visible).toBe('Before  after');
    expect(stripper.savePayloads).toEqual(['{"memories":[{"kind":"user","text":"Name: Jack"}]}']);
  });

  it('strips complete memory control blocks from full text', () => {
    const stripped = stripMemoryControls(
      '<memory_forget>{"query":"user.name"}</memory_forget>Hello.',
    );

    expect(stripped.text).toBe('Hello.');
    expect(stripped.forgetPayloads).toEqual(['{"query":"user.name"}']);
  });

  it('extracts direct self-identification as stable user memory', () => {
    expect(extractPromptMemoryInputs('my name is jack')).toMatchObject([
      {
        kind: 'user',
        text: "The user's name is Jack.",
        priority: 0,
        confidence: 1,
        stability: 'stable',
        source: 'user_direct',
        conflictKey: 'user.name',
      },
    ]);
  });

  it('does not extract rejected memory prompts', () => {
    expect(extractPromptMemoryInputs('Do not remember this: my name is Jack.')).toEqual([]);
    expect(extractPromptMemoryInputs('Do you know my name?')).toEqual([]);
  });

  it('extracts natural favorite facts, response preferences, and meeting times', () => {
    expect(extractPromptMemoryInputs('My favorite color is green. I prefer short replies. I have a project meeting tomorrow at 3 p.m.')).toMatchObject([
      {
        kind: 'user',
        text: "The user's favorite color is green.",
        conflictKey: 'user.favorite_color',
      },
      {
        kind: 'preferences',
        text: 'The user prefers short replies.',
        conflictKey: 'preferences.reply_style',
      },
      {
        kind: 'auto_short',
        text: 'The user has a project meeting tomorrow at 3 p.m.',
        conflictKey: 'auto_short.project_meeting_time',
      },
    ]);
  });

  it('extracts prompt-driven forget queries without saving the forgotten fact again', () => {
    expect(extractPromptForgetQueries('Please forget my favorite color.')).toEqual(['user.favorite_color']);
    expect(extractPromptMemoryInputs('Please forget my favorite color is green.')).toEqual([]);
  });
});
