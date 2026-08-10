import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { capToolOutput, ToolExecutionResult } from './ToolRegistry';
import { isInside, RunWorkspace } from './RunWorkspace';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface ScopedProcessOptions {
  executable: string;
  args: string[];
  workspace: RunWorkspace;
  cwd?: string;
  readRoots?: string[];
  writeRoots?: string[];
  network?: boolean;
  timeoutMs?: number;
  outputLimit: number;
  signal?: AbortSignal;
  successSummary: string;
  failureSummary: string;
}

/**
 * Run a process inside the platform isolation backend. There is deliberately
 * no unrestricted fallback: a missing backend fails closed rather than
 * turning an "always allow" shell grant into host access.
 */
export async function runScopedProcess(options: ScopedProcessOptions): Promise<ToolExecutionResult> {
  const invocation = sandboxInvocation(options);
  if (!invocation) {
    return {
      content: [
        `No supported process sandbox is available on ${process.platform}.`,
        'Marifold did not run the command on the unrestricted host.',
        'macOS requires /usr/bin/sandbox-exec; other platforms currently require a future sandbox adapter.',
      ].join(' '),
      summary: options.failureSummary,
      isError: true,
    };
  }

  const env = scopedEnvironment(options.workspace);
  return new Promise<ToolExecutionResult>(resolve => {
    const child = execFile(invocation.executable, invocation.args, {
      cwd: options.cwd ?? options.workspace.cwd,
      env,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    }, (error, stdout, stderr) => {
      const parts: string[] = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      if (error) {
        const reason = error.killed
          ? `Command timed out after ${(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s.`
          : `Command exited with ${(error as { code?: number | string }).code ?? 'an error'}.`;
        parts.push(reason);
        resolve({
          content: capToolOutput(parts.join('\n'), options.outputLimit),
          summary: options.failureSummary,
          isError: true,
        });
        return;
      }
      resolve({
        content: capToolOutput(parts.join('\n') || '(no output)', options.outputLimit),
        summary: options.successSummary,
      });
    });
    options.signal?.addEventListener('abort', () => child.kill(), { once: true });
  });
}

export function findExecutable(name: string): string | undefined {
  const pathValue = process.env.PATH ?? '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Keep searching.
    }
  }
  return undefined;
}

export async function ensurePythonEnvironment(
  workspace: RunWorkspace,
  outputLimit: number,
  signal?: AbortSignal,
): Promise<ToolExecutionResult | undefined> {
  const python = pythonInVenv(workspace);
  if (fs.existsSync(python)) return undefined;
  const uv = findExecutable(process.platform === 'win32' ? 'uv.exe' : 'uv');
  if (!uv) {
    return {
      content: 'uv is required to create Marifold’s isolated Python environment, but it was not found on PATH.',
      summary: 'could not create isolated Python environment',
      isError: true,
    };
  }
  const result = await runScopedProcess({
    executable: uv,
    args: ['venv', workspace.venvDir],
    workspace,
    cwd: workspace.workDir,
    network: false,
    timeoutMs: 120_000,
    outputLimit,
    signal,
    successSummary: 'created isolated Python environment',
    failureSummary: 'could not create isolated Python environment',
  });
  return result.isError ? result : undefined;
}

export function pythonInVenv(workspace: RunWorkspace): string {
  return process.platform === 'win32'
    ? path.join(workspace.venvDir, 'Scripts', 'python.exe')
    : path.join(workspace.venvDir, 'bin', 'python');
}

function sandboxInvocation(options: ScopedProcessOptions): { executable: string; args: string[] } | undefined {
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) {
    return {
      executable: '/usr/bin/sandbox-exec',
      args: [
        '-p',
        macSandboxProfile(options.workspace, options.executable, options.network === true, {
          readRoots: options.readRoots,
          writeRoots: options.writeRoots,
        }),
        options.executable,
        ...options.args,
      ],
    };
  }
  return undefined;
}

/**
 * Seatbelt profile: leave the platform runtime readable, but hide user data
 * roots and make the whole host read-only except the explicit run capabilities.
 * Specific root allows override the broader home/Volumes denies.
 */
