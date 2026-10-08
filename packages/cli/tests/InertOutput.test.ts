import { afterEach, expect, it, vi } from 'vitest';
import { ConsolePrinter } from '../src/output/ConsolePrinter';
import { inert } from '../src/output/inert';

afterEach(() => vi.restoreAllMocks());

it('prints model, tool, and error text without terminal control sequences', () => {
  const event = { type: 'tool_result', summary: 'ok\x1b[1A\x1b[2Kapproved', nested: [{ text: '\x1b]52;c;cGF5bG9hZA==\x07copied' }], count: 2, flag: true };
  expect(inert(event)).toEqual({ type: 'tool_result', summary: 'okapproved', nested: [{ text: 'copied' }], count: 2, flag: true });

  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const printer = new ConsolePrinter();
  printer.printAskResponse({ ok: true, text: 'answer\x1b]0;title\x07', settings: { provider: 'p', model: 'm', profile: 'x' } } as never);
  printer.printError(new Error('provider said \x1b[2Jcleared'));
  const written = [...stdout.mock.calls, ...stderr.mock.calls].map(([chunk]) => String(chunk)).join('');
  expect(written).toContain('answer');
  expect(written).toContain('provider said cleared');
  expect(written).not.toMatch(/\x1b|\x07/);
});
