import type Database from 'better-sqlite3';
import type { ResponseMetrics } from './ResponseMetrics';

// Durable per-response metrics (mode, model, latency, usage), one row per
// answered user turn.

export const RESPONSE_METRICS_TABLE = 'marifold_response_metrics';

interface ResponseMetricsRow {
  userTurnIndex: number;
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

export function ensureResponseMetricsTable(db: Database.Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS ${RESPONSE_METRICS_TABLE} (
        session_id TEXT NOT NULL,
        user_turn_index INTEGER NOT NULL CHECK (user_turn_index >= 0),
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
        estimated_cost_usd REAL CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
        PRIMARY KEY (session_id, user_turn_index)
      );
      CREATE INDEX IF NOT EXISTS idx_marifold_response_metrics_finished
        ON ${RESPONSE_METRICS_TABLE} (finished_at);
      CREATE INDEX IF NOT EXISTS idx_marifold_response_metrics_provider_model
        ON ${RESPONSE_METRICS_TABLE} (provider, model, finished_at);
    `);
}

export function hasResponseMetricsTable(db: Database.Database): boolean {
  return db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(RESPONSE_METRICS_TABLE) !== undefined;
}

export function upsertResponseMetrics(
  db: Database.Database,
  sessionId: string,
  userTurnIndex: number,
  metrics: ResponseMetrics,
): void {
  ensureResponseMetricsTable(db);
  db.prepare(`
      INSERT INTO ${RESPONSE_METRICS_TABLE} (
        session_id,
        user_turn_index,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, user_turn_index) DO UPDATE SET
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
    metrics.mode,
    metrics.provider,
    metrics.model,
    metrics.think ? 1 : 0,
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

export function listResponseMetrics(db: Database.Database, sessionId: string): Map<number, ResponseMetrics> {
  const byTurn = new Map<number, ResponseMetrics>();
  if (!hasResponseMetricsTable(db)) { return byTurn; }
  const rows = db.prepare(`
      SELECT
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
        estimated_cost_usd AS estimatedCostUSD
      FROM ${RESPONSE_METRICS_TABLE}
      WHERE session_id = ?
      ORDER BY user_turn_index ASC
    `).all(sessionId) as ResponseMetricsRow[];
  for (const row of rows) {
    const usage = {
      ...(row.inputTokens !== null ? { inputTokens: row.inputTokens } : {}),
      ...(row.outputTokens !== null ? { outputTokens: row.outputTokens } : {}),
      ...(row.totalTokens !== null ? { totalTokens: row.totalTokens } : {}),
      ...(row.cachedInputTokens !== null ? { cachedInputTokens: row.cachedInputTokens } : {}),
      ...(row.reasoningTokens !== null ? { reasoningTokens: row.reasoningTokens } : {}),
      ...(row.estimatedCostUSD !== null ? { estimatedCostUSD: row.estimatedCostUSD } : {}),
    };
    byTurn.set(row.userTurnIndex, {
      mode: row.mode,
      provider: row.provider,
      model: row.model,
      think: row.think === 1,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      latencyMs: row.latencyMs,
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    });
  }
  return byTurn;
}

export function deleteResponseMetricsForSession(db: Database.Database, sessionId: string): void {
  if (!hasResponseMetricsTable(db)) { return; }
  db.prepare(`DELETE FROM ${RESPONSE_METRICS_TABLE} WHERE session_id = ?`).run(sessionId);
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