export function macSandboxProfile(
  workspace: RunWorkspace,
  executable: string,
  network: boolean,
  capabilities: { readRoots?: string[]; writeRoots?: string[] } = {},
): string {
  const executablePath = canonicalExisting(executable);
  const readRoots = uniqueCanonical([
    ...(capabilities.readRoots ?? workspace.readRoots),
    ...pathDirectories(workspace, capabilities.readRoots === undefined),
  ]);
  const writeRoots = uniqueCanonical(capabilities.writeRoots ?? workspace.writeRoots);
  const ancestorAllows = readRoots.map(
    root => `(allow file-read-metadata (path-ancestors ${schemeString(root)}))`,
  );
  const readAllows = readRoots.map(root => `(allow file-read* (subpath ${schemeString(root)}))`);
  const writeAllows = writeRoots.map(root => `(allow file-write* (subpath ${schemeString(root)}))`);
  return [
    '(version 1)',
    '(allow default)',
    ...(network ? [] : ['(deny network*)']),
    // Keep subprocesses functional, but do not let an approved shell control
    // unrelated host processes or automate desktop applications.
    '(deny signal)',
    '(allow signal (target self))',
    '(allow signal (target same-sandbox))',
    '(deny appleevent-send)',
    '(deny mach-lookup'
      + ' (global-name "com.apple.coreservices.appleevents")'
      + ' (global-name "com.apple.LaunchServices")'
      + ' (global-name "com.apple.lsd.modifydb")'
      + ' (global-name "com.apple.pasteboard")'
      + ' (global-name "com.apple.pasteboard.1")'
      + ' (global-name "com.apple.SecurityServer")'
      + ' (global-name "com.apple.securityd.xpc")'
      + ' (global-name "com.apple.securityd.general")'
      + ' (global-name "com.apple.securityd.systemkeychain"))',
    '(deny file-write*)',
    `(allow file-write* (literal ${schemeString('/dev/null')}))`,
    ...writeAllows,
    // The real account and external volumes are private unless a selected
    // workspace/trusted root below explicitly re-opens a subtree.
    `(deny file-read* (subpath ${schemeString(workspace.userHome)}))`,
    `(deny file-read* (subpath ${schemeString('/Users')}))`,
    `(deny file-read* (subpath ${schemeString('/Volumes')}))`,
    `(allow file-read* (literal ${schemeString(executablePath)}))`,
    ...ancestorAllows,
    ...readAllows,
  ].join('');
}

function scopedEnvironment(workspace: RunWorkspace): NodeJS.ProcessEnv {
  const venvBin = process.platform === 'win32'
    ? path.join(workspace.venvDir, 'Scripts')
    : path.join(workspace.venvDir, 'bin');
  return {
    // Preserve normal shell path semantics without exposing the account:
    // Seatbelt still denies the broad home and re-opens only explicit roots.
    HOME: workspace.userHome,
    USERPROFILE: workspace.userHome,
    TMPDIR: workspace.tempDir,
    TMP: workspace.tempDir,
    TEMP: workspace.tempDir,
    XDG_CACHE_HOME: workspace.cacheDir,
    XDG_CONFIG_HOME: path.join(workspace.homeDir, '.config'),
    UV_CACHE_DIR: path.join(workspace.cacheDir, 'uv'),
    UV_NO_CONFIG: '1',
    VIRTUAL_ENV: workspace.venvDir,
    PATH: [venvBin, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL ?? '',
    TERM: process.env.TERM ?? 'dumb',
    MARIFOLD_RUN_DIR: workspace.rootDir,
    MARIFOLD_RUN_HOME: workspace.homeDir,
    MARIFOLD_INPUT_DIR: workspace.inputDir,
    MARIFOLD_OUTPUT_DIR: workspace.outputDir,
    MARIFOLD_WORK_DIR: workspace.workDir,
    MARIFOLD_WORKSPACE: workspace.cwd,
  };
}

function pathDirectories(workspace: RunWorkspace, includeUserDirectories: boolean): string[] {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map(canonicalExisting)
    .filter(directory => {
      try {
        if (!fs.statSync(directory).isDirectory()) return false;
        if (!includeUserDirectories && isInside(directory, workspace.userHome)) return false;
        // A malformed PATH must not accidentally reopen the entire account or
        // Marifold state after the broad home deny.
        if (directory === workspace.userHome || isInside(workspace.userHome, directory)) return false;
        const appHome = path.join(workspace.userHome, '.marifold');
        if (directory === appHome || isInside(appHome, directory)) {
          return isInside(directory, workspace.rootDir);
        }
        return true;
      } catch {
        return false;
      }
    });
}

function uniqueCanonical(values: string[]): string[] {
  return [...new Set(values.map(canonicalExisting))];
}

function canonicalExisting(value: string): string {
  try {
    return fs.realpathSync(path.resolve(value));
  } catch {
    return path.resolve(value);
  }
}

function schemeString(value: string): string {
  return JSON.stringify(value);
}
