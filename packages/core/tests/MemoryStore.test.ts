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
      "## Important User Memory\n\n- The user's editor is Neovim.",
      '## Preferences\n\n- Prefers concise answers.',
      '## Current Context\n\n- Working on Marifold memory migration.',
    ]);
  });

  it('forgetById / deleteById mutate exactly the identified entry (no fuzzy matching)', () => {
    const profilesDir = path.join(tempDir(), 'profiles');
    const store = new MemoryStore(profilesDir);
    const first = store.remember('default', 'user', 'Likes espresso.');
    const second = store.remember('default', 'user', 'Likes espresso machines.'); // fuzzy-similar text
    const third = store.remember('default', 'preferences', 'Prefers dark mode.');

    const forgot = store.forgetById('default', first.entry.id);
    expect(forgot.count).toBe(1);
    const afterForget = store.listEntries('default');
    expect(afterForget.find(e => e.id === first.entry.id)?.status).toBe('superseded');
    expect(afterForget.find(e => e.id === second.entry.id)?.status).toBe('active'); // similar text untouched

    const deleted = store.deleteById('default', third.entry.id);
    expect(deleted.count).toBe(1);
    expect(store.listEntries('default').some(e => e.id === third.entry.id)).toBe(false);

    expect(store.forgetById('default', 'no-such-id').count).toBe(0);
  });

  it('creates memory files when reading an existing profile without a memories directory', () => {
    const profilesDir = path.join(tempDir(), 'profiles');
    const profileDir = path.join(profilesDir, 'default');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), 'Identity');

    const memory = new MemoryStore(profilesDir).listPromptMemory('default');

    expect(memory).toEqual([]);
    expect(fs.existsSync(path.join(profileDir, 'memories', 'user.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(profileDir, 'memories', 'preferences.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(profileDir, 'memories', 'auto_short.jsonl'))).toBe(true);
  });

  it('deduplicates exact active memories', () => {
    const store = new MemoryStore(path.join(tempDir(), 'profiles'));

    const first = store.remember('default', 'user', 'Name: Jack');
    const second = store.remember('default', 'user', '  Name: Jack  ');

    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(store.listEntries('default')).toHaveLength(1);
  });

  it('applies model memory saves and supersedes matching conflict keys', () => {
    const store = new MemoryStore(path.join(tempDir(), 'profiles'));

    store.remember('default', 'user', 'Name: Jack', { sessionId: 'session-1' });
    store.applySavePayloads('default', [
      '{"memories":[{"kind":"user","text":"The user\'s name is Jane.","priority":0,"confidence":1,"stability":"stable","source":"user_direct","conflict_key":"user.name"}]}',
    ], { sessionId: 'session-2' });

    const entries = store.listEntries('default');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      text: 'Name: Jack',
      status: 'superseded',
      session_id: 'session-1',
    });
    expect(entries[1]).toMatchObject({
      text: "The user's name is Jane.",
      status: 'active',
      conflict_key: 'user.name',
      session_id: 'session-2',
      supersedes: [entries[0].id],
    });
    expect(store.listPromptMemory('default')).toEqual(["## Important User Memory\n\n- The user's name is Jane."]);
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
      '## Preferences\n\n- Keep replies practical.',
    ]);
  });

  it('applies prompt context limits', () => {
    const store = new MemoryStore(path.join(tempDir(), 'profiles'));
    store.remember('default', 'user', 'First memory line.');
    store.remember('default', 'preferences', 'Second memory line.');

    expect(store.listPromptMemory('default', { contextLimit: 64 })).toEqual([
      '## Important User Memory\n\n- First memory line.',
    ]);
  });

  it('coerces time-sensitive user facts and response preferences into the right memory kinds', () => {
    const store = new MemoryStore(path.join(tempDir(), 'profiles'));

    store.applySavePayloads('default', [
      '{"memories":[{"kind":"user","text":"I have a project meeting tomorrow at 3 p.m.","priority":2,"confidence":1,"stability":"stable","source":"user_direct"}]}',
      '{"memories":[{"kind":"user","text":"I prefer short, normal conversation replies.","priority":0,"confidence":1,"stability":"stable","source":"user_direct"}]}',
    ]);

    const entries = store.listEntries('default');
    expect(entries).toMatchObject([
      {
        kind: 'preferences',
        text: 'I prefer short, normal conversation replies.',
        priority: 2,
        conflict_key: 'preferences.reply_style',
      },
      {
        kind: 'auto_short',
        text: 'I have a project meeting tomorrow at 3 p.m.',
        priority: 2,
        conflict_key: 'auto_short.project_meeting_time',
      },
    ]);
  });

  it('merges exact duplicates while keeping the strongest priority and confidence', () => {
    const store = new MemoryStore(path.join(tempDir(), 'profiles'));

    store.applySavePayloads('default', [
      '{"memories":[{"kind":"preferences","text":"Prefers short replies.","priority":5,"confidence":0.5}]}',
      '{"memories":[{"kind":"preferences","text":"Prefers short replies.","priority":2,"confidence":0.9}]}',
    ]);

    const entries = store.listEntries('default');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      priority: 2,
      confidence: 0.9,
    });
  });

  it('infers favorite conflict slots and canonicalizes conflict key aliases', () => {
    const store = new MemoryStore(path.join(tempDir(), 'profiles'));

    store.applySavePayloads('default', [
      '{"memories":[{"kind":"user","text":"The user\'s favorite editor is VS Code.","priority":2,"confidence":1,"stability":"stable","source":"user_direct"}]}',
    ]);
    store.applySavePayloads('default', [
      '{"memories":[{"kind":"user","text":"The user\'s favorite editor is Neovim.","priority":2,"confidence":1,"stability":"stable","source":"user_direct"}]}',
      '{"memories":[{"kind":"user","text":"The user\'s favorite color is blue.","priority":2,"confidence":1,"stability":"stable","source":"user_direct","conflict_key":"user.favorite_colour"}]}',
    ]);

    const rows = store.listEntries('default');
    expect(rows[0]).toMatchObject({ status: 'superseded' });
    expect(rows[1]).toMatchObject({ status: 'active' });
    expect(rows[2]).toMatchObject({ conflict_key: 'user.favorite_color' });
    const rendered = store.listPromptMemory('default', { prompt: 'Which editor do I like?' }).join('\n\n');
    expect(rendered).toContain('Neovim');
    expect(rendered).not.toContain('VS Code');
  });

  it('uses simple-prompt recall gating and thinking-mode priority expansion', () => {
    const store = new MemoryStore(path.join(tempDir(), 'profiles'));

    store.applySavePayloads('default', [
      '{"memories":[{"kind":"user","text":"The user\'s name is Jack.","priority":0,"confidence":1,"stability":"stable","source":"user_direct","conflict_key":"user.name"}]}',
      '{"memories":[{"kind":"preferences","text":"The user prefers Python examples.","priority":2}]}',
      '{"memories":[{"kind":"auto_short","text":"Low priority old context.","priority":8}]}',
    ]);

    const simple = store.listPromptMemory('default', { prompt: 'hello' }).join('\n\n');
    expect(simple).toContain('Jack');
    expect(simple).not.toContain('Python examples');
    expect(simple).not.toContain('Low priority');

    const normal = store.listPromptMemory('default', { prompt: 'What context do you have?' }).join('\n\n');
    const thinking = store.listPromptMemory('default', { prompt: 'What context do you have?', thinking: true }).join('\n\n');
    expect(normal).not.toContain('Low priority');
    expect(thinking).toContain('Low priority');
  });

  it('ranks same-priority memory by prompt relevance', () => {
    const store = new MemoryStore(path.join(tempDir(), 'profiles'));

    store.applySavePayloads('default', [
      '{"memories":[{"kind":"preferences","text":"Prefers Go examples.","priority":2}]}',
      '{"memories":[{"kind":"preferences","text":"Prefers Python examples.","priority":2}]}',
    ]);

    const rendered = store.listPromptMemory('default', { prompt: 'Can you show Python code?' }).join('\n\n');
    expect(rendered.indexOf('Python examples')).toBeLessThan(rendered.indexOf('Go examples'));
  });

  it('trims low-priority short-term memory while preserving critical entries', () => {
    const store = new MemoryStore(path.join(tempDir(), 'profiles'));
    const memories = [
      { kind: 'auto_short', text: 'Critical short fact.', priority: 0, confidence: 1, stability: 'stable' },
      ...Array.from({ length: 20 }, (_, index) => ({
        kind: 'auto_short',
        text: `low priority fact ${index} `.repeat(20),
        priority: 9,
      })),
    ];

    store.applySavePayloads('default', [JSON.stringify({ memories })]);
    store.trimShortTerm('default', 800);

    const entries = store.listEntries('default');
    expect(entries.some(entry => entry.text === 'Critical short fact.')).toBe(true);
    expect(entries.length).toBeLessThan(21);
  });
});

