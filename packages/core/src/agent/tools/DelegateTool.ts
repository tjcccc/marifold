import { JSONValue } from '@priest-ai/core';
import { AgentTool, capToolOutput, requireStringInput, ToolExecutionContext, ToolExecutionResult } from '../ToolRegistry';

export interface DelegateAskRequest {
  prompt: string;
  profile: string;
}

export interface DelegateAskResult {
  ok: boolean;
  text: string;
  error?: { code: string; message: string };
}

export interface DelegateToolDeps {
  ask: (request: DelegateAskRequest) => Promise<DelegateAskResult>;
  listProfileNames: () => string[];
}

/**
 * Minimal multi-model orchestration: run a one-shot request through another
 * profile (and therefore that profile's provider/model). Delegated requests
 * are plain asks — no tools — so delegation depth is structurally 1.
 */
export class DelegateTool implements AgentTool {
  readonly kind = 'delegate' as const;
  readonly definition = {
    name: 'ask_profile',
    description: [
      'Send a one-shot prompt to another Marifold profile, which may use a different model, and return its reply without tools.',
      'When to use: a known specialized profile is materially better suited to a bounded subtask, such as translation.',
      'When NOT to use: ordinary work the active profile can complete, tool-using or multi-step delegation, implicit profile discovery, or recursive delegation.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: 'Name of the target profile.' },
        prompt: { type: 'string', description: 'The prompt to send to that profile.' },
      },
      required: ['profile', 'prompt'],
    },
  };

  constructor(private readonly deps: DelegateToolDeps) {}

  summarizeCall(input: Record<string, JSONValue>): string {
    const profile = typeof input.profile === 'string' ? input.profile : '<missing profile>';
    return `ask profile '${profile}'`;
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const profile = requireStringInput(input, 'profile', 'ask_profile');
    const prompt = requireStringInput(input, 'prompt', 'ask_profile');

    const known = this.deps.listProfileNames();
    if (!known.includes(profile)) {
      return {
        content: `Profile '${profile}' does not exist. Available profiles: ${known.join(', ') || '(none)'}.`,
        summary: `unknown profile '${profile}'`,
        isError: true,
      };
    }

    const result = await this.deps.ask({ prompt, profile });
    if (!result.ok) {
      return {
        content: `Profile '${profile}' request failed: ${result.error?.message ?? 'unknown error'}`,
        summary: `profile '${profile}' failed`,
        isError: true,
      };
    }
    return {
      content: capToolOutput(result.text, ctx.outputLimit),
      summary: `profile '${profile}' replied`,
    };
  }
}
