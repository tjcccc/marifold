import { describe, expect, it } from 'vitest';
import { leadingToken, menuQuery, parseCommand, splitLeading, WEB_COMMANDS } from '../../src/lib/commandSyntax';

describe('commandSyntax', () => {
  it('detects leading $skill and /command tokens at a word boundary', () => {
    expect(leadingToken('$make-midjourney-prompt #x')).toEqual({ sigil: '$', token: '$make-midjourney-prompt' });
    expect(leadingToken('/model xai/grok-4.5')).toEqual({ sigil: '/', token: '/model' });
    expect(leadingToken('/help')).toEqual({ sigil: '/', token: '/help' });
  });

  it('does not treat a path, mid-text sigil, or bare sigil as a token', () => {
    expect(leadingToken('/path/to/file')).toBeUndefined(); // no boundary after "path"
    expect(leadingToken('say $hi')).toBeUndefined();
    expect(leadingToken('$')).toBeUndefined();
  });

  it('menuQuery follows the leading token while its caret is being edited', () => {
    expect(menuQuery('$mak')).toEqual({ sigil: '$', query: 'mak', end: 4 });
    expect(menuQuery('/mo')).toEqual({ sigil: '/', query: 'mo', end: 3 });
    expect(menuQuery('/')).toEqual({ sigil: '/', query: '', end: 1 });
    expect(menuQuery('/mod existing args', 4)).toEqual({ sigil: '/', query: 'mod', end: 4 });
    expect(menuQuery('/mod existing args')).toBeUndefined(); // caret is in the args
    expect(menuQuery('/model ')).toBeUndefined();
    expect(menuQuery('hello')).toBeUndefined();
  });

  it('splitLeading separates the token for highlighting', () => {
    expect(splitLeading('/new')).toEqual({ token: '/new', rest: '' });
    expect(splitLeading('$translate hola')).toEqual({ token: '$translate', rest: ' hola' });
    expect(splitLeading('plain text')).toEqual({ rest: 'plain text' });
  });

  it('parseCommand parses /name and args, ignoring paths and plain text', () => {
    expect(parseCommand('/help')).toEqual({ name: 'help', args: '' });
    expect(parseCommand('/model xai/grok-4.5')).toEqual({ name: 'model', args: 'xai/grok-4.5' });
    expect(parseCommand('/path/to/file')).toBeUndefined();
    expect(parseCommand('hello')).toBeUndefined();
  });

  it('exposes the wired web command set', () => {
    expect(WEB_COMMANDS.map(command => command.name)).toEqual([
      'help', 'status', 'copy', 'retry', 'attach-original', 'new', 'agent', 'chat', 'think',
      'model', 'btw', 'stop', 'remember', 'forget', 'context-window', 'compact',
    ]);
  });
});
