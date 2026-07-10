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

  it('arrow keys move the selection before completing', () => {
    const { textarea } = renderBar();
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '$' } });
    fireEvent.keyDown(textarea, { key: 'ArrowDown' }); // → second item
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('$make-midjourney-prompt ');
  });

  it('Escape dismisses the menu; plain Enter then submits', () => {
    const { textarea, onSubmit } = renderBar();
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('hello');
  });
});
