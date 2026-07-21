import type { SessionSummary } from '../api/types';

const PREVIEW_MAX_CHARS = 80;

/** Show a newly submitted session immediately while its agent run is still
 * producing the final turn. The server list replaces this pending row when
 * the run settles, so failed/cancelled runs cannot leave phantom sessions. */
export function withPendingSession(
  sessions: SessionSummary[],
  input: { id: string; profileName: string; prompt: string; now?: string },
): SessionSummary[] {
  if (sessions.some(session => session.id === input.id)) return sessions;
  const now = input.now ?? new Date().toISOString();
  return [{
    id: input.id,
    profileName: input.profileName,
    createdAt: now,
    updatedAt: now,
    turnCount: 1,
    preview: sessionPreview(input.prompt),
  }, ...sessions];
}

function sessionPreview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= PREVIEW_MAX_CHARS) return flat;
  return `${flat.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}
