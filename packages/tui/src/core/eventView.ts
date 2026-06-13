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
      return event.text.trim().length > 0 ? [{ kind: 'assistant', text: event.text }] : [];
    case 'tool_request':
      return [{
        kind: 'tool',
        tool: event.call.tool,
        toolKind: event.call.kind,
        summary: event.call.summary,
        phase: 'request',
      }];
    case 'tool_result':
      return [{
        kind: 'tool',
        tool: event.tool,
        summary: event.summary,
        phase: 'result',
        isError: event.isError,
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
    case 'verification':
      return [{ kind: 'verification', passed: event.passed, notes: event.notes }];
    case 'error':
      return [{ kind: 'notice', tone: 'error', text: `Error [${event.code}]: ${event.message}` }];
    case 'done':
      // The final answer already arrived as a text event; show status only.
      return [{
        kind: 'notice',
        tone: event.status === 'completed' ? 'info' : 'warn',
        text: `Task ${event.status}.`,
      }];
    case 'status':
    case 'step':
    case 'approval_request':
      return [];
    default:
      return [];
  }
}