describe('MemoryStore /remember statements and restore', () => {
  const active = (store: MemoryStore) => store.listEntries('default').filter(entry => entry.status === 'active').map(entry => entry.text);

  it('replaces an earlier value for the same fact and keeps unrecognized text verbatim', () => {
    const store = new MemoryStore(tempDir());
    store.rememberStatement('default', 'I prefer tea');
    store.rememberStatement('default', 'I prefer coffee');
    store.rememberStatement('default', 'my favorite color is green');
    store.rememberStatement('default', 'my favorite color is blue');
    store.rememberStatement('default', 'I prefer tea in the morning');
    store.rememberStatement('default', 'The garage code is 4412');
    expect(active(store).sort()).toEqual([
      'The garage code is 4412',
      'The user prefers coffee.',
      'The user prefers tea in the morning.',
      "The user's favorite color is blue.",
    ]);
  });

  it('keeps the whole text when a statement says more than the extracted fact', () => {
    const store = new MemoryStore(tempDir());
    store.rememberStatement('default', "my name is Jack and I'm on project Atlas");
    expect(active(store).sort()).toEqual(["The user's name is Jack.", "my name is Jack and I'm on project Atlas"]);
  });

  it('restores a forgotten entry and supersedes the value that replaced it', () => {
    const store = new MemoryStore(tempDir());
    const tea = store.rememberStatement('default', 'I prefer tea').entry;
    store.rememberStatement('default', 'I prefer coffee');
    expect(active(store)).toEqual(['The user prefers coffee.']);
    expect(store.restoreById('default', tea.id).count).toBe(1);
    expect(active(store)).toEqual(['The user prefers tea.']);
  });
});

describe('turn memory for agent objectives', () => {
  it('does not read forgets out of task wording', async () => {
    const { applyTurnMemory } = await import('../src/memory/TurnMemory');
    const store = new MemoryStore(tempDir());
    store.rememberStatement('default', 'My name is Jack.');
    const none = { savePayloads: [], forgetPayloads: [] };
    applyTurnMemory(store, 'default', 'Remove the name column from data.csv.', none, { sizeLimit: 50000, promptForgets: false });
    expect(store.listEntries('default').filter(entry => entry.status === 'active').map(entry => entry.text)).toContain("The user's name is Jack.");
    applyTurnMemory(store, 'default', 'Remove the name column from data.csv.', none, { sizeLimit: 50000 });
    expect(store.listEntries('default').filter(entry => entry.status === 'active').map(entry => entry.text)).not.toContain("The user's name is Jack.");
  });
});
