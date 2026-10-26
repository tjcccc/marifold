import { matchMention, mentionTokens } from '@marifold/client';

/**
 * Who answers a project message, previewed in the composer by the host's own
 * rule (core `routeProjectMessage`), with the same `@` parser: the roster
 * profiles mentioned, in order, else the floor, else the Lead. The host still
 * decides; this only shows it ahead of time.
 */

export interface ProjectRoster {
  lead: string;
  members: readonly string[];
}

export interface ProjectRoutePreview {
  speakers: string[];
  /** The floor after this message: a profile, `null` for the Lead; absent leaves it. */
  floor?: string | null;
  /** An existing profile off the roster: the host refuses the message until it is invited. */
  uninvited?: string;
}

export function previewProjectRoute(text: string, project: ProjectRoster, floor: string | undefined, profileNames: readonly string[]): ProjectRoutePreview {
  const speakers: string[] = [];
  for (const mention of mentionTokens(text)) {
    const [member] = matchMention(mention, project.members, name => [name]).targets;
    if (member !== undefined) {
      if (!speakers.includes(member)) { speakers.push(member); }
      continue;
    }
    const profile = matchMention(mention, profileNames, name => [name]).targets;
    if (profile.length === 1) { return { speakers, uninvited: profile[0] }; }
  }
  if (speakers.length === 0) { return { speakers: [answeringProfile(project, floor)] }; }
  return { speakers, floor: speakers.length === 1 ? speakers[0] : null };
}

/** The profile a message that addresses no one goes to. */
export function answeringProfile(project: ProjectRoster, floor: string | undefined): string {
  return floor !== undefined && project.members.includes(floor) ? floor : project.lead;
}

/** The text after its leading roster mentions (`@painter, $skill …` → `$skill …`),
 * so a skill can follow the profile it is for. */
export function afterLeadingMentions(text: string, members: readonly string[]): string {
  let rest = text;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, '');
    const [mention] = mentionTokens(trimmed);
    if (!mention || mention.at !== 0) { return trimmed; }
    const { targets, end } = matchMention(mention, members, name => [name]);
    if (targets.length !== 1) { return trimmed; }
    rest = trimmed.slice(end).replace(/^[\s,，:：]+/, '');
  }
}
