import type { AgentEvent } from '../api/types';
import type { ThreadState, ToolRowState } from './threadTypes';
import { append, emptyCard, findRunItem, insert, insertRunCard, markUserPersisted, updateRun } from './threadItems';

// Applying live AgentEvents to a run card: status, plan, text, tools, approvals, questions, artifacts, and completion.

export function applyRunEvent(state: ThreadState, runId: string, seq: number, event: AgentEvent): ThreadState {
  // Auto-create the card for runs discovered mid-stream (catch-up "Show",
  // runs started from another client).
  let next = findRunItem(state, runId)
    ? state
    : insertRunCard(state, { kind: 'run', run: emptyCard(runId) });

  const card = findRunItem(next, runId)!.run;
  if (seq <= card.lastSeq) { return state; } // replay overlap — drop

  switch (event.type) {
    case 'status':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        status: event.status,
        taskId: run.taskId ?? event.taskId,
      }));
      break;

    case 'plan':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        plan: event.plan.map(step => ({ id: step.id, text: step.text, status: step.status })),
      }));
      break;

    case 'step':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        plan: run.plan?.map(step => (step.id === event.stepId ? { ...step, status: event.status } : step)),
      }));
      break;

    case 'text': {
      next = updateRun(next, runId, run => ({ ...run, lastSeq: seq }));
      if (event.text.trim().length > 0) {
        next = appendRunText(next, runId, event.text, event.phase ?? 'final');
      }
      break;
    }

    case 'reasoning': {
      next = updateRun(next, runId, run => ({ ...run, lastSeq: seq }));
      if (event.summary.trim().length > 0) {
        next = appendRunText(next, runId, `Reasoning: ${event.summary}`, 'reasoning');
      }
      break;
    }

    case 'steering':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        steering: [...run.steering, event.text],
      }));
      break;

    case 'tool_request':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        rows: [
          ...run.rows,
          {
            callId: event.call.id,
            tool: event.call.tool,
            kind: event.call.kind,
            summary: event.call.summary,
            phase: 'running',
          },
        ],
      }));
      break;

    case 'tool_result':
      next = updateRun(next, runId, run => {
        const matched = run.rows.some(row => row.callId === event.callId);
        const rows: ToolRowState[] = matched
          ? run.rows.map(row =>
              row.callId === event.callId
                ? { ...row, summary: event.summary, phase: 'done' as const, isError: event.isError }
                : row,
            )
          : [
              ...run.rows,
              { callId: event.callId, tool: event.tool, summary: event.summary, phase: 'done' as const, isError: event.isError },
            ];
        return { ...run, lastSeq: seq, rows };
      });
      break;

    case 'approval_request':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        approval: event.request,
        approvalBusy: false,
      }));
      break;

    case 'approval_decision':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        approval: undefined,
        approvalBusy: false,
        denials:
          !event.approved && event.source === 'user' && event.reason
            ? [...run.denials, event.reason]
            : run.denials,
      }));
      break;

    case 'user_input_request':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        userInput: event.request,
        userInputBusy: false,
      }));
      break;

    case 'user_input_response':
      next = updateRun(next, runId, run => {
        const request = run.userInput;
        return {
          ...run,
          lastSeq: seq,
          userInput: undefined,
          userInputBusy: false,
          inputResponses: request && request.id === event.response.requestId
            ? [...run.inputResponses, { request, response: event.response }]
            : run.inputResponses,
        };
      });
      break;

    case 'error':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        errors: [...run.errors, { code: event.code, message: event.message }],
      }));
      break;

    case 'artifact':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        artifacts: run.artifacts.some(artifact => artifact.id === event.artifact.id)
          ? run.artifacts
          : [...run.artifacts, event.artifact],
      }));
      break;

    case 'done':
      next = updateRun(next, runId, run => ({
        ...run,
        lastSeq: seq,
        status: event.status,
        taskId: run.taskId ?? event.taskId,
        summary: event.summary,
        usage: event.usage,
        approval: undefined,
        approvalBusy: false,
        userInput: undefined,
        userInputBusy: false,
        finishedAt: new Date().toISOString(),
        collapsed: true,
      }));
      next = updateStreamingRunText(next, runId);
      if (event.status === 'completed') { next = markRunUserPersisted(next, runId); }
      break;

    default:
      // Unknown event types are no-ops by contract (the union may grow).
      next = updateRun(next, runId, run => ({ ...run, lastSeq: seq }));
      break;
  }
  return next;
}

/** Each model turn lands after the run card as its own assistant item so
 * progress commentary can be muted without muting the final answer. */
export function appendRunText(
  state: ThreadState,
  runId: string,
  text: string,
  runPhase: 'reasoning' | 'progress' | 'final',
): ThreadState {
  const closed = updateStreamingRunText(state, runId);
  const lastRunItem = closed.items.findLastIndex(
    item => (item.kind === 'run' && item.run.runId === runId)
      || (item.kind === 'assistant' && item.runId === runId),
  );
  const assistant = { kind: 'assistant' as const, markdown: text, streaming: true, runId, runPhase };
  return lastRunItem === -1 ? append(closed, assistant) : insert(closed, lastRunItem + 1, assistant);
}

export function updateStreamingRunText(state: ThreadState, runId: string): ThreadState {
  return {
    ...state,
    items: state.items.map(item =>
      item.kind === 'assistant' && item.runId === runId && item.streaming
        ? { ...item, streaming: false }
        : item,
    ),
  };
}

export function markRunUserPersisted(state: ThreadState, runId: string): ThreadState {
  const runIndex = state.items.findIndex(item => item.kind === 'run' && item.run.runId === runId);
  if (runIndex === -1) { return state; }
  for (let index = runIndex - 1; index >= 0; index -= 1) {
    const item = state.items[index];
    if (item.kind === 'user') { return markUserPersisted(state, item.id); }
  }
  return state;
}
