import type { ImageInput } from '@priest-ai/core';
import type { ProfileMode } from '../config/ConfigSchema';

export interface MarifoldRunRequest {
  prompt: string;
  profile?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  memories?: boolean;
  think?: boolean;
  /** Images attached to the user turn. Passed through to the provider; not persisted in sessions. */
  images?: ImageInput[];
  /** Per-turn ephemeral strings appended to the user message (e.g. /search results, /read file content). */
  userContext?: string[];
  /** Authoritative instructions injected at the top of the system prompt (e.g. a
   * skill body). Guides the turn like a system directive; not persisted as a
   * conversation turn, so it never pollutes later turns. */
  instructions?: string[];
  /** Set false to disable model-initiated chat tools for this run even when [web_search].enabled is true. */
  chatTools?: boolean;
}

export interface MarifoldResolvedSettings {
  profile: string;
  provider: string;
  model: string;
  think: boolean;
  /** The profile's default TUI mode (`agent` unless the profile overrides it). */
  mode: ProfileMode;
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
