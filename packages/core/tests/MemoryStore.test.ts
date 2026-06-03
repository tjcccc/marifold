import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, ensureProfileMemoryFiles } from '../src';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-memory-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('MemoryStore', () => {
  it('scaffolds priests-style memory JSONL files', () => {
    const profileDir = path.join(tempDir(), 'profiles', 'default');
    const files = ensureProfileMemoryFiles(profileDir);

    expect(files.map(file => path.basename(file.path))).toEqual([
      'user.jsonl',
      'preferences.jsonl',
      'auto_short.jsonl',
    ]);
    for (const file of files) {
      expect(file.status).toBe('created');
      expect(fs.existsSync(file.path)).toBe(true);
    }
  });

  it('remembers and recalls active profile memory', () => {
    const profilesDir = path.join(tempDir(), 'profiles');
    const store = new MemoryStore(profilesDir);

    const user = store.remember('default', 'user', "The user's editor is Neovim.");
    const preference = store.remember('default', 'preferences', 'Prefers concise answers.');
    const short = store.remember('default', 'auto_short', 'Working on Marifold memory migration.');

    expect(user.created).toBe(true);
    expect(preference.created).toBe(true);
    expect(short.created).toBe(true);
    expect(store.listPromptMemory('default')).toEqual([
      "User: The user's editor is Neovim.",
      'Preference: Prefers concise answers.',
      'Short-term: Working on Marifold memory migration.',
    ]);
  });

  it('deduplicates exact active memories', () => {
    const store = new MemoryStore(path.join(tempDir(), 'profiles'));

    const first = store.remember('default', 'user', 'Name: Jack');
    const second = store.remember('default', 'user', '  Name: Jack  ');

    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(store.listEntries('default')).toHaveLength(1);
  });

  it('soft-forgets and permanently deletes matching JSONL records', () => {
    const store = new MemoryStore(path.join(tempDir(), 'profiles'));
    store.remember('default', 'user', "The user's favorite editor is Neovim.");
    store.remember('default', 'preferences', 'Prefers concise answers.');

    const forgot = store.forget('default', 'editor');
    expect(forgot.count).toBe(1);
    expect(store.listPromptMemory('default')).not.toContain("User: The user's favorite editor is Neovim.");

    const deleted = store.delete('default', 'concise');
    expect(deleted.count).toBe(1);
    expect(store.listEntries('default')).toHaveLength(1);
  });

  it('reads legacy markdown memory files as prompt fallback', () => {
    const profilesDir = path.join(tempDir(), 'profiles');
    const memoriesDir = path.join(profilesDir, 'default', 'memories');
    fs.mkdirSync(memoriesDir, { recursive: true });
    fs.writeFileSync(path.join(memoriesDir, 'preferences.md'), '# Preferences\n- Keep replies practical.\n');

    expect(new MemoryStore(profilesDir).listPromptMemory('default')).toEqual([
      'Preference: - Keep replies practical.',
    ]);
  });
});
