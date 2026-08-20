import type { JSONValue } from '@priest-ai/core';
import type { UserInputAgentTool } from '../ToolRegistry';
import {
  formatUserInputResponse,
  parseUserInputRequest,
  resolveUserInputResponse,
  type UserInputRequest,
  type UserInputResponse,
  type UserInputSubmission,
} from '../UserInput';

export class AskUserTool implements UserInputAgentTool {
  readonly kind = 'interaction' as const;
  readonly definition = {
    name: 'ask_user',
    description: [
      'Pause and ask the user for essential missing information using one compact set of choices.',
      'When to use: a concrete decision blocks safe or correct progress and cannot be discovered from local context or tools.',
      'When NOT to use: discoverable facts, minor preferences, confirmation of a reasonable assumption, or any question that does not block progress.',
      'Batch all currently known questions into one call. Set multiple to true only when choices may be combined. Do not add an Other option because the UI provides free-text automatically.',
      'Call this tool by itself, without other tool calls in the same response.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable short id, such as style or output_format.' },
              header: { type: 'string', description: 'Optional short category label.' },
              question: { type: 'string', description: 'The specific decision the user must make.' },
              multiple: {
                type: 'boolean',
                description: 'True when the user may select more than one option; defaults to false.',
              },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Stable short option id.' },
                    label: { type: 'string', description: 'Concise user-facing option.' },
                    description: { type: 'string', description: 'Optional one-sentence tradeoff.' },
                  },
                  required: ['id', 'label'],
                },
              },
            },
            required: ['id', 'question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    const count = Array.isArray(input.questions) ? input.questions.length : 0;
    return `ask the user ${count || '?'} clarification ${count === 1 ? 'question' : 'questions'}`;
  }

  createRequest(callId: string, input: Record<string, JSONValue>): UserInputRequest {
    return parseUserInputRequest(callId, input);
  }

  resolveResponse(request: UserInputRequest, submission: UserInputSubmission): UserInputResponse {
    return resolveUserInputResponse(request, submission);
  }

  formatResponse(response: UserInputResponse): string {
    return formatUserInputResponse(response);
  }
}
