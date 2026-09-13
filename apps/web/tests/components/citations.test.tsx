// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from '../../src/components/Markdown';

afterEach(cleanup);

describe('source citations', () => {
  it('shows a compact source and previews supplied metadata on hover and focus', async () => {
    render(<Markdown source={'A fact. [An article title](https://example.com/news "source")'} />);
    const link = screen.getByRole('link', { name: 'An article title' });
    expect(link.textContent).toBe('example.com');
    expect(link.getAttribute('href')).toBe('https://example.com/news');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(link);
    expect(screen.getByRole('tooltip').textContent).toContain('An article title');
    expect(screen.getByRole('tooltip').textContent).toContain('https://example.com/news');
    fireEvent.mouseLeave(link);
    fireEvent.mouseEnter(screen.getByRole('tooltip'));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(link);
    expect(link.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
    fireEvent.blur(link);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it.each(['（来源：[Title](https://example.com)）', '(Source: [Title](https://example.com))'])(
    'renders legacy citation %s without a language-specific label', source => {
      const { container } = render(<Markdown source={`Fact. ${source}`} />);
      expect(screen.getByRole('link').textContent).toBe('example.com');
      expect(container.textContent).toBe('Fact. example.com');
    },
  );

  it.each(['。', '.', '！', '?'])( 'places sentence punctuation %s before source tags', punctuation => {
    const { container } = render(<Markdown source={`Answer [Title](https://example.com "source") ${punctuation}`} />);
    expect(container.textContent).toBe(`Answer${punctuation}example.com`);
  });

  it('moves punctuation before a group of citations and preserves the following sentence', () => {
    const { container } = render(<Markdown source={'Answer [One](https://one.example "source") [Two](https://two.example "source"). Next sentence.'} />);
    expect(container.textContent).toBe('Answer.one.example two.example Next sentence.');
  });

  it('handles legacy citations without moving ordinary link punctuation', () => {
    const { container } = render(<Markdown source={'事实（来源：[Title](https://example.com)）。 [Ordinary](https://other.example).'} />);
    expect(container.textContent).toBe('事实。example.com Ordinary.');
  });

  it('keeps ordinary links, code, and artifact actions intact and unsafe links inert', () => {
    const { container } = render(<Markdown source={'[Ordinary](https://example.com) `（来源：[Code](https://example.com)）` [File](sandbox:/report) [Bad](javascript:alert "source")'} resolveSandboxLink={() => () => {}} />);
    expect(screen.getByRole('link').textContent).toBe('Ordinary');
    expect(screen.getByRole('button', { name: 'File' })).toBeTruthy();
    expect(container.querySelector('code')?.textContent).toContain('来源');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
