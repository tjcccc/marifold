import * as crypto from 'crypto';
import type { ProjectTurnPlan, ProjectTurnStart } from '../projects/ProjectTurns';
import type { TaskStatus } from '../tasks/TaskStore';
import type { RunStartInput } from './RunRegistry';

/** How a run record shows its place in a project turn. */
export interface RunProjectTurn {
  id: string;
  projectId: string;
  speakers: string[];
  /** This run's speaker in `speakers`. */
  index: number;
}

/**
 * The profiles answering one project message, one run after another on its
 * session (docs/projects.md#several-mentions-in-one-message). The first speaker
 * saves (or replaces) the message; the others reply to it. Nobody's reply
 * becomes another profile's prompt.
 */
export class ProjectTurn {
  readonly id = `turn_${crypto.randomBytes(6).toString('hex')}`;
  cancelled = false;

  constructor(
    private readonly plan: ProjectTurnPlan,
    private readonly input: RunStartInput,
    private readonly started: ProjectTurnStart,
  ) {}

  get speakers(): string[] { return this.plan.speakers; }

  record(index: number): RunProjectTurn {
    return { id: this.id, projectId: this.plan.projectId, speakers: [...this.plan.speakers], index };
  }

  /** Speaker `index`'s run: its profile, its project block, and the
   * request's own settings (model, Deep, instructions) only when the request
   * chose them for that profile. A later speaker runs for the session's
   * holder at its start, who may have taken it over meanwhile. */
  speakerInput(index: number): RunStartInput {
    const speaker = this.plan.speakers[index]!;
    const own = speaker === this.input.profile;
    const { provider, model, deep, instructions, projectTurn: _plan, replaceUserTurnIndex, userTurn, ...shared } = this.input;
    return {
      ...shared,
      profile: speaker,
      projectId: this.plan.projectId,
      instructions: [...(this.plan.instructions[speaker] ?? []), ...(own ? instructions ?? [] : [])],
      ...(own && provider !== undefined ? { provider } : {}),
      ...(own && model !== undefined ? { model } : {}),
      ...(own && deep !== undefined ? { deep } : {}),
      ...(index === 0
        ? { ...(replaceUserTurnIndex !== undefined ? { replaceUserTurnIndex } : {}), ...(userTurn !== undefined ? { userTurn } : {}) }
        : { replyToUserTurnIndex: this.started.userTurnIndex, sessionOwner: this.started.sessionOwner() }),
    };
  }

  /** Whether the next speaker answers after speaker `index` ended with
   * `status`. A failed speaker does not silence the others, but a cancel
   * does, and so does a missing message (its first run never saved it) or a
   * regenerated message whose first answer did not complete (its old replies
   * are still there). */
  continuesAfter(index: number, status: TaskStatus, userTurns: number): boolean {
    if (this.cancelled || status === 'cancelled' || index + 1 >= this.plan.speakers.length) { return false; }
    if (userTurns <= this.started.userTurnIndex) { return false; }
    return !(index === 0 && this.input.replaceUserTurnIndex !== undefined && status !== 'completed');
  }

  end(): void { this.started.release(); }
}
