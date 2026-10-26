import type { ImageInput } from '@priest-ai/core';
import type { AgentRunnerDeps } from '../agent/AgentRunner';
import { MarifoldError } from '../errors/MarifoldError';
import type { ProjectStore } from '../projects/ProjectStore';
import type { ResponseMetrics } from '../sessions/ResponseMetrics';
import type { SessionResolver } from '../sessions/SessionResolver';
import { historyBefore, sessionHistory } from './AgentCompaction';

export interface AgentSessionTurnsHost {
  sessionResolver: SessionResolver;
  projects: ProjectStore;
  replaceEditedExchange(sessionId: string, userTurnIndex: number, userText: string, assistantText: string, images?: ImageInput[], responseMetrics?: ResponseMetrics, speaker?: string): void;
  missingEditedTurn(sessionId: string, userTurnIndex: number): never;
}

/**
 * How agent runs read and write their session. A run records a tidy exchange
 * (the prompt when it starts, its outcome when it ends) so resuming shows the
 * result, not the agent's framing; an edit replaces its exchange in one step,
 * and a reply joins the answers to its prompt. In a project session every
 * answer records the profile that gave it.
 */
export function agentSessionTurns(host: AgentSessionTurnsHost): Required<Pick<AgentRunnerDeps, 'persistTurn' | 'loadRecentTurns'>> {
  return {
    persistTurn: async (sessionId, profile, userText, assistantText, images, target, responseMetrics) => {
      const speaker = assistantText !== undefined && host.projects.sessionProject(sessionId) ? profile : undefined;
      if (target?.kind === 'replace') {
        host.replaceEditedExchange(sessionId, target.userTurnIndex, userText ?? '', assistantText ?? '', images, responseMetrics, speaker);
      } else if (target?.kind === 'reply') {
        if (!host.sessionResolver.addReply(sessionId, target.userTurnIndex, assistantText ?? '', { responseMetrics, speaker })) {
          throw missingPrompt(sessionId, target.userTurnIndex);
        }
      } else {
        await host.sessionResolver.appendExchange(sessionId, profile, userText, assistantText, images, responseMetrics, speaker);
      }
    },
    // The session's turns after its running summary. An edit sees only what
    // came before its prompt; a reply also sees the prompt's earlier answers.
    loadRecentTurns: (sessionId, target) => {
      const detail = host.sessionResolver.get(sessionId);
      const turns = detail?.turns ?? [];
      const owner = detail?.profileName;
      if (!target) { return sessionHistory(turns, host.sessionResolver.compaction(sessionId), owner); }
      const reply = target.kind === 'reply';
      const history = historyBefore(turns, target.userTurnIndex, { owner, withReplies: reply, ...(reply ? { compaction: host.sessionResolver.compaction(sessionId) } : {}) });
      if (history) { return history; }
      if (reply) { throw missingPrompt(sessionId, target.userTurnIndex); }
      return host.missingEditedTurn(sessionId, target.userTurnIndex);
    },
  };
}

function missingPrompt(sessionId: string, userTurnIndex: number): MarifoldError {
  return MarifoldError.configInvalid(`Cannot reply to user turn ${userTurnIndex} because it is missing from session '${sessionId}'.`);
}
