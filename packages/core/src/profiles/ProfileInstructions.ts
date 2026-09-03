import * as fs from 'fs';
import * as path from 'path';

export const PROFILE_INSTRUCTIONS_FILE = 'INSTRUCTIONS.md';

export const DEFAULT_MARIFOLD_PROFILE_INSTRUCTIONS = `# Marifold

You are Marifold, a local-first personal AI workspace assistant.

## Guidelines

- Answer clearly and practically.
- Do not claim unsupported capabilities.
`;

export const LEGACY_PROFILE_INSTRUCTION_FILES = [
  'PROFILE.md',
  'RULES.md',
  'CUSTOM.md',
] as const;

/** Priest currently assembles legacy profile content as rules, identity, then
 * custom. Preserve that order when presenting or migrating one document. */
const LEGACY_PROFILE_INSTRUCTION_ORDER = [
  'RULES.md',
  'PROFILE.md',
  'CUSTOM.md',
] as const;

export type DirectoryProfileInstructionsFormat = 'unified' | 'legacy' | 'missing';

export interface ResolvedDirectoryProfileInstructions {
  content: string;
  format: DirectoryProfileInstructionsFormat;
  path: string;
  legacyFiles: string[];
}

/** Resolve the canonical instructions without mutating the profile. An
 * existing INSTRUCTIONS.md is authoritative even when intentionally empty. */
export function resolveDirectoryProfileInstructions(
  profileDir: string,
): ResolvedDirectoryProfileInstructions {
  const instructionsPath = path.join(profileDir, PROFILE_INSTRUCTIONS_FILE);
  const legacyFiles = LEGACY_PROFILE_INSTRUCTION_FILES.filter(fileName => (
    fs.existsSync(path.join(profileDir, fileName))
  ));

  if (fs.existsSync(instructionsPath)) {
    return {
      content: fs.readFileSync(instructionsPath, 'utf-8'),
      format: 'unified',
      path: instructionsPath,
      legacyFiles: [...legacyFiles],
    };
  }

  if (legacyFiles.length > 0) {
    const content = combineInstructionParts(LEGACY_PROFILE_INSTRUCTION_ORDER.map(fileName => {
      const filePath = path.join(profileDir, fileName);
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    }));
    return {
      content,
      format: 'legacy',
      path: instructionsPath,
      legacyFiles: [...legacyFiles],
    };
  }

  return {
    content: '',
    format: 'missing',
    path: instructionsPath,
    legacyFiles: [],
  };
}

export function combineInstructionParts(parts: ReadonlyArray<string | undefined>): string {
  return parts
    .map(part => part?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
}
