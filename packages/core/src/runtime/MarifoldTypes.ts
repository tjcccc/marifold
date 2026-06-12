import type { ImageInput } from '@priest-ai/core';

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
  /** Set false to disable model-initiated chat tools for this run even when [web_search].enabled is true. */
  chatTools?: boolean;
}

export interface MarifoldResolvedSettings {
  profile: string;
  provider: string;
  model: string;
  think: boolean;
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
