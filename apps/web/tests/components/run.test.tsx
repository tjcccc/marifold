// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Auto-cleanup hooks into vitest globals, which this workspace doesn't enable.
afterEach(cleanup);
import type { RunApprovalAction } from '../../src/api/types';
import { ResizableSidebar } from '../../src/components/ResizableSidebar';
import { SidebarSystemFooter } from '../../src/components/SidebarChrome';
import type { RunCardState } from '../../src/state/thread';
import { InputBar } from '../../src/screens/agent/InputBar';
import { RunCard } from '../../src/screens/agent/RunCard';
import { SessionList } from '../../src/screens/agent/SessionList';
import { ThreadHeader } from '../../src/screens/agent/ThreadHeader';
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

describe('ThreadHeader', () => {
  it('shows only the session title, keeps workspace tabs at the trailing edge, and toggles the sidebar', () => {
    const onToggle = vi.fn();
    const onViewChange = vi.fn();
    render(
      <ThreadHeader
        sessionTitle="Please summarize my notes"
        sidebarsHidden={false}
        onToggleSidebars={onToggle}
        view="agent"
        onViewChange={onViewChange}
      />,
    );
    expect(screen.getByText('Please summarize my notes')).toBeTruthy();
    expect(screen.queryByText('default · agent')).toBeNull();
    expect(screen.getByRole('tablist', { name: 'Workspace' }).parentElement?.className).toContain('trailing');
    fireEvent.click(screen.getByLabelText('Hide sidebar'));
    expect(onToggle).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('tab', { name: 'Apps' }));
    expect(onViewChange).toHaveBeenCalledWith('apps');
  });
});

