import type { ApiClient } from '../api/client';
import { MarifoldApiError } from '../api/client';
import { followRun } from '../api/runs';
import type { ThreadAction } from './thread';

/**
 * Owns one follow loop per run: attaches followRun generators, dispatches
 * their events into the thread reducer, and aborts them on detach. Not a
 * React hook on purpose — a plain class the AgentScreen owns via useEffect,
 * so the lifecycle is explicit and the logic testable without rendering.
 */
export class RunFollowers {
  private readonly loops = new Map<string, AbortController>();

  constructor(
    private readonly client: ApiClient,
    private readonly dispatch: (action: ThreadAction) => void,
  ) {}

  /** Idempotent: attaching an already-followed run is a no-op. */
  attach(runId: string, afterSeq = 0): void {
    if (this.loops.has(runId)) return;
    const controller = new AbortController();
    this.loops.set(runId, controller);
    void this.pump(runId, afterSeq, controller.signal).finally(() => {
      this.loops.delete(runId);
    });
  }

  following(runId: string): boolean {
    return this.loops.has(runId);
  }

  stop(runId: string): void {
    this.loops.get(runId)?.abort();
    this.loops.delete(runId);
  }

  stopAll(): void {
    for (const controller of this.loops.values()) controller.abort();
    this.loops.clear();
  }

  private async pump(runId: string, afterSeq: number, signal: AbortSignal): Promise<void> {
    try {
      for await (const { seq, event } of followRun(this.client, runId, { afterSeq, signal })) {
        this.dispatch({ type: 'run_event', runId, seq, event });
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof MarifoldApiError && error.code === 'RUN_NOT_FOUND') {
        this.dispatch({ type: 'run_lost', runId });
        return;
      }
      this.dispatch({
        type: 'notice',
        tone: 'error',
        text: `Run stream failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
