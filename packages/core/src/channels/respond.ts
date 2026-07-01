import { MarifoldRuntime } from '../runtime/MarifoldRuntime';
import { ProfileMode } from '../config/ConfigSchema';
import { ApprovalHandler } from '../agent/ApprovalPolicy';

export interface RespondRequest {
  /** Profile whose model + permissions the reply runs under. */
  profile: string;
  /** Chat (one-shot stream) or agent (tool loop). */
  mode: ProfileMode;
  /** The user's message. */
  prompt: string;
  /** Stable conversation id (e.g. `tg-<chat_id>`) so history persists per chat. */
  sessionId: string;
  /** Resolves `ask` approvals (agent mode). When present the run is *attended* —
   * the channel prompts the user (e.g. Telegram inline buttons). When absent,
   * `ask` degrades to deny (unattended). */
  approvalHandler?: ApprovalHandler;
  /** Working directory for agent file/shell tools (e.g. a channel's outbox). */
  cwd?: string;
  /** Extra trusted folders for this run (writes there are auto-approved). */
  trustedFolders?: string[];
  /** Authoritative instructions injected atop the system prompt (e.g. telling
   * the agent that files it writes are delivered to the user). */
  instructions?: string[];
}

export interface RespondResult {
  /** The assistant's final text, ready to send back over the channel. */
  text: string;
  /** False when an agent run did not finish cleanly (error / max-iterations /
   * cancelled) — so the channel can say "the run failed" instead of sending an
   * empty or half-finished message. Always true for chat. */
  ok: boolean;
  /** Tool kinds/names the agent could not run (denied by policy in this
   * unattended context), so the channel can note what it couldn't do. */
  denied: string[];
}

/**
 * Run one turn for a messaging channel (Telegram, Slack, …) and collect a
 * plain-text reply. **Channel-agnostic:** without an `approvalHandler` the agent
 * run is unattended (`ask` degrades to deny — the profile's `allow` rules and
 * `trusted_folders` govern); with one, the channel prompts the user to approve.
 * Presentation/formatting (chunking, markdown) belongs to the channel bridge.
 */
export async function respond(runtime: MarifoldRuntime, request: RespondRequest): Promise<RespondResult> {
  const { profile, mode, prompt, sessionId, approvalHandler, cwd, trustedFolders, instructions } = request;

  if (mode === 'chat') {
    let text = '';
    for await (const chunk of runtime.stream({ prompt, profile, sessionId })) text += chunk;
    return { text: text.trim(), ok: true, denied: [] };
  }

  // Agent — unattended (no approvalHandler). Accumulate the visible text; map
  // tool requests by id so a policy denial can be reported by tool name; track
  // the terminal status so the channel can flag a failed run.
  const runner = runtime.createAgentRunner(profile);
  const toolById = new Map<string, string>();
  const denied = new Set<string>();
  let text = '';
  let ok = false;
  for await (const event of runner.run({ objective: prompt, profile, sessionId, approvalHandler, cwd, trustedFolders, instructions })) {
    if (event.type === 'text') text += event.text;
    else if (event.type === 'tool_request') toolById.set(event.call.id, event.call.tool);
    else if (event.type === 'approval_decision' && !event.approved) {
      denied.add(toolById.get(event.requestId) ?? event.requestId);
    } else if (event.type === 'done') {
      ok = event.status === 'completed';
    }
  }
  return { text: text.trim(), ok, denied: [...denied] };
}
