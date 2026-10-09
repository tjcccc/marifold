import { spawn } from 'child_process';
import type { AgentUsage } from '@marifold/core';

/** Echo text for a skill turn: `$name arg1 arg2…` (or just `$name` with no args). */
export function skillInvocation(name: string, args: string[]): string {
  return args.length ? `$${name} ${args.join(' ')}` : `$${name}`;
}

/** Strip one pair of matching surrounding quotes/backticks from a path argument
 * — users wrap or paste paths in `…`, "…", or '…'. */
export function unwrapPath(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  if (trimmed.length >= 2 && (first === '`' || first === '"' || first === "'") && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A parenthetical run summary: elapsed time always, token count when the
 * provider reported it, and cost only when a (cloud) provider reported one —
 * e.g. `(9.1s, 919 tokens)`. */
export function runSummary(elapsedMs: number, usage?: AgentUsage): string {
  const parts = [`${(elapsedMs / 1000).toFixed(1)}s`];
  const total =
    usage?.totalTokens ??
    (usage?.inputTokens != null || usage?.outputTokens != null
      ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      : undefined);
  if (total != null) { parts.push(`${total.toLocaleString()} tokens`); }
  // "on server": these are prompt tokens served from the provider's server-side
  // prompt cache (not the local session store), so the label disambiguates.
  if (usage?.cachedInputTokens != null && usage.cachedInputTokens > 0) {
    parts.push(`${usage.cachedInputTokens.toLocaleString()} cached on server`);
  }
  if (usage?.reasoningTokens != null && usage.reasoningTokens > 0) {
    parts.push(`${usage.reasoningTokens.toLocaleString()} reasoning`);
  }
  if (usage?.estimatedCostUSD != null && usage.estimatedCostUSD > 0) {
    parts.push(`$${usage.estimatedCostUSD.toFixed(4)}`);
  }
  return `(${parts.join(', ')})`;
}

/** Copy text to the system clipboard via the platform's CLI utility. Used by
 * /copy to grab a response's original (un-wrapped) text, since selecting from
 * the terminal captures Ink's hard line wraps. */
export function copyToClipboard(text: string): Promise<void> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['pbcopy', [] as string[]]
      : process.platform === 'win32'
        ? ['clip', []]
        : ['xclip', ['-selection', 'clipboard']];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
    child.stdin.end(text);
  });
}

/** Selection copying targets the local clipboard, or the client terminal over
 * SSH. OSC 52 support and permission are controlled by the terminal. */
export async function copyTerminalSelection(text: string): Promise<void> {
  if (!process.env.SSH_TTY && !process.env.SSH_CONNECTION) {
    try { await copyToClipboard(text); return; } catch { /* Try the terminal clipboard. */ }
  }
  if (!process.stdout.isTTY) { throw new Error('Terminal clipboard is unavailable.'); }
  const sequence = `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`;
  process.stdout.write(process.env.TMUX ? `\x1bPtmux;${sequence.replaceAll('\x1b', '\x1b\x1b')}\x1b\\` : sequence);
}

/** A session-in-use error, with how to move that session to this terminal. */
export function sessionBusyText(error: unknown, sessionId: string): string {
  const text = errorText(error);
  return (error as { code?: unknown } | undefined)?.code === 'SESSION_BUSY'
    ? `${text} To open it here instead: marifold --resume ${sessionId} --takeover`
    : text;
}
