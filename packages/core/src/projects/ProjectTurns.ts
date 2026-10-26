import { matchMention, mentionTokens } from '../agent/Mentions';
import { MarifoldError } from '../errors/MarifoldError';
import type { SessionLeases } from '../sessions/SessionLeases';
import type { ProjectDetail, ProjectStore } from './ProjectStore';

/**
 * Who answers a message in a project session (docs/projects.md#who-answers),
 * decided on the host so every client and device routes alike. Profiles are
 * mentioned by name (`@dev_test`), never by display name: names cannot collide
 * with device names, display names can.
 */

export interface ProjectTurnPlan {
  projectId: string;
  /** Profiles that answer, one run each, in mention order. */
  speakers: string[];
  /** Each speaker's project block, placed before the request's own instructions. */
  instructions: Record<string, string[]>;
  /** The floor after this message: a profile, `null` for the Lead; absent leaves it. */
  floor?: string | null;
  /** The session does not exist yet: it joins the project before its first run saves it. */
  newSession?: boolean;
}

export interface ProjectRoute {
  speakers: string[];
  floor?: string | null;
}

/** The roster profiles a message mentions, in order, else the floor, else the
 * Lead. One mention takes the floor, several hand it back to the Lead. A
 * mentioned profile off the roster asks for an invite; other mentions are
 * devices, left for device routing. */
export function routeProjectMessage(text: string, project: Pick<ProjectDetail, 'id' | 'lead' | 'members'>, floor: string | undefined, profileNames: () => readonly string[]): ProjectRoute {
  const speakers: string[] = [];
  let names: readonly string[] | undefined;
  for (const mention of mentionTokens(text)) {
    const [member] = matchMention(mention, project.members, name => [name]).targets;
    if (member !== undefined) {
      if (!speakers.includes(member)) { speakers.push(member); }
      continue;
    }
    names ??= profileNames();
    const profile = matchMention(mention, names, name => [name]).targets;
    if (profile.length === 1) { throw MarifoldError.projectMemberRequired(project.id, profile[0]!); }
  }
  if (speakers.length === 0) { return { speakers: [floor !== undefined && project.members.includes(floor) ? floor : project.lead] }; }
  return { speakers, floor: speakers.length === 1 ? speakers[0]! : null };
}

/** The text without its roster mentions, for device routing (`@painter on @office …`). */
export function withoutProfileMentions(text: string, members: readonly string[]): string {
  let kept = '';
  let from = 0;
  for (const mention of mentionTokens(text)) {
    const { targets, end } = matchMention(mention, members, name => [name]);
    if (targets.length !== 1) { continue; }
    kept += text.slice(from, mention.at);
    from = end;
  }
  return (kept + text.slice(from)).trim();
}

/** A speaker's project block: who it is among the roster, then the project's
 * own instructions, which apply on top of the profile's. */
export function projectInstructions(project: ProjectDetail, speaker: string): string[] {
  const roster = project.members.map(name => name === project.lead ? `${name} (Lead)` : name).join(', ');
  const instructions = project.instructions.trim();
  return [[
    `## Project: ${project.name}`,
    `This conversation belongs to the project "${project.name}"${project.description ? ` (${project.description})` : ''}. You are ${speaker}, one of its profiles: ${roster}. The user addresses profiles with @name, and replies from other profiles are labelled with their names. Reply only as ${speaker}; never write replies for other profiles.`,
    ...(instructions ? ['', "Project instructions (for every profile here; where they conflict with a profile's general guidance, they win):", instructions] : []),
  ].join('\n')];
}

export interface ProjectTurnHost {
  projects: ProjectStore;
  /** Every profile name, read only when a mention names no roster profile. */
  profileNames(): readonly string[];
  sessionExists(sessionId: string): boolean;
}

export interface ProjectRunRequest {
  sessionId?: string;
  objective: string;
  userTurn?: string;
  profile?: string;
  lean?: boolean;
  replaceUserTurnIndex?: number;
}

