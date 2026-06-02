export interface MarifoldRunRequest {
  prompt: string;
  profile?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
}

export interface MarifoldResolvedSettings {
  profile: string;
  provider: string;
  model: string;
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
