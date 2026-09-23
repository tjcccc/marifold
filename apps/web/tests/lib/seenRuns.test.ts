// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { SeenRuns } from '../../src/lib/seenRuns';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it('retains acknowledgements after reload and isolates server/workspace scopes', () => {
  new SeenRuns('/v1/workspaces/home/api').add('run-one');
  expect(new SeenRuns('/v1/workspaces/home/api').has('run-one')).toBe(true);
  expect(new SeenRuns('/v1/workspaces/office/api').has('run-one')).toBe(false);
  expect(new SeenRuns('https://other-server/v1/workspaces/home/api').has('run-one')).toBe(false);
});

it('keeps acknowledgements in memory when browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  const runs = new SeenRuns('');
  runs.add('run-one');
  expect(runs.has('run-one')).toBe(true);
});