/**
 * The project turn a run request starts, or undefined outside projects. A new
 * session joins a project by naming it (`projectId`); an existing one must be
 * moved there first. A skill (`lean`) was expanded for one profile's Skills, so
 * it runs only when that profile answers. `deviceText` is the request text
 * without its profile mentions, for device routing.
 */
export function planProjectTurn(host: ProjectTurnHost, input: ProjectRunRequest, projectId?: string): { plan: ProjectTurnPlan; deviceText: { objective: string; userTurn?: string } } | undefined {
  const link = input.sessionId ? host.projects.sessionProject(input.sessionId) : undefined;
  if (projectId !== undefined) {
    if (!input.sessionId) { throw MarifoldError.projectInvalid('A project run needs a sessionId.', projectId); }
    if (link ? link.projectId !== projectId : host.sessionExists(input.sessionId)) {
      throw MarifoldError.projectInvalid(link ? 'This session belongs to another project.' : 'This session is not in the project; move it there first.', projectId);
    }
  }
  const id = link?.projectId ?? projectId;
  if (id === undefined) { return undefined; }
  const project = host.projects.get(id);
  if (!project) { throw MarifoldError.projectNotFound(id); }
  const { speakers, floor } = routeProjectMessage(input.userTurn ?? input.objective, project, link?.floor, () => host.profileNames());
  if (input.lean && (speakers.length > 1 || (input.profile !== undefined && speakers[0] !== input.profile))) {
    throw MarifoldError.projectInvalid(speakers.length > 1
      ? 'A skill runs for one profile; address a single profile.'
      : `This skill was prepared for ${input.profile}, but ${speakers[0]} answers here; address @${input.profile}.`, id);
  }
  return {
    plan: {
      projectId: id,
      speakers,
      instructions: Object.fromEntries(speakers.map(speaker => [speaker, projectInstructions(project, speaker)])),
      // Editing an earlier message leaves the floor where the conversation is now.
      ...(floor !== undefined && input.replaceUserTurnIndex === undefined ? { floor } : {}),
      ...(link ? {} : { newSession: true }),
    },
    deviceText: {
      objective: withoutProfileMentions(input.objective, project.members),
      ...(input.userTurn !== undefined ? { userTurn: withoutProfileMentions(input.userTurn, project.members) } : {}),
    },
  };
}

export interface ProjectTurnStart {
  /** The user-turn ordinal of the message every speaker answers: the edited
   * one, or the one the first speaker is about to save. */
  userTurnIndex: number;
  /** Whom a later speaker runs for: whoever holds the session now. */
  sessionOwner(): string;
  /** End the turn's hold on its session, after its last runner released it. */
  release(): void;
}

/** The run registry's project hooks. `beginProjectTurn` commits a planned
 * turn as its first run starts: it holds the session until the last speaker
 * ends, so a client leaving, or another device taking over, between speakers
 * neither frees the session nor fails the next speaker; then a new session
 * joins its project and the floor moves. Throws SESSION_BUSY like a run. */
export function projectTurnHooks(
  projects: ProjectStore,
  sessions: { get(sessionId: string): { turns: Array<{ role: string }> } | undefined },
  leases: Pick<SessionLeases, 'hold' | 'holder'>,
  defaultOwner: string,
) {
  const userTurnCount = (sessionId: string) => sessions.get(sessionId)?.turns.filter(turn => turn.role === 'user').length ?? 0;
  return {
    userTurnCount,
    beginProjectTurn: (sessionId: string, plan: ProjectTurnPlan, options: { replaceUserTurnIndex?: number; sessionOwner?: string }): ProjectTurnStart => {
      const owner = options.sessionOwner ?? defaultOwner;
      const release = leases.hold(sessionId, owner);
      try {
        if (plan.newSession) { projects.claimSession(sessionId, plan.projectId); }
        if (plan.floor !== undefined) { projects.setFloor(sessionId, plan.floor ?? undefined); }
      } catch (error) {
        release();
        throw error;
      }
      return { userTurnIndex: options.replaceUserTurnIndex ?? userTurnCount(sessionId), sessionOwner: () => leases.holder(sessionId) ?? owner, release };
    },
  };
}
