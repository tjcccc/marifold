import React from 'react';
import { Box, Text } from 'ink';
import * as path from 'path';
import type { AppState } from '../core/appState.js';
import { DIM } from './theme.js';

/**
 * Persistent identity line pinned below the input: working-dir basename,
 * profile and provider/model on the left; the input-grammar hint on
 * the right. Run activity lives in the transient {@link RunStatus} line above
 * the input, so this line stays stable across a run.
 */
/** Compact token count: 16000 → "16K", 9900 → "9.9K", 940 → "940". */
function shortTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}K`;
}

/** `ctx 62% · 9.9K/16K` once a budget is set; `ctx –/16K` before the first measured turn. */
function contextGauge(state: AppState): string | undefined {
  if (state.maxContextTokens == null || state.maxContextTokens <= 0) return undefined;
  const budget = shortTokens(state.maxContextTokens);
  if (state.contextTokens == null) return `ctx –/${budget}`;
  const pct = Math.round((state.contextTokens / state.maxContextTokens) * 100);
  return `ctx ${pct}% · ${shortTokens(state.contextTokens)}/${budget}`;
}

export function StatusLine({ state }: { state: AppState }): React.ReactElement {
  const gauge = contextGauge(state);
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>
        <Text bold>{path.basename(state.cwd)}</Text>
        <Text color={DIM}> | </Text>
        <Text bold>{state.profile}</Text>
        <Text color={DIM}> · {state.provider}/{state.model}</Text>
        {gauge ? <Text color={DIM}> · {gauge}</Text> : null}
      </Text>
      <Text color={DIM}>$skill · /command</Text>
    </Box>
  );
}
