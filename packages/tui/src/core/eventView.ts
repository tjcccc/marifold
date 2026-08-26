import type { AgentEvent } from '@marifold/core';
import type { TranscriptItemData } from './appState.js';

/**
 * Pure map from an AgentEvent to zero or more transcript items. Status, step,
 * and approval_request events produce no transcript item — they drive the
 * status line and approval modal, handled by the reducer. Keeping this pure
 * lets every event variant be covered without rendering Ink.
 */
export function agentEventToItems(event: AgentEvent): TranscriptItemData[] {
  switch (event.type) {
    case 'plan':
      return [{
        kind: 'plan',
        steps: event.plan.map(step => ({ id: step.id, text: step.text, status: step.status })),
      }];
    case 'text':
      return event.text.trim().length > 0
        ? [{ kind: 'assistant', text: event.text, ...(event.phase === 'progress' ? { muted: true } : {}) }]
        : [];
    case 'reasoning':
      return event.summary.trim().length > 0
        ? [{ kind: 'assistant', text: `Reasoning: ${event.summary}`, muted: true }]
        : [];
    case 'steering':
      // Queued guidance the runner just picked up for the next model turn.
      return [{ kind: 'notice', tone: 'info', text: `Steering applied: ${event.text}` }];
    case 'tool_request':
      return [{
        kind: 'tool',
        tool: event.call.tool,
        toolKind: event.call.kind,
        summary: event.call.summary,
        phase: 'request',
        callId: event.call.id,
      }];
    case 'tool_result':
      // Normally folded onto the request line by the reducer (matched by
      // callId); this item is only used if no matching request is found.
      return [{
        kind: 'tool',
        tool: event.tool,
        summary: event.summary,
        phase: 'result',
        isError: event.isError,
        callId: event.callId,
      }];
    case 'artifact':
      return [{
        kind: 'notice',
        tone: 'info',
        text: `Generated file: ${event.artifact.name} (${formatBytes(event.artifact.size)})`,
      }];
    case 'approval_decision':
      // Approvals show in the modal; only surface denials in the transcript.
      return event.approved
        ? []
        : [{
            kind: 'notice',
            tone: 'warn',
            text: `Denied (${event.source})${event.reason ? `: ${event.reason}` : ''}`,
          }];
    case 'user_input_response':
      return [{
        kind: 'notice',
        tone: 'info',
        text: `Answered: ${event.response.answers.map(answer => `${answer.questionId} = ${answer.value}`).join(' · ')}`,
      }];
    case 'verification':
      return [{ kind: 'verification', passed: event.passed, notes: event.notes }];
    case 'error':
      return [{ kind: 'notice', tone: 'error', text: `Error [${event.code}]: ${event.message}` }];
    case 'done':
      // The completion line (with timing/tokens) is emitted by the App once the
      // run's wall-clock and usage are known, so nothing is added here.
      return [];
    case 'status':
    case 'step':
    case 'approval_request':
    case 'user_input_request':
      return [];
    default:
      return [];
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
