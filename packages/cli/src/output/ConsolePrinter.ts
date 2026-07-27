import {
  MarifoldAskResponse,
  MarifoldError,
  ProfileSummary,
  SessionSummary,
  WorkspaceInitResult,
} from '@marifold/core';

export class ConsolePrinter {
  printAskResponse(response: MarifoldAskResponse): void {
    if (response.ok) {
      process.stdout.write(response.text);
      if (!response.text.endsWith('\n')) process.stdout.write('\n');
      process.stderr.write(
        `(${response.latencyMs ?? 0}ms · ${response.settings.provider}/${response.settings.model} · ${response.settings.profile})\n`,
      );
      return;
    }

    const message = response.error?.message ?? 'Unknown provider error.';
    process.stderr.write(`Error: ${message}\n`);
  }

  printProfiles(profiles: ProfileSummary[]): void {
    if (profiles.length === 0) {
      process.stdout.write('No profiles found.\n');
      return;
    }

    for (const profile of profiles) {
      const suffix = profile.source === 'built-in' ? ' (built-in)' : '';
      process.stdout.write(`${profile.name}${suffix}\n`);
    }
  }

  printSessions(sessions: SessionSummary[]): void {
    if (sessions.length === 0) {
      process.stdout.write('No sessions found.\n');
      return;
    }

    process.stdout.write('ID\tProfile\tTurns\tUpdated\n');
    for (const session of sessions) {
      process.stdout.write(
        `${session.id}\t${session.profileName}\t${session.turnCount}\t${session.updatedAt}\n`,
      );
    }
  }

  printInitResult(result: WorkspaceInitResult, options: { showModel?: boolean; showNextSteps?: boolean } = {}): void {
    const { showModel = true, showNextSteps = true } = options;
    process.stdout.write(`Initialized Marifold at ${result.configPath}\n`);
    // The model line is suppressed during interactive init, where the chosen
    // model is printed after the picker instead of the bootstrap placeholder.
    if (showModel) process.stdout.write(`Provider: ${result.provider}/${result.model} (${result.providerType})\n`);
    process.stdout.write(`Profile:  ${result.profile}\n`);
    process.stdout.write(`Profiles: ${result.profilesDir}\n`);
    process.stdout.write(`Sessions: ${result.sessionsDb}\n`);
    process.stdout.write(`Tasks:    ${result.tasksDir}\n`);
    process.stdout.write(`Apps:     ${result.appsDir}\n\n`);

    for (const file of result.files) {
      process.stdout.write(`${file.status.padEnd(7)} ${file.path}\n`);
    }

    if (showNextSteps) {
      process.stdout.write('\nRun `marifold` to start.\n');
    }
  }

  printError(error: unknown): void {
    if (error instanceof MarifoldError) {
      process.stderr.write(`Error: ${error.message}\n`);
      return;
    }
    if (error instanceof Error) {
      process.stderr.write(`Error: ${error.message}\n`);
      return;
    }
    process.stderr.write(`Error: ${String(error)}\n`);
  }
}
