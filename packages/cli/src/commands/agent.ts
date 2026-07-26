import { AgentEvent, ApprovalDecision, ApprovalRequest } from '@marifold/core';
import { Command } from 'commander';
import { InteractivePrompt } from '../input/InteractivePrompt';
import { ConsolePrinter } from '../output/ConsolePrinter';
import { TerminalStyle } from '../output/TerminalStyle';
import { createRuntime } from './RuntimeFactory';

interface AgentOptions {
  profile?: string;
  provider?: string;
  model?: string;
  maxIterations?: number;
  toolMode?: 'auto' | 'native' | 'control-block';
  yes?: boolean;
}

export function registerAgentCommand(program: Command, printer: ConsolePrinter): void {
  program
    .command('agent')
    .description('Run an approval-aware agent loop toward an objective, persisting task state.')
    .argument('<objective...>', 'The objective for the agent run.')
    .option('--profile <name>', 'Profile name.')
    .option('--provider <name>', 'Provider key from config.toml.')
    .option('--model <model>', 'Model name.')
    .option('--max-iterations <count>', 'Maximum model turns for this run.', parsePositiveInteger)
    .option('--tool-mode <mode>', 'Tool calling mode: auto, native, or control-block.', parseToolMode)
    .option('--yes', 'Approve all tool calls without prompting (use with care).')
    .action(async (objectiveParts: string[], options: AgentOptions) => {
      const runtime = createRuntime(program);
      const style = new TerminalStyle(process.stdout.isTTY ?? false);
      const prompt = new InteractivePrompt();
      const controller = new AbortController();
      const onSigint = () => controller.abort();
      process.on('SIGINT', onSigint);

      try {
        const runner = runtime.createAgentRunner(options.profile);
        const approvalHandler = options.yes
          // --yes may satisfy ordinary kind-level prompts, but it must never
          // silently cross the non-persistable host/network boundary.
          ? ((request: ApprovalRequest) => request.persistable === false
            ? promptForApproval(prompt, style, request)
            : Promise.resolve({ approved: true }))
          : ((request: ApprovalRequest) => promptForApproval(prompt, style, request));
        const events = runner.run({
          objective: objectiveParts.join(' '),
          profile: options.profile,
          provider: options.provider,
          model: options.model,
          maxIterations: options.maxIterations,
          toolMode: options.toolMode,
          signal: controller.signal,
          approvalHandler,
        });

        let failed = false;
        for await (const event of events) {
          renderAgentEvent(event, style);
          if (event.type === 'done' && event.status !== 'completed') failed = true;
        }
        if (failed) process.exitCode = 1;
      } catch (error) {
        printer.printError(error);
        process.exitCode = 1;
      } finally {
        process.off('SIGINT', onSigint);
        prompt.close();
        runtime.close();
      }
    });
}

async function promptForApproval(
  prompt: InteractivePrompt,
  style: TerminalStyle,
  request: ApprovalRequest,
): Promise<ApprovalDecision> {
  const escalation = request.escalated && request.escalationReason
    ? `\n${style.yellow(`! ${request.escalationReason}`)}`
    : '';
  process.stdout.write(`${style.yellow('approve?')} [${request.kind}] ${request.summary}${escalation}\n`);
  const answer = await prompt.readUserMessage('  y/N > ');
  const approved = answer !== undefined && ['y', 'yes'].includes(answer.trim().toLowerCase());
  return approved ? { approved: true } : { approved: false, reason: 'declined at the prompt' };
}

function renderAgentEvent(event: AgentEvent, style: TerminalStyle): void {
  switch (event.type) {
    case 'status':
      process.stdout.write(`${style.dim(`[task ${event.taskId}] ${event.status}`)}\n`);
      break;
    case 'plan':
      process.stdout.write(`${style.bold('Plan:')}\n`);
      for (const step of event.plan) {
        process.stdout.write(`  ${style.dim(`${step.id}.`)} ${step.text}\n`);
      }
      break;
    case 'step':
      process.stdout.write(`${style.dim(`step ${event.stepId}: ${event.status}`)}\n`);
      break;
    case 'text':
      process.stdout.write(`${event.phase === 'progress' ? style.dim(event.text) : event.text}\n`);
      break;
    case 'reasoning':
      process.stdout.write(`${style.dim(`Reasoning: ${event.summary}`)}\n`);
      break;
    case 'tool_request':
      process.stdout.write(`${style.dim(`tool> ${event.call.summary}`)}\n`);
      break;
    case 'approval_request':
      // The interactive prompt itself is rendered by the approval handler.
      break;
    case 'approval_decision':
      if (!event.approved) {
        process.stdout.write(`${style.yellow(`denied (${event.source}${event.reason ? `: ${event.reason}` : ''})`)}\n`);
      }
      break;
    case 'tool_result':
      process.stdout.write(`${event.isError ? style.red(`tool! ${event.summary}`) : style.dim(`tool< ${event.summary}`)}\n`);
      break;
    case 'verification':
      process.stdout.write(`${event.passed ? style.dim(`verified: ${event.notes}`) : style.yellow(`not verified: ${event.notes}`)}\n`);
      break;
    case 'error':
      process.stdout.write(`${style.red(`error [${event.code}]: ${event.message}`)}\n`);
      break;
    case 'done':
      process.stdout.write(`${style.bold(`done: ${event.status}`)}${event.summary ? `\n${event.summary}` : ''}\n`);
      break;
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('Expected --max-iterations to be a positive integer.');
  }
  return parsed;
}

function parseToolMode(value: string): 'auto' | 'native' | 'control-block' {
  if (value === 'auto' || value === 'native' || value === 'control-block') return value;
  throw new Error('Expected --tool-mode to be auto, native, or control-block.');
}
