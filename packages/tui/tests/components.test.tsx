import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { ApprovalRequest, UserInputRequest } from '@marifold/core';
import { Transcript } from '../src/ui/Transcript.js';
import { Markdown } from '../src/ui/Markdown.js';
import { ApprovalModal } from '../src/ui/ApprovalModal.js';
import { QuestionModal } from '../src/ui/QuestionModal.js';
import { SelectList } from '../src/ui/SelectList.js';
import { StatusLine } from '../src/ui/StatusLine.js';
import { createInitialState } from '../src/core/appState.js';
import type { TranscriptItem } from '../src/core/appState.js';

const delay = () => new Promise(resolve => setTimeout(resolve, 20));

describe('StatusLine context gauge', () => {
  const base = { profile: 'x-runner', provider: 'bailian', model: 'qwen', cwd: '/tmp/work', version: '0' };

  it('hides the gauge when no budget is set', () => {
    const frame = render(<StatusLine state={createInitialState({ ...base })} />).lastFrame() ?? '';
    expect(frame).not.toContain('ctx');
  });

  it('shows budget placeholder before any turn, then percent + usage', () => {
    const seeded = createInitialState({ ...base, maxContextTokens: 16000 });
    expect(render(<StatusLine state={seeded} />).lastFrame() ?? '').toContain('ctx –/16K');
    expect(render(<StatusLine state={{ ...seeded, contextTokens: 9900 }} />).lastFrame() ?? '').toContain('ctx 62% · 9.9K/16K');
  });
});

describe('Markdown math normalization', () => {
  it('renders inline LaTeX temperatures as plain unicode, leaving currency alone', () => {
    const frame = render(
      <Markdown text={'Range ($\\text{23.2}^\\circ\\text{C}$ to $\\text{25.6}^\\circ\\text{C}$), about $30 total.'} />,
    ).lastFrame() ?? '';
    expect(frame).toContain('23.2°C');
    expect(frame).toContain('25.6°C');
    expect(frame).not.toContain('\\text');
    expect(frame).not.toContain('\\circ');
    expect(frame).toContain('$30 total'); // plain currency untouched
  });
});

describe('Transcript', () => {
  it('renders user, assistant, tool, and notice rows', () => {
    const items: TranscriptItem[] = [
      { id: '1', kind: 'user', text: 'do a thing' },
      { id: '2', kind: 'assistant', text: 'working on it' },
      { id: '3', kind: 'tool', tool: 'read_file', toolKind: 'read', summary: 'read a.txt', phase: 'request' },
      { id: '4', kind: 'notice', tone: 'error', text: 'boom' },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('do a thing');
    expect(frame).toContain('working on it');
    expect(frame).toContain('read_file');
    expect(frame).toContain('boom');
  });

  it('keeps a fixed gap after the prompt when a submitted message wraps', () => {
    const text = `Yes, ${'a long submitted message '.repeat(8)}`;
    const frame = render(<Transcript items={[{ id: '1', kind: 'user', text }]} />).lastFrame() ?? '';
    const messageLine = frame.split('\n').find(line => line.includes('Yes,'));
    expect(messageLine).toBeDefined();
    expect(messageLine?.trimStart()).toMatch(/^> Yes,/);
    expect(frame).not.toContain('>Yes,');
  });
});

describe('ApprovalModal', () => {
  const request: ApprovalRequest = { id: 'c', tool: 'write_note', kind: 'write', summary: 'write ./n.md', input: {}, escalated: false };

  it('previews the tool input (file content) so the user sees what is approved', () => {
    const withContent: ApprovalRequest = {
      id: 'c', tool: 'write_file', kind: 'write', summary: 'write 12B to ./n.md',
      input: { path: './n.md', content: 'line one\nline two' }, escalated: false,
    };
    const { lastFrame } = render(<ApprovalModal request={withContent} onResolve={() => {}} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('content:');
    expect(frame).toContain('line one');
    expect(frame).toContain('./n.md');
  });

  it.each([
    ['a', 'once'],
    ['t', 'always'],
    ['d', 'no'],
  ])('resolves %s as %s', async (keypress: string, expected: string) => {
    const onResolve = vi.fn();
    const { stdin, unmount } = render(<ApprovalModal request={request} onResolve={onResolve} />);
    await delay();
    stdin.write(keypress);
    await delay();
    expect(onResolve).toHaveBeenCalledWith(expected);
    unmount();
  });

  it('shows the folder a trust would add for an escalated write', () => {
    const escalated: ApprovalRequest = {
      id: 'c', tool: 'write_file', kind: 'write', summary: 'write 1B to ~/blog/x.md',
      input: { path: '~/blog/x.md' }, escalated: true,
      escalationReason: 'target /home/u/blog/x.md is outside the working directory /repo',
      escalatedPath: '/home/u/blog/x.md',
    };
    const frame = render(<ApprovalModal request={escalated} onResolve={() => {}} />).lastFrame() ?? '';
    expect(frame).toContain('/home/u/blog');     // the folder a trust would add
    expect(frame).toContain('allow always');
  });
});

describe('QuestionModal', () => {
  const request: UserInputRequest = {
    id: 'q1',
    questions: [
      {
        id: 'style',
        header: 'Visual style',
        question: 'What style do you prefer?',
        options: [{ id: 'apple', label: 'Apple' }, { id: 'material', label: 'Material' }],
      },
      {
        id: 'density',
        question: 'How dense should it be?',
        options: [{ id: 'compact', label: 'Compact' }, { id: 'roomy', label: 'Roomy' }],
      },
    ],
  };

  it('collects every answer before a separate submit action', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <QuestionModal request={request} onSubmit={onSubmit} onCancel={() => {}} />,
    );
    await delay();
    expect(lastFrame()).toContain('A few details before I continue');
    expect(lastFrame()).toContain('Answer every question before submitting.');
    stdin.write('\r'); // Apple, then automatically advance
    await delay();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write('\r'); // Compact
    await delay();
    expect(lastFrame()).toContain('All answers ready.');
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write('s');
    await delay();
    expect(onSubmit).toHaveBeenCalledWith({
      answers: [
        { questionId: 'style', optionId: 'apple' },
        { questionId: 'density', optionId: 'compact' },
      ],
    });
    unmount();
  });

  it('shows the custom-edit cursor only on the question being edited', async () => {
    const { stdin, lastFrame, unmount } = render(
      <QuestionModal request={request} onSubmit={() => {}} onCancel={() => {}} />,
    );
    await delay();
    stdin.write('\r'); // answer the first question and advance
    await delay();
    stdin.write('\u001b[B');
    stdin.write('\u001b[B'); // focus Something else on the second question
    await delay();
    stdin.write('\r');
    await delay();
    stdin.write('Time travel');
    await delay();

    const customLines = (lastFrame() ?? '').split('\n').filter(line => line.includes('Something else'));
    expect(customLines).toHaveLength(2);
    expect(customLines[0]).not.toContain('▌');
    expect(customLines[1]).toContain('Time travel▌');
    unmount();
  });
});

describe('SelectList', () => {
  it('selects after arrow navigation and cancels on escape', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const items = [
      { label: 'first', value: 'a' },
      { label: 'second', value: 'b' },
    ];
    const { stdin, lastFrame, unmount } = render(
      <SelectList title="Pick" items={items} onSelect={onSelect} onCancel={onCancel} />,
    );
    await delay();
    expect(lastFrame()).toContain('first');
    stdin.write('[B'); // down arrow
    await delay();
    stdin.write('\r'); // return
    await delay();
    expect(onSelect).toHaveBeenCalledWith('b');
    unmount();
  });
});
