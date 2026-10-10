import { describe, expect, it } from 'vitest';
import { sessionImageInput, sessionImageRefs } from '../src/agent/EarlierImages';

describe('earlier session images', () => {
  const turns = [
    { role: 'user' as const, content: 'first  photo', timestamp: 't', attachments: [{ kind: 'image' as const, mediaType: 'image/png' }] },
    { role: 'assistant' as const, content: 'ok', timestamp: 't' },
    { role: 'user' as const, content: 'no image', timestamp: 't' },
    { role: 'assistant' as const, content: 'ok', timestamp: 't' },
    { role: 'user' as const, content: 'two photos', timestamp: 't', attachments: [{ kind: 'image' as const, mediaType: 'image/jpeg' }, { kind: 'image' as const, mediaType: 'image/webp' }] },
  ];

  it('lists images by user-turn and attachment index, stopping before an edited turn', () => {
    expect(sessionImageRefs(turns)).toEqual([
      { userTurnIndex: 0, attachmentIndex: 0, mediaType: 'image/png', turn: 'first photo' },
      { userTurnIndex: 2, attachmentIndex: 0, mediaType: 'image/jpeg', turn: 'two photos' },
      { userTurnIndex: 2, attachmentIndex: 1, mediaType: 'image/webp', turn: 'two photos' },
    ]);
    expect(sessionImageRefs(turns, 2).map(ref => ref.userTurnIndex)).toEqual([0]);
  });

  it('prefers the original file, then embedded bytes, then a URL', () => {
    expect(sessionImageInput({ mediaType: 'image/png', path: '/p.png', data: '' })).toEqual({ path: '/p.png', mediaType: 'image/png' });
    expect(sessionImageInput({ mediaType: 'image/png', data: 'AAA' })).toEqual({ data: 'AAA', mediaType: 'image/png' });
    expect(sessionImageInput({ mediaType: 'image/png', url: 'https://x/y.png' })).toEqual({ url: 'https://x/y.png', mediaType: 'image/png' });
    expect(sessionImageInput(undefined)).toBeUndefined();
  });
});
