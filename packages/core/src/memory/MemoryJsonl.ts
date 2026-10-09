import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { JsonLine, MemoryEntry, MemoryKind } from './MemoryTypes';
import { DEFAULT_PRIORITY, entryFromRecord } from './MemoryRecords';

// Reading and atomically writing the per-kind memory JSONL files.

export function readJsonlLines(filePath: string, fallbackKind: MemoryKind): JsonLine[] {
  if (!fs.existsSync(filePath)) { return []; }
  return fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(raw => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const entry = entryFromRecord(parsed, fallbackKind, {
          source: 'manual',
          priority: DEFAULT_PRIORITY,
          confidence: 0.6,
          scope: 'profile',
        });
        return entry ? { raw, entry } : { raw };
      } catch {
        return { raw };
      }
    });
}

export function writeJsonlLines(filePath: string, lines: JsonLine[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = lines
    .map(line => line.entry ? JSON.stringify(line.entry) : line.raw)
    .join('\n');
  atomicWrite(filePath, text ? `${text}\n` : '');
}

export function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

export function serializedJsonlLength(entries: MemoryEntry[]): number {
  return entries.reduce((sum, entry) => sum + JSON.stringify(entry).length + 1, 0);
}
