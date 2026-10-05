import { describe, expect, it } from 'vitest';
import { resolveFullscreen } from '../src/core/tuiSettings.js';

describe('full-screen launch settings', () => {
  it('defaults to full-screen and respects the local config', () => {
    expect(resolveFullscreen(undefined, undefined, '')).toBe(true);
    expect(resolveFullscreen(undefined, { fullscreen: false }, '')).toBe(false);
    expect(resolveFullscreen(undefined, { fullscreen: true }, '')).toBe(true);
  });

  it('lets environment preferences override config without overriding explicit flags', () => {
    expect(resolveFullscreen(undefined, { fullscreen: false }, '1')).toBe(true);
    expect(resolveFullscreen(undefined, { fullscreen: true }, '0')).toBe(false);
    expect(resolveFullscreen(false, { fullscreen: true }, '1')).toBe(false);
    expect(resolveFullscreen(true, { fullscreen: false }, '0')).toBe(true);
    expect(resolveFullscreen(undefined, { fullscreen: false }, 'invalid')).toBe(false);
  });
});
