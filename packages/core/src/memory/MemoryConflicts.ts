import type { MemoryEntry } from './MemoryTypes';
import { looksIdentityNameFact, looksResponsePreference, meetingDate, normalizeText, slotKey, stringValue } from './MemoryText';

// Conflict keys: canonical aliases, generic-slot rejection, and inferred conflict groups for supersession.

export const CONFLICT_KEY_RE = /^(?:user|preferences|auto_short)(?:\.[a-z0-9][a-z0-9_]{0,39}){1,5}$/;

export const CONFLICT_KEY_ALIASES: Record<string, string> = {
  'user.fav_color': 'user.favorite_color',
  'user.favorite_colour': 'user.favorite_color',
  'user.preferred_color': 'user.favorite_color',
  'user.preferred_colour': 'user.favorite_color',
  'user.color': 'user.favorite_color',
  'user.colour': 'user.favorite_color',
  'user.color_preference': 'user.favorite_color',
  'user.colour_preference': 'user.favorite_color',
  'user.preferred_name': 'user.name',
  'user.preferred.name': 'user.name',
  'preferences.answer_style': 'preferences.reply_style',
  'preferences.answers_style': 'preferences.reply_style',
  'preferences.response_style': 'preferences.reply_style',
  'preferences.responses_style': 'preferences.reply_style',
  'preferences.communication_style': 'preferences.reply_style',
  'preferences.conversation_style': 'preferences.reply_style',
  'preferences.tone_style': 'preferences.reply_style',
  'preferences.reply_length': 'preferences.reply_style',
  'preferences.response_length': 'preferences.reply_style',
  'preferences.preferred_language': 'preferences.language',
  'preferences.language_preference': 'preferences.language',
  'auto_short.project_meeting': 'auto_short.project_meeting_time',
  'auto_short.meeting': 'auto_short.meeting_time',
};

export const GENERIC_CONFLICT_KEYS = new Set([
  'user.info',
  'user.fact',
  'user.memory',
  'preferences.info',
  'preferences.fact',
  'preferences.memory',
  'auto_short.info',
  'auto_short.fact',
  'auto_short.memory',
]);

export function conflictGroups(entry: MemoryEntry): Set<string> {
  const groups = new Set<string>();
  const conflictKey = normalizeConflictKey(entry.conflict_key);
  if (conflictKey) {
    groups.add(conflictKey);
    if (conflictKey.endsWith('project_meeting_time')) { groups.add(`${entry.kind}:meeting:project`); }
    else if (conflictKey.endsWith('meeting_time')) { groups.add(`${entry.kind}:meeting:general`); }
  }

  const inferred = inferredConflictGroup(entry);
  if (inferred) {
    groups.add(inferred);
    if (inferred.includes(':meeting:')) {
      const parts = inferred.split(':');
      if (parts.length >= 4) { groups.add(`${entry.kind}:meeting:${parts[parts.length - 1]}`); }
    }
  }
  return groups;
}

export function inferredConflictGroup(entry: MemoryEntry): string | undefined {
  const normalized = normalizeText(entry.text);
  if (entry.kind === 'user') {
    if (looksIdentityNameFact(entry.text)) { return 'user.name'; }
    const favoriteKey = favoriteConflictKeyFromText(normalized);
    if (favoriteKey) { return favoriteKey; }
  }
  if (entry.kind === 'preferences' && looksResponsePreference(entry.text)) { return 'preferences.reply_style'; }
  if (normalized.includes('meeting') && /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)\b/.test(normalized)) {
    const date = meetingDate(entry.text) || 'unspecified';
    const topic = normalized.includes('project meeting') ? 'project' : 'general';
    return `${entry.kind}:meeting:${date}:${topic}`;
  }
  return undefined;
}

export function favoriteConflictKeyFromText(text: string): string | undefined {
  const patterns = [
    /\b(?:the\s+)?user(?:'s)?\s+favou?rite\s+([a-z0-9][a-z0-9 _-]{0,40}?)\s+(?:is|=|:)\b/,
    /\bmy\s+favou?rite\s+([a-z0-9][a-z0-9 _-]{0,40}?)\s+(?:is|=|:)\b/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) { continue; }
    const slot = slotKey(match[1]);
    if (slot) { return normalizeConflictKey(`user.favorite_${slot}`); }
  }
  return undefined;
}

export function preserveMeetingDate(incoming: MemoryEntry, conflicts: MemoryEntry[]): void {
  if (incoming.kind !== 'auto_short') { return; }
  const incomingText = normalizeText(incoming.text);
  if (!incomingText.includes('meeting') || meetingDate(incoming.text)) { return; }
  for (const entry of conflicts) {
    const dateText = meetingDate(entry.text);
    if (!dateText) { continue; }
    incoming.text = incoming.text.replace(/\b(meeting)(\s+at\s+)/i, `$1 ${dateText}$2`);
    return;
  }
}

export function normalizeConflictKey(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) { return undefined; }
  let key = raw
    .toLowerCase()
    .replace(/-/g, '_')
    .replace(/:/g, '.')
    .replace(/\s+/g, '_')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
  key = CONFLICT_KEY_ALIASES[key] ?? key;
  if (key.startsWith('user.preferred_') && key !== 'user.preferred_name') {
    key = `user.favorite_${key.slice('user.preferred_'.length)}`;
  }
  if (key.startsWith('user.fav_')) { key = `user.favorite_${key.slice('user.fav_'.length)}`; }
  key = key.replace(/favourite/g, 'favorite').replace(/colour/g, 'color');
  key = CONFLICT_KEY_ALIASES[key] ?? key;
  if (GENERIC_CONFLICT_KEYS.has(key)) { return undefined; }
  return CONFLICT_KEY_RE.test(key) ? key : undefined;
}
