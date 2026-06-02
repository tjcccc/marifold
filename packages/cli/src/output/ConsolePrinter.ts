import {
  MarifoldAskResponse,
  MarifoldError,
  ProfileSummary,
  SessionSummary,
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

    for (const session of sessions) {
      process.stdout.write(
        `${session.id}\t${session.profileName}\t${session.turnCount} turns\t${session.updatedAt}\n`,
      );
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
