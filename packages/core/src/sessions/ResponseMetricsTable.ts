import type Database from 'better-sqlite3';
import type { ResponseMetrics } from './ResponseMetrics';

// Durable per-response metrics (mode, model, latency, usage). A user turn's
// first reply keeps its row in the original table, which older Marifold
// versions read and write; later replies (several profiles answering one
// project message) go to a twin table keyed by reply index as well.

export const RESPONSE_METRICS_TABLE = 'marifold_response_metrics';
export const REPLY_METRICS_TABLE = 'marifold_reply_metrics';

/** Map key for one reply: zero-based user-turn and reply ordinals. */
export function replyKey(userTurnIndex: number, replyIndex: number): string {
  return `${userTurnIndex}:${replyIndex}`;
}

interface ResponseMetricsRow {
  userTurnIndex: number;
  replyIndex: number;
  mode: ResponseMetrics['mode'];
  provider: string;
  model: string;
  think: number;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  estimatedCostUSD: number | null;
}

const METRIC_COLUMNS = `
        mode TEXT NOT NULL CHECK (mode IN ('agent', 'chat')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        think INTEGER NOT NULL CHECK (think IN (0, 1)),
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
        cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
        reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
        estimated_cost_usd REAL CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),`;

export function ensureResponseMetricsTable(db: Database.Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS ${RESPONSE_METRICS_TABLE} (
        session_id TEXT NOT NULL,
        user_turn_index INTEGER NOT NULL CHECK (user_turn_index >= 0),${METRIC_COLUMNS}
        PRIMARY KEY (session_id, user_turn_index)
      );
      CREATE INDEX IF NOT EXISTS idx_marifold_response_metrics_finished
        ON ${RESPONSE_METRICS_TABLE} (finished_at);
      CREATE INDEX IF NOT EXISTS idx_marifold_response_metrics_provider_model
        ON ${RESPONSE_METRICS_TABLE} (provider, model, finished_at);
    `);
}

function ensureReplyMetricsTable(db: Database.Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS ${REPLY_METRICS_TABLE} (
        session_id TEXT NOT NULL,
        user_turn_index INTEGER NOT NULL CHECK (user_turn_index >= 0),
        reply_index INTEGER NOT NULL CHECK (reply_index >= 1),${METRIC_COLUMNS}
        PRIMARY KEY (session_id, user_turn_index, reply_index)
      );
    `);
}

export function hasResponseMetricsTable(db: Database.Database): boolean {
  return hasTable(db, RESPONSE_METRICS_TABLE);
}

export function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(name) !== undefined;
}

/** Store one reply's metrics; reply 0 (the default) is the user turn's first answer. */
export function upsertResponseMetrics(
  db: Database.Database,
  sessionId: string,
  userTurnIndex: number,
  metrics: ResponseMetrics,
  replyIndex = 0,
): void {
  const keys = replyIndex > 0 ? ['session_id', 'user_turn_index', 'reply_index'] : ['session_id', 'user_turn_index'];
  if (replyIndex > 0) { ensureReplyMetricsTable(db); } else { ensureResponseMetricsTable(db); }
  db.prepare(`
      INSERT INTO ${replyIndex > 0 ? REPLY_METRICS_TABLE : RESPONSE_METRICS_TABLE} (
        ${keys.join(', ')},
        mode,
        provider,
        model,
        think,
        started_at,
        finished_at,
        latency_ms,
        input_tokens,
        output_tokens,
        total_tokens,
        cached_input_tokens,
        reasoning_tokens,
        estimated_cost_usd
      ) VALUES (${keys.map(() => '?').join(', ')}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(${keys.join(', ')}) DO UPDATE SET
        mode = excluded.mode,
        provider = excluded.provider,
        model = excluded.model,
        think = excluded.think,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        latency_ms = excluded.latency_ms,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        total_tokens = excluded.total_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        estimated_cost_usd = excluded.estimated_cost_usd
    `).run(
    sessionId,
    userTurnIndex,
    ...(replyIndex > 0 ? [replyIndex] : []),
    metrics.mode,
    metrics.provider,
    metrics.model,
    metrics.deep ? 1 : 0, // stored in the `think` column (named before Think became Deep)
    metrics.startedAt,
    metrics.finishedAt,
    nonNegativeInteger(metrics.latencyMs) ?? 0,
    nonNegativeInteger(metrics.usage?.inputTokens),
    nonNegativeInteger(metrics.usage?.outputTokens),
    nonNegativeInteger(metrics.usage?.totalTokens),
    nonNegativeInteger(metrics.usage?.cachedInputTokens),
    nonNegativeInteger(metrics.usage?.reasoningTokens),
    nonNegativeNumber(metrics.usage?.estimatedCostUSD),
  );
}

/** A session's reply metrics keyed by `replyKey`. */
export function listResponseMetrics(db: Database.Database, sessionId: string): Map<string, ResponseMetrics> {
  const byReply = new Map<string, ResponseMetrics>();
  const columns = `
        user_turn_index AS userTurnIndex,
        mode,
        provider,
        model,
        think,
        started_at AS startedAt,
        finished_at AS finishedAt,
        latency_ms AS latencyMs,
        input_tokens AS inputTokens,
        output_tokens AS outputTokens,
        total_tokens AS totalTokens,
        cached_input_tokens AS cachedInputTokens,
        reasoning_tokens AS reasoningTokens,
        estimated_cost_usd AS estimatedCostUSD`;
  const selects = [
    ...(hasResponseMetricsTable(db) ? [`SELECT 0 AS replyIndex, ${columns} FROM ${RESPONSE_METRICS_TABLE} WHERE session_id = ?`] : []),
    ...(hasTable(db, REPLY_METRICS_TABLE) ? [`SELECT reply_index AS replyIndex, ${columns} FROM ${REPLY_METRICS_TABLE} WHERE session_id = ?`] : []),
  ];
  if (selects.length === 0) { return byReply; }
  const rows = db.prepare(selects.join(' UNION ALL ')).all(...selects.map(() => sessionId)) as ResponseMetricsRow[];
  for (const row of rows) {
    const usage = {
      ...(row.inputTokens !== null ? { inputTokens: row.inputTokens } : {}),
      ...(row.outputTokens !== null ? { outputTokens: row.outputTokens } : {}),
      ...(row.totalTokens !== null ? { totalTokens: row.totalTokens } : {}),
      ...(row.cachedInputTokens !== null ? { cachedInputTokens: row.cachedInputTokens } : {}),
      ...(row.reasoningTokens !== null ? { reasoningTokens: row.reasoningTokens } : {}),
      ...(row.estimatedCostUSD !== null ? { estimatedCostUSD: row.estimatedCostUSD } : {}),
    };
    byReply.set(replyKey(row.userTurnIndex, row.replyIndex), {
      mode: row.mode,
      provider: row.provider,
      model: row.model,
      deep: row.think === 1,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      latencyMs: row.latencyMs,
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    });
  }
  return byReply;
}

function nonNegativeInteger(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function nonNegativeNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
