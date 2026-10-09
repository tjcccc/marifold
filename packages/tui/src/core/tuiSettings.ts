import type { MarifoldTuiConfig } from '@marifold/core';

/** Explicit launch flags override the shell preference, then the local config. */
export function resolveFullscreen(override: boolean | undefined, config: MarifoldTuiConfig | undefined, environment = process.env.MARIFOLD_FULLSCREEN): boolean {
  if (override !== undefined) { return override; }
  if (environment === '1') { return true; }
  if (environment === '0') { return false; }
  return config?.fullscreen ?? true;
}
