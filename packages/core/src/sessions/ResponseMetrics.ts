import type { AgentUsage } from '../agent/AgentEvents';

/**
 * Durable, content-free metadata for one completed user→assistant exchange.
 * Stored in a Marifold-owned companion table so Priest's transcript schema
 * remains untouched and future statistics can aggregate across modes/models.
 */
export interface ResponseMetrics {
  mode: 'agent' | 'chat';
  provider: string;
  model: string;
  think: boolean;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  usage?: AgentUsage;
}
