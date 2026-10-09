import type { SessionSummary } from '@marifold/core';
import type { SelectItem } from './SelectList.js';

/** A /resume picker row: the session's title (or first message), an `in use`
 * badge when another page or terminal holds it, and turns, age, and short id. */
export function sessionItem(currentSessionId: string | undefined, session: SessionSummary): SelectItem {
  const current = session.id === currentSessionId ? 'current · ' : '';
  const turns = `${session.turnCount} ${session.turnCount === 1 ? 'turn' : 'turns'}`;
  return {
    label: session.title?.trim() || session.preview || session.id.slice(0, 8),
    value: session.id,
    hint: `${current}${turns} · ${relativeTime(session.updatedAt)} · ${session.id.slice(0, 8)}`,
    ...(session.inUse ? { badge: 'in use' } : {}),
  };
}

export function relativeTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) { return value; }
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) { return 'just now'; }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) { return `${minutes}m ago`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h ago`; }
  const days = Math.floor(hours / 24);
  if (days < 30) { return `${days}d ago`; }
  return new Date(timestamp).toLocaleDateString();
}
