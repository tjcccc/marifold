/**
 * The wire contract, in one place. This is the ONLY file that may import from
 * @marifold/core, and only with `import type` (core is a Node package —
 * verbatimModuleSyntax turns an accidental value import into a compile error).
 * Everything else in the app imports its types from here.
 */
import type {
  AgentEvent,
  AgentToolKind,
  AgentUsage,
  ApprovalMode,
  ApprovalRequest,
  SudoChallenge,
  SudoResponse,
  ImageInput,
  MarifoldAgentConfig,
  MarifoldWebSearchConfig,
  MemoryEntry,
  PartialAgentConfig,
  ProfileDetail,
  ProfileMode,
  ProfileSettings,
  ProfileSummary,
  ProjectDetail,
  ProjectSummary,
  RunApprovalAction,
  RunArtifact,
  RunFileInput,
  RunRecord,
  RunStartInput,
  ScheduleState,
  SessionDetail,
  SessionImageAttachment,
  SessionSummary,
  SkillAppDefinition,
  SkillAppEffect,
  SkillAppExecutionSnapshot,
  SkillAppAttachmentInput,
  SkillAppAttachmentSummary,
  SkillAppInstanceSnapshot,
  SkillAppInvalidEntry,
  SkillAppLayoutItem,
  SkillAppMutationResult,
  SkillAppResult,
  TelegramChannelUpdate,
  TelegramChannelView,
  TaskPlanItem,
  TaskState,
  TaskStatus,
  TaskStepStatus,
  ToolKind,
  UserInputQuestion,
  UserInputRequest,
  UserInputResponse,
  UserInputSubmission,
  UserInputSubmissionAnswer,
} from '@marifold/core';

export type {
  AgentEvent,
  AgentToolKind,
  AgentUsage,
  ApprovalMode,
  ApprovalRequest,
  SudoChallenge,
  SudoResponse,
  ImageInput,
  MarifoldAgentConfig,
  MemoryEntry,
  PartialAgentConfig,
  ProfileDetail,
  ProfileMode,
  ProfileSettings,
  ProfileSummary,
  ProjectDetail,
  ProjectSummary,
  RunApprovalAction,
  RunArtifact,
  RunFileInput,
  RunRecord,
  RunStartInput,
  ScheduleState,
  SessionDetail,
  SessionImageAttachment,
  SessionSummary,
  SkillAppDefinition,
  SkillAppEffect,
  SkillAppExecutionSnapshot,
  SkillAppAttachmentInput,
  SkillAppAttachmentSummary,
  SkillAppInstanceSnapshot,
  SkillAppInvalidEntry,
  SkillAppLayoutItem,
  SkillAppMutationResult,
  SkillAppResult,
  TelegramChannelUpdate,
  TelegramChannelView,
  TaskPlanItem,
  TaskState,
  TaskStatus,
  TaskStepStatus,
  ToolKind,
  UserInputQuestion,
  UserInputRequest,
  UserInputResponse,
  UserInputSubmission,
  UserInputSubmissionAnswer,
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
  default: { provider?: string; model?: string; profile: string; deep?: boolean };
  models: { options: string[] };
  providers: Record<string, {
    type: string;
    baseUrl?: string;
    hasApiKey?: boolean;
    hasOauthToken?: boolean;
    apiKeyEnv?: string;
    proxy?: string;
    nativeWebSearch?: 'auto' | 'responses' | 'chat' | 'off';
  }>;
  agent?: MarifoldAgentConfig;
  webSearch?: {
    enabled: boolean;
    maxResults: number;
    provider: MarifoldWebSearchConfig['provider'];
    apiKeyEnv?: string;
    scrape?: boolean;
    proxy?: string;
    hasApiKey: boolean;
  };
  service?: { webDir?: string; tokenEnv?: string; corsOrigins: string[]; hasToken: boolean };
}

export type { WorkspaceSummary, WorkspaceDevice } from '@marifold/core';
export type { AgentComputerStatus } from '@marifold/core';
export type { HomeFolderListing } from '@marifold/core';
export type { LinkedProjectAsset, ProjectAssetUsage, ProjectAssetVersion, StoredProjectAsset } from '@marifold/core';
import type { LinkedProjectAsset, LinkLocation, ProjectAssetUsage, StoredProjectAsset } from '@marifold/core';

/** A project asset as the service lists it: a link also carries its
 * device's current name and whether, or why not, that device can be reached. */
export type ListedProjectAsset = StoredProjectAsset | (LinkedProjectAsset & Pick<LinkLocation, 'deviceName' | 'available' | 'unavailable'>);

export interface ProjectAssetList {
  assets: ListedProjectAsset[];
  usage: ProjectAssetUsage;
}
