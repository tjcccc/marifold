import { readFileSync } from 'fs';
import { Box, render, Text } from 'ink';
import { MarifoldRuntime } from '@marifold/core';
import type { LoadedMarifoldConfig, MarifoldResolvedSettings, ProfileSummary } from '@marifold/core';
import { App } from './ui/App.js';
import { SelectList } from './ui/SelectList.js';
import type { TranscriptItemData } from './core/appState.js';

/** This package's version, read from its own package.json at runtime so the
 * header banner never drifts from the published version. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface RunTuiOptions {
  loadedConfig: LoadedMarifoldConfig;
  /** Profile to launch with; defaults to the configured default profile. */
  profile?: string;
  /** Resume a session: `true` continues the most recent session for the
   * resolved profile; a string continues that specific session id. The prior
   * turns are replayed into the transcript and the next message continues the
   * session's context. */
  resume?: string | boolean;
}

/**
 * Launch the Ink TUI. Falls back with a hint when stdout is not a TTY (piped
 * or non-interactive), so `marifold | cat` never tries to drive Ink. When no
 * profile resolves a provider/model, shows a profile picker before launching.
 */
export async function runTui(options: RunTuiOptions): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write(
      'The marifold TUI needs an interactive terminal. Use `marifold chat` or `marifold agent "<objective>"` for non-interactive use.\n',
    );
    process.exitCode = 1;
    return;
  }

  // Not initialized yet: no config file. Show one clear hint instead of a
  // pointless profile picker that can't resolve a provider/model anyway.
  if (!options.loadedConfig.foundConfig) {
    process.stderr.write('Marifold is not initialized yet. Run `marifold init` to get started.\n');
    process.exitCode = 1;
    return;
  }

  const runtime = new MarifoldRuntime({ loadedConfig: options.loadedConfig });
  try {
    let profile = options.profile;
    let settings = tryResolve(runtime, profile);

    // No resolvable default and no explicit profile: let the user pick one.
    if (!settings && !profile) {
      const profiles = runtime.listProfiles();
      if (profiles.length > 0) {
        profile = await selectProfile(profiles, options.loadedConfig.config.default.profile);
        settings = tryResolve(runtime, profile);
      }
    }

    if (!settings) {
      process.stderr.write('Provider and model are not configured. Run `marifold init` and `marifold model add` first.\n');
      process.exitCode = 1;
      return;
    }

    // Resolve `--resume` to a concrete session before launch. A bare flag picks
    // the most recent session for the resolved profile; an explicit id is looked
    // up directly so a typo starts fresh with a clear message instead of
    // silently creating an orphan session under the bad id. When a session is
    // found, its turns seed the transcript so the prior conversation is shown.
    let resumeSessionId: string | undefined;
    let resumeTranscript: TranscriptItemData[] | undefined;
    if (options.resume !== undefined) {
      const id = typeof options.resume === 'string'
        ? options.resume
        : runtime.listSessions(1, settings.profile, { order: 'recent' })[0]?.id;
      const detail = id ? runtime.getSession(id) : undefined;
      if (detail) {
        resumeSessionId = detail.id;
        resumeTranscript = detail.turns.map(turn => ({ kind: turn.role, text: turn.content }));
      } else if (typeof options.resume === 'string') {
        process.stderr.write(`Session not found: ${options.resume}. Starting a new session.\n`);
      } else {
        process.stderr.write(`No previous session for profile "${settings.profile}". Starting a new session.\n`);
      }
    }

    const initial = {
      profile: settings.profile,
      provider: settings.provider,
      model: settings.model,
      think: settings.think,
      mode: settings.mode,
      cwd: process.cwd(),
      version: readVersion(),
      maxContextTokens: settings.maxContextTokens ?? options.loadedConfig.config.default.maxContextTokens,
      ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
      ...(resumeTranscript ? { transcript: resumeTranscript } : {}),
    };
    // Render inline (like Claude Code / Codex), not in the alternate screen: the
    // banner and transcript live in the terminal's native scrollback, so the
    // conversation stays scrollable, copyable, and survives after exit — and the
    // CLI never takes over the whole terminal. Ink 7 clears its live region on
    // width-decrease (its `resized` handler), so the input area doesn't duplicate
    // on shrink; committed history is left to the terminal's own reflow.
    //
    // Enable bracketed paste so dropped/pasted file paths arrive as one buffered
    // event (Ink coalesces them) instead of fragmented keystrokes — otherwise a
    // long dropped path lands as loose text instead of an `[image #n]` token.
    process.stdout.write('\x1b[?2004h');
    try {
      const app = render(
        <App runtime={runtime} loadedConfig={options.loadedConfig} initial={initial} />,
        { exitOnCtrlC: false },
      );
      await app.waitUntilExit();
    } finally {
      process.stdout.write('\x1b[?2004l');
    }
  } finally {
    runtime.close();
  }
  // Force the process to exit. On a programmatic exit (`/exit`, double Ctrl+C),
  // Ink unmounts the React tree but leaves handles ref'd that keep the Node
  // event loop alive — confirmed via getActiveResourcesInfo() to be the stdin
  // TTY (Ink reads it in raw mode) plus a Timeout/Immediate from Ink's output
  // throttle and React's scheduler. None of those are ours to cancel, so without
  // this the CLI hangs instead of returning to the shell. Terminal teardown and
  // runtime.close() have already run above, so exiting here is safe.
  process.exit(process.exitCode ?? 0);
}

function tryResolve(runtime: MarifoldRuntime, profile?: string): MarifoldResolvedSettings | undefined {
  try {
    return runtime.resolveSettings(profile ? { profile } : {});
  } catch {
    return undefined;
  }
}

/** Render a one-shot Ink picker and resolve to the chosen profile name. */
function selectProfile(profiles: ProfileSummary[], defaultProfile: string): Promise<string> {
  return new Promise<string>(resolve => {
    let settled = false;
    const items = profiles.map(profile => ({
      label: profile.name === defaultProfile ? `${profile.name} (default)` : profile.name,
      value: profile.name,
    }));
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      instance.unmount();
      resolve(value);
    };
    const instance = render(
      <Box flexDirection="column">
        <Text color="cyan">Select a profile to launch:</Text>
        <SelectList title="Profiles" items={items} onSelect={finish} onCancel={() => finish(defaultProfile)} />
      </Box>,
      { exitOnCtrlC: false },
    );
  });
}
