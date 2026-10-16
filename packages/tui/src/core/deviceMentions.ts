import type { WorkspaceDevice } from '@marifold/core';
import { inputTokens } from './inputTokens.js';

/** `@` completions for online executors, named the way the host resolves
 * mentions: the exact name (quoted when it has spaces), or the id when two
 * devices share a name. Matches the Web composer. */
export function deviceCompletions(devices: WorkspaceDevice[]): Array<{ name: string; hint: string }> {
  return devices.filter(d => d.online && d.executor).map(d => {
    const duplicate = devices.filter(other => other.name.toLowerCase() === d.name.toLowerCase()).length > 1;
    const name = duplicate || /["\r\n]/.test(d.name) ? d.id : /\s/.test(d.name) ? `"${d.name}"` : d.name;
    return { name, hint: `${d.name} · ${d.platform}${duplicate ? ` · ${d.id}` : ''}` };
  });
}

/** Names written as `@name` in a message. */
export function mentionedNames(text: string): string[] {
  return inputTokens(text).filter(token => token.sigil === '@' && token.name).map(token => token.name);
}

/** A device by id or by name (case-insensitive), when exactly one matches. */
export function findDevice(devices: WorkspaceDevice[], value: string): WorkspaceDevice | undefined {
  const byId = devices.find(d => d.id === value);
  if (byId) { return byId; }
  const byName = devices.filter(d => d.name.toLowerCase() === value.toLowerCase());
  return byName.length === 1 ? byName[0] : undefined;
}
