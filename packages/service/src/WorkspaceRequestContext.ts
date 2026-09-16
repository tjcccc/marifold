import { randomBytes } from 'node:crypto';
import type { WorkspaceOperationContext } from '@marifold/core';

export interface WorkspaceRequestProvenance extends WorkspaceOperationContext { remoteRequest?: boolean; }

export const WORKSPACE_CONTEXT_HEADER = 'x-marifold-workspace-context';
/** Fastify injection creates its own async context. Bind authenticated bridge
 * provenance with an unguessable, process-local ticket instead of trusting a
 * client-supplied device ID or relying on AsyncLocalStorage propagation. */
export class WorkspaceRequestContext {
  private tickets = new Map<string, WorkspaceRequestProvenance>();
  async inject<T>(
    context: WorkspaceRequestProvenance,
    operation: (headers: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    const ticket = randomBytes(32).toString('hex');
    this.tickets.set(ticket, context);
    try {
      return await operation({ [WORKSPACE_CONTEXT_HEADER]: ticket });
    } finally {
      this.tickets.delete(ticket);
    }
  }
  resolve(headers: Record<string, string | string[] | undefined>): WorkspaceRequestProvenance | undefined {
    const ticket = headers[WORKSPACE_CONTEXT_HEADER];
    if (ticket === undefined) return undefined;
    const context = typeof ticket === 'string' ? this.tickets.get(ticket) : undefined;
    if (!context) throw new Error('Invalid workspace request provenance.');
    return context;
  }
}
