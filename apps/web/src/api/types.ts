/**
 * The wire contract, in one place. This is the ONLY file that may import from
 * @marifold/core, and only with `import type` (core is a Node package —
 * verbatimModuleSyntax turns an accidental value import into a compile error).
 * Everything else in the app imports its types from here.
 */
import type {
  AgentEvent,
  AgentUsage,
  ApprovalMode,
  ApprovalRequest,
  ImageInput,
  MarifoldAgentConfig,
  MemoryEntry,
  PartialAgentConfig,
  ProfileDetail,
  ProfileMode,
  ProfileSettings,
  ProfileSummary,
  RunApprovalAction,
  RunFileInput,
  RunRecord,
  RunStartInput,
  ScheduleState,
  SessionDetail,
  SessionImageAttachment,
  SessionSummary,
  TaskPlanItem,
  TaskState,
  TaskStatus,
  TaskStepStatus,
  ToolKind,
} from '@marifold/core';

export type {
  AgentEvent,
  AgentUsage,
  ApprovalMode,
  ApprovalRequest,
  ImageInput,
  MarifoldAgentConfig,
  MemoryEntry,
  PartialAgentConfig,
  ProfileDetail,
  ProfileMode,
  ProfileSettings,
  ProfileSummary,
  RunApprovalAction,
  RunFileInput,
  RunRecord,
  RunStartInput,
  ScheduleState,
  SessionDetail,
  SessionImageAttachment,
  SessionSummary,
  TaskPlanItem,
  TaskState,
  TaskStatus,
  TaskStepStatus,
  ToolKind,
};

/** The service's error envelope payload. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, string>;
}

/** One parsed server-sent-event block. Control-only blocks (retry hints)
 * carry `retryMs` without data; heartbeat comments never surface. */
export interface SseFrame {
  id?: number;
  event?: string;
  data?: unknown;
  retryMs?: number;
}

export type ChatStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; usage?: AgentUsage; latencyMs?: number };

/** Sanitized `/v1/config` view (secrets are booleans server-side). The
 * resolved `agent` section arrives with the static-hosting service change. */
export interface PublicConfig {
  default: { provider?: string; model?: string; profile: string; think?: boolean };
  models: { options: string[] };
  providers: Record<string, { type: string; baseUrl?: string; hasApiKey?: boolean; hasOauthToken?: boolean; apiKeyEnv?: string; proxy?: string }>;
  agent?: MarifoldAgentConfig;
  webSearch?: {
    enabled: boolean;
    maxResults: number;
    provider: 'duckduckgo' | 'firecrawl';
    apiKeyEnv?: string;
    scrape?: boolean;
    proxy?: string;
    hasApiKey: boolean;
  };
  service?: { webDir?: string; tokenEnv?: string; corsOrigins: string[]; hasToken: boolean };
}
