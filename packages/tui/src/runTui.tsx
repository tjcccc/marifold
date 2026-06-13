import { Box, render, Text } from 'ink';
import { MarifoldRuntime } from '@marifold/core';
import type { LoadedMarifoldConfig, MarifoldResolvedSettings, ProfileSummary } from '@marifold/core';
import { App } from './ui/App.js';
import { SelectList } from './ui/SelectList.js';

export interface RunTuiOptions {
  loadedConfig: LoadedMarifoldConfig;
  /** Profile to launch with; defaults to the configured default profile. */
  profile?: string;
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

    const initial = {
      profile: settings.profile,
      provider: settings.provider,
      model: settings.model,
      think: settings.think,
      cwd: process.cwd(),
    };
    const app = render(
      <App runtime={runtime} loadedConfig={options.loadedConfig} initial={initial} />,
      { exitOnCtrlC: false },
    );
    await app.waitUntilExit();
  } finally {
    runtime.close();
  }
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
