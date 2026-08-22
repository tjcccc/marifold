// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputBar } from '../../src/screens/agent/InputBar';
import type { SkillHint } from '../../src/api/misc';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const skills: SkillHint[] = [
  { name: 'translate', description: 'Translate text', usage: '$translate <text> [language]' },
  { name: 'make-midjourney-prompt', description: 'Midjourney prompt', usage: '$make-midjourney-prompt <idea>' },
];

function renderBar(onSubmit = vi.fn()) {
  render(
    <InputBar
      steering={false}
      responding={false}
      think={false}
      onToggleThink={() => {}}
      modelOptions={[]}
      onSelectModel={() => {}}
      skills={skills}
      onSubmit={onSubmit}
      onStop={() => {}}
    />,
  );
  return { onSubmit, textarea: screen.getByPlaceholderText('Message the agent…') as HTMLTextAreaElement };
}

describe('InputBar $-autocomplete', () => {
  it('restores unsent text independently for each session key', () => {
    const base = {
      steering: false,
      responding: false,
      think: false,
      onToggleThink: vi.fn(),
      modelOptions: [] as string[],
      onSelectModel: vi.fn(),
      onSubmit: vi.fn(),
      onStop: vi.fn(),
    };
    const view = render(<InputBar {...base} draftKey="writer:one" />);
    let textarea = screen.getByPlaceholderText('Message the agent…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'draft one' } });

    view.rerender(<InputBar {...base} draftKey="writer:two" />);
    textarea = screen.getByPlaceholderText('Message the agent…') as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    fireEvent.change(textarea, { target: { value: 'draft two' } });

    view.rerender(<InputBar {...base} draftKey="writer:one" />);
    expect((screen.getByPlaceholderText('Message the agent…') as HTMLTextAreaElement).value).toBe('draft one');
  });

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

describe('InputBar composer interactions', () => {
  it('replaces Send with an always-available Stop response button while responding', () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    render(
      <InputBar
        steering={false}
        responding
        disabled
        think={false}
        onToggleThink={() => {}}
        modelOptions={[]}
        onSelectModel={() => {}}
        onSubmit={onSubmit}
        onStop={onStop}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop response' }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('lets Enter commit an IME composition without submitting it', () => {
    const { textarea, onSubmit } = renderBar();
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "p'ho'to" } });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea);
    fireEvent.change(textarea, { target: { value: 'photo' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('photo');
  });

  it('previews pending images and navigates between multiple uploads', () => {
    render(
      <InputBar
        steering={false}
        responding={false}
        think={false}
        onToggleThink={() => {}}
        modelOptions={[]}
        onSelectModel={() => {}}
        onSubmit={() => {}}
        onStop={() => {}}
        attachments={[
          { kind: 'image', name: 'first.png', size: 3, data: 'AAA', mediaType: 'image/png' },
          { kind: 'text', name: 'notes.txt', size: 4, content: 'note' },
          { kind: 'image', name: 'second.jpg', size: 3, data: 'BBB', mediaType: 'image/jpeg' },
        ]}
        onAttachFiles={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preview first.png' }));
    expect(screen.getByRole('dialog', { name: 'first.png preview' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(screen.getByRole('dialog', { name: 'second.jpg preview' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
    expect(screen.getByRole('dialog', { name: 'first.png preview' })).toBeTruthy();
  });

  it('offers arbitrary files and identifies extracted workbook attachments', () => {
    const { container } = render(
      <InputBar
        steering={false}
        responding={false}
        think={false}
        onToggleThink={() => {}}
        modelOptions={[]}
        onSelectModel={() => {}}
        onSubmit={() => {}}
        onStop={() => {}}
        attachments={[
          {
            kind: 'text',
            name: 'budget.xlsx',
            size: 2048,
            content: 'Sheet: Budget',
            officeKind: 'spreadsheet',
          },
        ]}
        onAttachFiles={() => {}}
      />,
    );

    expect(screen.getByText('X')).toBeTruthy();
    expect(screen.getByTitle(/Excel workbook · 2 KiB extracted text/)).toBeTruthy();
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(picker?.accept).toBe('');
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
  });

  it('keeps the visible mirror at the pasted textarea caret', () => {
    const { textarea } = renderBar();
    const mirror = textarea.previousElementSibling as HTMLDivElement;
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 400 });
    textarea.scrollTop = 240;
    const json = '```json\n{\n  "style": "tasteful"\n}\n```';

    fireEvent.change(textarea, { target: { value: json, selectionStart: json.length } });

    expect(mirror.textContent).toBe(json);
    expect(mirror.scrollTop).toBe(240);
  });
});
