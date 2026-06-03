export interface MarifoldRunRequest {
  prompt: string;
  profile?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  memories?: boolean;
  think?: boolean;
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