describe('Desktop workspace sidebar', () => {
  it('navigates back from a profile session list and dispatches session actions', () => {
    const onBack = vi.fn();
    const onNew = vi.fn();
    const onSelect = vi.fn();
    render(
      <SessionList
        profileName="prompt-maker"
        profileAvatar={<span>Profile portrait</span>}
        sessions={[{
          id: 'session_1',
          profileName: 'prompt-maker',
          createdAt: '2026-07-22T00:00:00.000Z',
          updatedAt: '2026-07-22T01:00:00.000Z',
          turnCount: 4,
          preview: 'Portrait prompt',
        }]}
        onBack={onBack}
        onNew={onNew}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByLabelText('Back to profiles'));
    fireEvent.click(screen.getByTitle('New session'));
    fireEvent.click(screen.getByText('Portrait prompt'));
    expect(onBack).toHaveBeenCalledOnce();
    expect(onNew).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('session_1');
    const backRow = screen.getByLabelText('Back to profiles').parentElement;
    expect(backRow?.textContent).not.toContain('Profile portrait');
    const portrait = screen.getByText('Profile portrait');
    const sessionsHeading = screen.getByText('Sessions');
    expect(portrait.compareDocumentPosition(sessionsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('starts at 256px and resizes within the shared sidebar bounds', () => {
    window.localStorage.removeItem('marifold.sidebarWidth');
    render(<ResizableSidebar><nav>Profiles</nav></ResizableSidebar>);
    const separator = screen.getByRole('separator', { name: 'Resize sidebar' });
    const frame = separator.parentElement as HTMLDivElement;
    expect(frame.style.width).toBe('256px');

    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(frame.style.width).toBe('264px');
    expect(window.localStorage.getItem('marifold.sidebarWidth')).toBe('264');

    fireEvent.keyDown(separator, { key: 'Home' });
    expect(frame.style.width).toBe('200px');
    window.localStorage.removeItem('marifold.sidebarWidth');
  });

  it('keeps connection, appearance, and settings actions in the sidebar footer', () => {
    const onThemeChange = vi.fn();
    const onOpenConnection = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <SidebarSystemFooter
        theme="auto"
        onThemeChange={onThemeChange}
        onOpenConnection={onOpenConnection}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(screen.getByText('Connection'));
    fireEvent.click(screen.getByText('Appearance'));
    fireEvent.click(screen.getByText('Settings'));
    expect(onOpenConnection).toHaveBeenCalledOnce();
    expect(onThemeChange).toHaveBeenCalledWith('light');
    expect(onOpenSettings).toHaveBeenCalledOnce();
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

  it('marks run commentary as progress while keeping the final answer primary', () => {
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
              startedAt,
              finishedAt: new Date(Date.parse(startedAt) + 2_000).toISOString(),
              usage: { totalTokens: 512 },
            }),
          },
          { id: 'i2', kind: 'assistant', markdown: 'Checking the skill files.', runId: 'run_1', runPhase: 'progress' },
          { id: 'i3', kind: 'assistant', markdown: 'The final prompt.', runId: 'run_1', runPhase: 'final' },
        ]}
        onCancelRun={() => {}}
        onAnswerApproval={() => {}}
        onToggleRun={() => {}}
      />,
    );
    expect(screen.getByText('Checking the skill files.').closest('[data-run-phase="progress"]')).toBeTruthy();
    expect(screen.getByText('The final prompt.').closest('[data-run-phase="final"]')).toBeTruthy();
    expect(screen.getAllByText('2s · 512 tokens')).toHaveLength(1);
  });

  it('renders assistant pipe tables as semantic HTML tables', () => {
    render(
      <ThreadView
        items={[{
          id: 'i1',
          kind: 'assistant',
          markdown: '| 选项 | 感觉 |\n| --- | ---: |\n| Just some portraits. | 干净、低调 |',
        }]}
        onCancelRun={() => {}}
        onAnswerApproval={() => {}}
        onToggleRun={() => {}}
      />,
    );
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getByRole('cell', { name: '干净、低调' })).toBeTruthy();
  });

  it('renders explicit Markdown hard breaks as br elements', () => {
    render(
      <ThreadView
        items={[{
          id: 'i1',
          kind: 'assistant',
          markdown: 'おっ、即決ありがとう笑  \nいいよ、結婚しよ♡',
        }]}
        onCancelRun={() => {}}
        onAnswerApproval={() => {}}
        onToggleRun={() => {}}
      />,
    );
    const paragraph = screen.getByText('おっ、即決ありがとう笑').closest('p');
    expect(paragraph?.querySelectorAll('br')).toHaveLength(1);
  });

  it('repins the conversation for a submission but respects later manual scrolling', () => {
    const props = {
      onCancelRun: () => {},
      onAnswerApproval: () => {},
      onToggleRun: () => {},
    };
    const { rerender } = render(
      <ThreadView
        {...props}
        items={[{ id: 'i1', kind: 'user', text: 'First' }]}
        scrollToBottomRequest={0}
      />,
    );
    const scroll = screen.getByRole('log', { name: 'Conversation' });
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1_000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 200 });
    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);

    rerender(
      <ThreadView
        {...props}
        items={[
          { id: 'i1', kind: 'user', text: 'First' },
          { id: 'i2', kind: 'assistant', markdown: 'Background update' },
        ]}
        scrollToBottomRequest={0}
      />,
    );
    expect(scroll.scrollTop).toBe(300);

    rerender(
      <ThreadView
        {...props}
        items={[
          { id: 'i1', kind: 'user', text: 'First' },
          { id: 'i2', kind: 'assistant', markdown: 'Background update' },
        ]}
        scrollToBottomRequest={1}
      />,
    );
    expect(scroll.scrollTop).toBe(1_000);

    scroll.scrollTop = 400;
    fireEvent.scroll(scroll);
    rerender(
      <ThreadView
        {...props}
        items={[
          { id: 'i1', kind: 'user', text: 'First' },
          { id: 'i2', kind: 'assistant', markdown: 'Background update' },
          { id: 'i3', kind: 'assistant', markdown: 'Streaming update' },
        ]}
        scrollToBottomRequest={1}
      />,
    );
    expect(scroll.scrollTop).toBe(400);
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
