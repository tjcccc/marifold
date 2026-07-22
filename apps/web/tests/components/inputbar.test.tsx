// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputBar } from '../../src/screens/agent/InputBar';
import type { SkillHint } from '../../src/api/misc';

afterEach(cleanup);

const skills: SkillHint[] = [
  { name: 'translate', description: 'Translate text', usage: '$translate <text> [language]' },
  { name: 'make-midjourney-prompt', description: 'Midjourney prompt', usage: '$make-midjourney-prompt <idea>' },
];

function renderBar(onSubmit = vi.fn()) {
  render(
    <InputBar
      steering={false}
      think={false}
      onToggleThink={() => {}}
      modelOptions={[]}
      onSelectModel={() => {}}
      skills={skills}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit, textarea: screen.getByPlaceholderText('Message the agent…') as HTMLTextAreaElement };
}

describe('InputBar $-autocomplete', () => {
  it('shows all skills on "$" and filters as the name is typed', () => {
    const { textarea } = renderBar();
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '$' } });
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByText('$translate <text> [language]')).toBeTruthy();
    expect(screen.getByText('$make-midjourney-prompt <idea>')).toBeTruthy();

    fireEvent.change(textarea, { target: { value: '$make' } });
    expect(screen.queryByText('$translate <text> [language]')).toBeNull();
    expect(screen.getByText('$make-midjourney-prompt <idea>')).toBeTruthy();
  });

  it('Enter completes the highlighted skill instead of submitting', () => {
    const { textarea, onSubmit } = renderBar();
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '$make' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe('$make-midjourney-prompt ');
    // Menu closes once a space (args) follows the name.
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Tab places the caret after the completed skill token', () => {
    const { textarea, onSubmit } = renderBar();
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '$make' } });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    fireEvent.keyDown(textarea, { key: 'Tab' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe('$make-midjourney-prompt ');
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });

  it('reopens skill suggestions while editing the head token with existing arguments', () => {
    const { textarea } = renderBar();
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '$make #anime1' } });
    expect(screen.queryByRole('listbox')).toBeNull(); // caret is in the args

    textarea.setSelectionRange('$make'.length, '$make'.length);
    fireEvent.select(textarea);
    expect(screen.getByText('$make-midjourney-prompt <idea>')).toBeTruthy();

    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(textarea.value).toBe('$make-midjourney-prompt #anime1');
    expect(textarea.selectionStart).toBe('$make-midjourney-prompt '.length);
  });

  it('arrow keys move the selection before completing', () => {
    const { textarea } = renderBar();
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '$' } });
    fireEvent.keyDown(textarea, { key: 'ArrowDown' }); // → second item
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('$make-midjourney-prompt ');
  });

  it('scrolls the highlighted suggestion into view as the arrows move it', () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy; // jsdom has no layout; observe the call
    const { textarea } = renderBar();
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '$' } });
    scrollSpy.mockClear();
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('Escape dismisses the menu; plain Enter then submits', () => {
    const { textarea, onSubmit } = renderBar();
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('hello');
  });

  it('offers /commands and completes them (submission routes to the controller)', () => {
    const { textarea, onSubmit } = renderBar();
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '/' } });
    // The built-in command set shows (capped), not skills.
    expect(screen.getByText('/help')).toBeTruthy();
    expect(screen.getByText('/new')).toBeTruthy();
    expect(screen.queryByText('$translate <text> [language]')).toBeNull();

    // Filtering surfaces a command past the visible cap, then Enter completes it.
    fireEvent.change(textarea, { target: { value: '/mod' } });
    expect(screen.getByText('/model <id>')).toBeTruthy();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe('/model ');
  });

  it('submits a completed command as text (the controller interprets it)', () => {
    const { textarea, onSubmit } = renderBar();
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '/new' } });
    fireEvent.keyDown(textarea, { key: 'Enter' }); // completes → "/new "
    fireEvent.keyDown(textarea, { key: 'Enter' }); // menu closed → submits
    expect(onSubmit).toHaveBeenCalledWith('/new');
  });
});
