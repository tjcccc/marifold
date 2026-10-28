import type { AgentEvent } from '../agent/AgentEvents';

type ExampleOf<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>;

/**
 * One wire example per `AgentEvent` variant. The mapped type makes adding a
 * variant without an example (or an example that no longer matches its type)
 * a compile error; `tests/ApiContract.test.ts` keeps `docs/api/agent-events.json`
 * equal to these, so clients in other languages decode the same payloads.
 */
export const AGENT_EVENT_EXAMPLES: { [T in AgentEvent['type']]: ExampleOf<T> } = {
  status: { type: 'status', taskId: 'task_1', status: 'running' },
  plan: {
    type: 'plan',
    taskId: 'task_1',
    plan: [{ id: 'step_1', text: 'Read the notes', status: 'in_progress', createdAt: '2026-10-26T12:00:00.000Z', updatedAt: '2026-10-26T12:00:00.000Z' }],
  },
  step: { type: 'step', taskId: 'task_1', stepId: 'step_1', text: 'Read the notes', status: 'completed' },
  text: { type: 'text', text: 'The notes list three open items.', phase: 'final' },
  reasoning: { type: 'reasoning', summary: 'Checking the notes before answering.' },
  steering: { type: 'steering', taskId: 'task_1', text: 'Keep it short.' },
  tool_request: {
    type: 'tool_request',
    call: { id: 'call_1', tool: 'write_file', kind: 'write', input: { path: '~/notes.md', content: 'hi' }, summary: 'write 2B to ~/notes.md' },
  },
  approval_request: {
    type: 'approval_request',
    request: {
      id: 'call_1',
      tool: 'write_file',
      kind: 'write',
      summary: 'write 2B to ~/notes.md',
      input: { path: '~/notes.md', content: 'hi' },
      escalated: true,
      escalationReason: 'outside the trusted folders',
      escalatedPath: '/Users/me/notes.md',
      persistable: true,
      runGrant: { folder: '/Users/me', access: 'write' },
    },
  },
  approval_decision: { type: 'approval_decision', requestId: 'call_1', approved: true, source: 'user' },
  user_input_request: {
    type: 'user_input_request',
    request: { id: 'call_2', questions: [{ id: 'tone', header: 'Tone', question: 'Which tone?', options: [{ id: 'formal', label: 'Formal' }, { id: 'casual', label: 'Casual', description: 'Relaxed' }] }] },
  },
  user_input_response: {
    type: 'user_input_response',
    response: { requestId: 'call_2', answers: [{ questionId: 'tone', optionId: 'formal', value: 'Formal' }] },
  },
  tool_result: { type: 'tool_result', callId: 'call_1', tool: 'write_file', summary: 'wrote 2B to ~/notes.md', isError: false },
  artifact: { type: 'artifact', artifact: { id: 'art_1', name: 'report.pdf', mediaType: 'application/pdf', size: 18432 } },
  artifact_saved: { type: 'artifact_saved', artifact: { id: 'k3m7q2x9ab', title: 'AI News — 2026-10-28', kind: 'html', version: 1 } },
  verification: { type: 'verification', passed: true, notes: 'deprecated: never emitted by current runners' },
  error: { type: 'error', code: 'AGENT_RUN_ERROR', message: 'The provider timed out.' },
  compaction: { type: 'compaction', status: 'completed', summarizedTurns: 6 },
  handoff: { type: 'handoff', runId: 'run_2', profile: 'painter' },
  done: {
    type: 'done',
    taskId: 'task_1',
    status: 'completed',
    summary: 'The notes list three open items.',
    usage: { inputTokens: 900, contextTokens: 600, outputTokens: 120, totalTokens: 1020, cachedInputTokens: 0 },
  },
};
