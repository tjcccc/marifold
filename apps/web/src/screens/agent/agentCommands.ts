import type { Dispatch, MutableRefObject } from 'react';
import type { ApiClient } from '../../api/client';
import { deleteMemory, listMemories, rememberMemory } from '../../api/profiles';
import { steerRun } from '../../api/runs';
import { compactSession } from '../../api/sessions';
import type { ProfileDetail } from '../../api/types';
import { WEB_COMMANDS } from '../../lib/commandSyntax';
import { splitModelChoice } from '../../lib/modelChoice';
import { activeRun } from '../../state/thread';
import type { ThreadAction, ThreadState } from '../../state/thread';

/** What a `/command` reads and calls in the agent controller. `threadRef` is
 * read when the command runs, like the controller's own callbacks. */
export interface AgentCommandContext {
  client: ApiClient;
  dispatch: Dispatch<ThreadAction>;
  threadRef: MutableRefObject<ThreadState>;
  profileName: string | undefined;
  profileDetail: ProfileDetail | undefined;
  modelChoice: string | undefined;
  think: boolean;
  sessionId: string | undefined;
  newSession: () => void;
  setThink: (think: boolean) => void;
  setModelChoice: (choice: string | undefined) => void;
  sendMessage: (text: string, options?: { originalImages?: boolean }) => Promise<boolean>;
  refreshSessions: () => Promise<void>;
  handleError: (error: unknown) => void;
  stop: () => Promise<boolean>;
}

/** Run one Web `/command`: a deterministic action, notice, or message send. */
export async function runAgentCommand(context: AgentCommandContext, { name, args }: { name: string; args: string }): Promise<void> {
  const {
    client, dispatch, threadRef, profileName, profileDetail, modelChoice, think, sessionId,
    newSession, setThink, setModelChoice, sendMessage, refreshSessions, handleError, stop,
  } = context;
  const notify = (text: string, tone: 'info' | 'warn' | 'error' = 'info') =>
    dispatch({ type: 'notice', tone, text });
  switch (name) {
    case 'help':
      notify(WEB_COMMANDS.map(command => `${command.usage} — ${command.description}`).join('\n'));
      break;
    case 'status':
      notify([
        `Profile: ${profileName ?? '—'}`,
        `Model: ${modelChoice ?? 'Auto (profile default)'}`,
        `Thinking: ${think ? 'on' : 'off'}`,
        `Session: ${sessionId ?? 'new'}`,
      ].join('\n'));
      break;
    case 'copy': {
      const last = [...threadRef.current.items].reverse().find(item => item.kind === 'assistant');
      const text = last && last.kind === 'assistant' ? last.markdown : '';
      if (!text) { notify('Nothing to copy yet.'); break; }
      try {
        await navigator.clipboard.writeText(text);
        notify('Copied the last response to the clipboard.');
      } catch {
        notify('Clipboard is unavailable in this browser context.', 'warn');
      }
      break;
    }
    case 'retry': {
      const lastUser = [...threadRef.current.items].reverse().find(item => item.kind === 'user');
      const text = lastUser && lastUser.kind === 'user' ? lastUser.text : '';
      if (!text) { notify('No previous message to retry.'); break; }
      await sendMessage(text);
      break;
    }
    case 'attach-original':
      if (!args) { notify('Usage: /attach-original <prompt>', 'warn'); }
      else if (activeRun(threadRef.current)) { notify('A task is running. Stop it before sending attached images.', 'warn'); }
      else { await sendMessage(args, { originalImages: true }); }
      break;
    case 'new':
      newSession();
      break;
    case 'think':
      setThink(!think);
      notify(`Thinking mode ${think ? 'off' : 'on'}.`);
      break;
    case 'model':
      if (args) {
        setModelChoice(args);
        notify(`Model set to ${args}.`);
      } else {
        notify('Usage: /model <provider/model>, e.g. /model xai/grok-4.5', 'warn');
      }
      break;
    case 'btw': {
      if (!args) { notify('Usage: /btw <text>', 'warn'); break; }
      const active = activeRun(threadRef.current);
      if (active) { await steerRun(client, active.runId, args).catch(handleError); }
      else { notify('No task is running to steer.'); }
      break;
    }
    case 'stop': {
      if (!await stop()) { notify('No task is running.'); }
      break;
    }
    case 'remember': {
      if (!profileName || !args) { notify('Usage: /remember <text>', 'warn'); break; }
      try {
        await rememberMemory(client, profileName, args);
        notify('Saved to memory.');
      } catch (error) {
        handleError(error);
      }
      break;
    }
    case 'forget': {
      if (!profileName || !args) { notify('Usage: /forget <query>', 'warn'); break; }
      try {
        const memories = await listMemories(client, profileName);
        const query = args.toLowerCase();
        const matches = memories.filter(memory => memory.text.toLowerCase().includes(query));
        if (matches.length === 0) { notify(`No memories match "${args}".`); break; }
        for (const memory of matches) { await deleteMemory(client, profileName, memory.id, 'forget'); }
        notify(`Forgot ${matches.length} ${matches.length === 1 ? 'memory' : 'memories'}.`);
      } catch (error) {
        handleError(error);
      }
      break;
    }
    case 'context-window': {
      const budget = profileDetail?.settings.maxContextTokens;
      const window = profileDetail?.settings.sessionContextTurns;
      notify([
        `Context budget: ${budget !== undefined ? `${budget} tokens` : 'default'}`,
        `Turn window: ${window !== undefined ? `${window} turns` : 'all'}`,
        'Change these in Config → the profile.',
      ].join('\n'));
      break;
    }
    case 'compact': {
      if (!sessionId) { notify('No session to compact yet.'); break; }
      const [provider, model] = splitModelChoice(modelChoice);
      try {
        const result = await compactSession(client, sessionId, {
          profile: profileName ?? 'default',
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          think,
        });
        notify(result.compacted ? 'Compacted older turns in this session.' : 'Nothing to compact yet.');
        void refreshSessions();
      } catch (error) {
        handleError(error);
      }
      break;
    }
    default:
      notify(`Unknown command: /${name}`, 'warn');
  }
}
