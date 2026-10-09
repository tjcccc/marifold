import type { MemoryEntry } from './MemoryTypes';

// Text, number, and time helpers plus the recall heuristics (time-sensitive, reply-style, identity, simple prompts).

export function looksTimeSensitive(text: string): boolean {
  const normalized = normalizeText(text);
  if (!/\b(today|tomorrow|tonight|meeting|deadline|appointment|reminder|schedule)\b/.test(normalized)) { return false; }
  return Boolean(
    /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)\b/.test(normalized)
    || /\b\d{4}-\d{2}-\d{2}\b/.test(normalized),
  );
}

export function looksResponsePreference(text: string): boolean {
  const normalized = normalizeText(text);
  if (!/\b(prefer|prefers|preference|like|likes)\b/.test(normalized)) { return false; }
  return Boolean(
    /\b(reply|replies|answer|answers|response|responses|conversation|tone|style)\b/.test(normalized)
    || /\b(short|brief|concise|detailed|normal|casual|formal)\b/.test(normalized),
  );
}

export function looksIdentityNameFact(text: string): boolean {
  const normalized = normalizeText(text);
  return Boolean(
    /\b(?:the\s+)?user(?:'s)?\s+name\s+is\b/.test(normalized)
    || /\buser\s+is\s+named\b/.test(normalized)
    || /^name\s*:/.test(normalized)
    || /\bpreferred\s+name\b/.test(normalized)
    || /\bcall\s+(?:the\s+)?user\b/.test(normalized),
  );
}

export function isSimpleMemoryPrompt(prompt: string): boolean {
  const normalized = normalizeText(prompt);
  if (!normalized || normalized.length > 80) { return false; }
  return [
    /^(?:hi|hello|hey|yo|sup|hiya|howdy)[!. ]*$/i,
    /^(?:thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|got it|sounds good)[!. ]*$/i,
    /^(?:good morning|good afternoon|good evening|good night)[!. ]*$/i,
    /^(?:yes|no|yep|yeah|nope|sure|alright|all right)[!. ]*$/i,
  ].some(pattern => pattern.test(normalized));
}

export function meetingDate(text: string): string {
  const match = /\b\d{4}-\d{2}-\d{2}\b|\btomorrow\b|\btoday\b|\btonight\b/i.exec(text);
  return match ? match[0].toLowerCase() : '';
}

export function entryKey(entry: MemoryEntry): string {
  return `${entry.kind}:${normalizeText(entry.text)}`;
}

export function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/^\s*[-*]\s*/, '').replace(/\s+/g, ' ').replace(/[.;]+$/g, '');
}

export function slotKey(value: string): string {
  let key = value.trim().toLowerCase().replace(/colour/g, 'color');
  key = key.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
  if (key.startsWith('fav_')) { key = `favorite_${key.slice(4)}`; }
  return key.slice(0, 40).replace(/^_+|_+$/g, '');
}

export function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

export function intersects<T>(a: Set<T>, b: Set<T>): boolean {
  for (const item of a) { if (b.has(item)) { return true; } }
  return false;
}

export function isSubset<T>(a: Set<T>, b: Set<T>): boolean {
  for (const item of a) { if (!b.has(item)) { return false; } }
  return true;
}

export function intersectionSize<T>(a: Set<T>, b: Set<T>): number {
  let count = 0;
  for (const item of a) { if (b.has(item)) { count += 1; } }
  return count;
}

export function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

export function isExpired(entry: MemoryEntry, nowTs = Date.now() / 1000): boolean {
  if (!entry.expires_at) { return false; }
  const expires = timestamp(entry.expires_at);
  return expires > 0 && expires <= nowTs;
}

export function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function clampInteger(value: unknown, fallback: number, low: number, high: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(low, Math.min(high, number));
}

export function clampNumber(value: unknown, fallback: number, low: number, high: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(low, Math.min(high, number));
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
