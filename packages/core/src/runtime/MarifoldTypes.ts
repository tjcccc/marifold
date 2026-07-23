import type { ImageInput } from '@priest-ai/core';
import type { ProfileMode } from '../config/ConfigSchema';

export interface MarifoldRunRequest {
  prompt: string;
  profile?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  /** Replace this zero-based persisted user exchange instead of appending a
   * new one. Only turns before it are supplied as model context. */
  replaceUserTurnIndex?: number;
  memories?: boolean;
  think?: boolean;
  /** Images attached to the user turn. Passed through to the provider; embedded
   * data/URLs are also retained as display-only session attachments. */
  images?: ImageInput[];
  /** Preserve the attached images' original encoded bytes for this turn. */
  originalImages?: boolean;
  /** Per-turn ephemeral strings appended to the user message (e.g. /search results, /read file content). */
  userContext?: string[];
  /** Authoritative instructions injected at the top of the system prompt (e.g. a
   * skill body). Guides the turn like a system directive; not persisted as a
   * conversation turn, so it never pollutes later turns. */
  instructions?: string[];
  /** Set false to disable model-initiated chat tools for this run even when [web_search].enabled is true. */
  chatTools?: boolean;
  /** Session-scoped context-budget override (e.g. /context-window set N). Wins over profile/global. */
  maxContextTokens?: number;
  /** Cancels the in-flight provider request when aborted (e.g. ESC/Ctrl-C). Forwarded to the engine stream. */
  signal?: AbortSignal;
}

export interface MarifoldResolvedSettings {
  profile: string;
  provider: string;
  model: string;
  think: boolean;
  /** The profile's default TUI mode (`agent` unless the profile overrides it). */
  mode: ProfileMode;
  /** Per-profile conversation-context budget in tokens; undefined falls back to default.maxContextTokens. */
  maxContextTokens?: number;
  /** Per-profile cap on recent session turns replayed to the model; undefined falls back
   * to default.sessionContextTurns (and undefined there means replay all). */
  sessionContextTurns?: number;
}

export interface MarifoldRunError {
  code: string;
  message: string;
}

export interface MarifoldAskResponse {
  ok: boolean;
  text: string;
  settings: MarifoldResolvedSettings;
  latencyMs?: number;
  session?: {
    id: string;
    isNew: boolean;
    turnCount: number;
  };
  error?: MarifoldRunError;
}
