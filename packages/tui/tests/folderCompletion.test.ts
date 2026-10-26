import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderCompletion } from '../src/core/folderCompletion';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

describe('folderCompletion', () => {
  it('completes folders for /trust-folder and /add-dir, from home or the working folder', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-folder-completion-'));
    dirs.push(home);
    for (const folder of ['tempfiles/invoices', 'tempfiles/notes', 'Documents', '.hidden']) { fs.mkdirSync(path.join(home, folder), { recursive: true }); }
    fs.writeFileSync(path.join(home, 'tempfiles', 'a.txt'), 'x');

    expect(folderCompletion('/add-dir ~', home, home)?.items.map(item => item.name)).toEqual(['~/Documents/', '~/tempfiles/']);
    expect(folderCompletion('/trust-folder ~/temp', home, home)).toEqual({ start: 14, partial: '~/temp', items: [{ name: '~/tempfiles/' }] });
    // Files are left out; hidden folders appear once a dot is typed.
    expect(folderCompletion('/add-dir ~/tempfiles/', home, home)?.items.map(item => item.name)).toEqual(['~/tempfiles/invoices/', '~/tempfiles/notes/']);
    expect(folderCompletion('/add-dir ~/.h', home, home)?.items.map(item => item.name)).toEqual(['~/.hidden/']);
    // Relative paths complete against the working folder.
    expect(folderCompletion('/add-dir tempfiles/n', home, home)?.items.map(item => item.name)).toEqual(['tempfiles/notes/']);
    expect(folderCompletion('/add-dir ~/missing/', home, home)?.items).toEqual([]);
    expect(folderCompletion('/model ~/', home, home)).toBeUndefined();
  });
});
