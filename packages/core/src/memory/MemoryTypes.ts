// Profile memory record shapes and store options, shared by the memory modules.

export type MemoryKind = 'user' | 'preferences' | 'auto_short';

export type MemoryStatus = 'active' | 'superseded';

export type MemoryScope = 'profile' | 'workspace' | 'project' | 'session' | 'task' | 'global';

export type MemorySourceType = 'user' | 'model' | 'system' | 'tool' | 'file' | 'browser' | 'external_agent';

export type MemoryStability = 'stable' | 'evolving' | 'session' | 'ephemeral';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  priority: number;
  confidence: number;
  stability: MemoryStability;
  status: MemoryStatus;
  source: string;
  source_type: MemorySourceType;
  scope: MemoryScope;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  session_id?: string;
  task_id?: string;
  scope_id?: string;
  conflict_key?: string;
  supersedes?: string[];
  evidence?: string;
  reason?: string;
  expires_at?: string;
  [key: string]: unknown;
}

export interface MemoryScaffoldFile {
  path: string;
  status: 'created' | 'kept';
}

export interface MemoryRememberOptions {
  sessionId?: string;
  taskId?: string;
  source?: string;
  sourceType?: MemorySourceType;
  scope?: MemoryScope;
  scopeId?: string;
  conflictKey?: string;
  priority?: number;
  confidence?: number;
  stability?: MemoryStability | string;
  evidence?: string;
  reason?: string;
  expiresAt?: string;
  status?: MemoryStatus;
}

export interface MemoryRememberResult {
  profile: string;
  kind: MemoryKind;
  path: string;
  entry: MemoryEntry;
  created: boolean;
}

export interface MemoryMutationResult {
  profile: string;
  query: string;
  count: number;
  paths: string[];
}

export interface MemorySaveInput {
  kind: MemoryKind;
  text: string;
  source?: string;
  sourceType?: MemorySourceType;
  scope?: MemoryScope;
  scopeId?: string;
  conflictKey?: string;
  priority?: number;
  confidence?: number;
  stability?: MemoryStability | string;
  evidence?: string;
  reason?: string;
  expiresAt?: string;
  status?: MemoryStatus;
}

export interface MemorySaveResult {
  profile: string;
  created: number;
  skipped: number;
  entries: MemoryEntry[];
  paths: string[];
}

export interface MemoryListOptions {
  limit?: number;
  contextLimit?: number;
  thinking?: boolean;
  prompt?: string;
}

export interface JsonLine {
  raw: string;
  entry?: MemoryEntry;
}
