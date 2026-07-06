// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Auto-cleanup hooks into vitest globals, which this workspace doesn't enable.
afterEach(cleanup);
import type { RunApprovalAction } from '../../src/api/types';
import type { RunCardState } from '../../src/state/thread';
import { InputBar } from '../../src/screens/agent/InputBar';
import { RunCard } from '../../src/screens/agent/RunCard';
import { ThreadView } from '../../src/screens/agent/ThreadView';

function cardFixture(partial: Partial<RunCardState> = {}): RunCardState {
  return {
    runId: 'run_1',
    status: 'running',
    lastSeq: 4,
    startedAt: new Date(Date.now() - 84_000).toISOString(),
    plan: [
      { id: 's1', text: 'Read the notes', status: 'completed' },
      { id: 's2', text: 'Summarize', status: 'in_progress' },
    ],
    rows: [
      { callId: 'c1', tool: 'read_file', kind: 'read', summary: 'read 14 files', phase: 'done', isError: false },
      { callId: 'c2', tool: 'write_file', kind: 'write', summary: 'write summary.md', phase: 'running' },
    ],
    steering: ['keep it under one page'],
    denials: [],
    errors: [],
    collapsed: false,
    ...partial,
  };
}

describe('RunCard', () => {
  it('renders the working status line with activity, elapsed clock, and cancel', () => {
    const onCancel = vi.fn();
    render(<RunCard run={cardFixture()} onCancel={onCancel} onAnswer={() => {}} onToggle={() => {}} />);
    expect(screen.getByText(/Working — write summary\.md/)).toBeTruthy();
    expect(screen.getByText('1:24')).toBeTruthy();
    expect(screen.getByText('Guidance applied — “keep it under one page”')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('raises the approval sheet and dispatches each action', () => {
    const answers: Array<[string, RunApprovalAction]> = [];
    const run = cardFixture({
      approval: {
        id: 'call_9',
        tool: 'write_file',
        kind: 'write',
        summary: 'write 1.2 KB to summary.md',
        input: {},
        escalated: false,
      },
    });
    render(
      <RunCard run={run} onCancel={() => {}} onAnswer={(id, action) => answers.push([id, action])} onToggle={() => {}} />,
    );
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText(/Waiting for your approval/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Allow once/));
    fireEvent.click(screen.getByText('Always allow file writes'));
    fireEvent.click(screen.getByText('Deny'));
    expect(answers).toEqual([
      ['call_9', 'once'],
      ['call_9', 'always'],
      ['call_9', 'deny'],
    ]);
  });

  it('offers Trust this folder for an escalated write and disables while busy', () => {
    const onAnswer = vi.fn();
    const run = cardFixture({
      approvalBusy: true,
      approval: {
        id: 'call_9',
        tool: 'write_file',
        kind: 'write',
        summary: 'write outside the workspace',
        input: {},
        escalated: true,
        escalatedPath: '/Users/me/blog/post.md',
      },
    });
    render(<RunCard run={run} onCancel={() => {}} onAnswer={onAnswer} onToggle={() => {}} />);
    const trust = screen.getByText('Trust this folder') as HTMLButtonElement;
    expect(trust.disabled).toBe(true);
    expect(screen.getByText('/Users/me/blog/post.md')).toBeTruthy();
    fireEvent.click(trust);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('collapses a finished run to the footer and toggles details', () => {
    const onToggle = vi.fn();
    const run = cardFixture({
      status: 'completed',
      collapsed: true,
      finishedAt: new Date(Date.parse(cardFixture().startedAt) + 84_000).toISOString(),
      usage: { totalTokens: 12_444 },
    });
    render(<RunCard run={run} onCancel={() => {}} onAnswer={() => {}} onToggle={onToggle} />);
    expect(screen.getByText(/Ran 1m 24s · 2 tool actions/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Show/));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe('InputBar', () => {
  it('submits on Enter and clears; Shift+Enter stays in the draft', () => {
    const onSubmit = vi.fn();
    render(
      <InputBar
        steering={false}
        think={false}
        onToggleThink={() => {}}
        modelOptions={[]}
        onSelectModel={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const input = screen.getByPlaceholderText('Message the agent…') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('');
  });

  it('flips to the steering placeholder while a run is active', () => {
    render(
      <InputBar
        steering
        think={false}
        onToggleThink={() => {}}
        modelOptions={[]}
        onSelectModel={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByPlaceholderText(/guidance is picked up mid-task/)).toBeTruthy();
  });
});

describe('ThreadView', () => {
  it('renders a mixed thread: bubbles, markdown, notices, run cards', () => {
    render(
      <ThreadView
        items={[
          { id: 'i1', kind: 'user', text: 'Summarize my notes' },
          { id: 'i2', kind: 'run', run: cardFixture({ status: 'completed', collapsed: true }) },
          { id: 'i3', kind: 'assistant', markdown: 'Here is the **summary**.', runId: 'run_1' },
          { id: 'i4', kind: 'notice', tone: 'warn', text: 'heads up' },
        ]}
        onCancelRun={() => {}}
        onAnswerApproval={() => {}}
        onToggleRun={() => {}}
      />,
    );
    expect(screen.getByText('Summarize my notes')).toBeTruthy();
    expect(screen.getByText('summary')).toBeTruthy();
    expect(screen.getByText('heads up')).toBeTruthy();
    expect(screen.getByText(/tool actions/)).toBeTruthy();
  });

  it('renders a trivial completed run as inline meta on the prose, no card', () => {
    const startedAt = new Date('2026-07-06T08:00:00Z').toISOString();
    render(
      <ThreadView
        items={[
          {
            id: 'i1',
            kind: 'run',
            run: cardFixture({
              status: 'completed',
              collapsed: true,
              plan: undefined,
              rows: [],
              steering: [],
              startedAt,
              finishedAt: new Date(Date.parse(startedAt) + 2_000).toISOString(),
              usage: { totalTokens: 512 },
            }),
          },
          { id: 'i2', kind: 'assistant', markdown: '你好', runId: 'run_1' },
        ]}
        onCancelRun={() => {}}
        onAnswerApproval={() => {}}
        onToggleRun={() => {}}
      />,
    );
    expect(screen.getByText('你好')).toBeTruthy();
    expect(screen.getByText('2s · 512 tokens')).toBeTruthy();
    expect(screen.queryByText(/Ran /)).toBeNull();
    expect(screen.queryByText(/Hide|Show/)).toBeNull();
  });

  it('shows an inline thinking line for a tool-less running run, cancellable', () => {
    const onCancel = vi.fn();
    render(
      <ThreadView
        items={[
          {
            id: 'i1',
            kind: 'run',
            run: cardFixture({ status: 'running', plan: undefined, rows: [], steering: [] }),
          },
        ]}
        onCancelRun={onCancel}
        onAnswerApproval={() => {}}
        onToggleRun={() => {}}
      />,
    );
    expect(screen.getByText('Thinking…')).toBeTruthy();
    expect(screen.queryByText(/Working/)).toBeNull();
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledWith('run_1');
  });

  it('drops the thinking line once the run streams prose', () => {
    render(
      <ThreadView
        items={[
          {
            id: 'i1',
            kind: 'run',
            run: cardFixture({ status: 'running', plan: undefined, rows: [], steering: [] }),
          },
          { id: 'i2', kind: 'assistant', markdown: 'Starting…', streaming: true, runId: 'run_1' },
        ]}
        onCancelRun={() => {}}
        onAnswerApproval={() => {}}
        onToggleRun={() => {}}
      />,
    );
    expect(screen.queryByText('Thinking…')).toBeNull();
    expect(screen.getByText('Starting…')).toBeTruthy();
  });

  it('keeps the card for a failed run even without tool activity', () => {
    render(
      <ThreadView
        items={[
          {
            id: 'i1',
            kind: 'run',
            run: cardFixture({
              status: 'failed',
              collapsed: true,
              plan: undefined,
              rows: [],
              steering: [],
              finishedAt: new Date().toISOString(),
            }),
          },
        ]}
        onCancelRun={() => {}}
        onAnswerApproval={() => {}}
        onToggleRun={() => {}}
      />,
    );
    expect(screen.getByText(/Failed after/)).toBeTruthy();
  });
});
