import { JSONValue } from '@priest-ai/core';
import {
  ensurePythonEnvironment,
  findExecutable,
  pythonInVenv,
  runScopedProcess,
} from '../ScopedProcess';
import {
  AgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRiskAssessment,
} from '../ToolRegistry';

const MAX_PACKAGES_PER_CALL = 20;
// Registry requirement with optional extras/version markers. Deliberately
// excludes flags, filesystem paths, URLs, Git sources, and editable installs.
const SAFE_REQUIREMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._,-]+\])?(?:\s*(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9*+!._-]+)?$/;

export class PythonPackageTool implements AgentTool {
  readonly kind = 'network' as const;
  readonly definition = {
    name: 'python_package_install',
    description: [
      'Install Python registry packages into this run’s disposable uv environment.',
      'Use this instead of pip/uv inside shell_exec. URLs, Git sources, paths, flags, and global installs are refused.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: 'PyPI requirement names, preferably version-pinned (for example openpyxl==3.1.5).',
        },
      },
      required: ['packages'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    const packages = packageInputs(input);
    return `install ${packages.length > 0 ? packages.join(', ') : '<missing packages>'} into this run’s Python environment`;
  }

  assessRisk(_input: Record<string, JSONValue>, _ctx: ToolExecutionContext): ToolRiskAssessment {
    return {
      escalate: true,
      persistable: false,
      reason: 'package installation downloads and executes third-party code for this run',
    };
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const packages = packageInputs(input);
    const invalid = packages.find(pkg => !SAFE_REQUIREMENT.test(pkg));
    if (packages.length === 0 || packages.length > MAX_PACKAGES_PER_CALL || invalid) {
      return {
        content: invalid
          ? `Refused unsafe Python requirement '${invalid}'. Use a registry package name with an optional version constraint.`
          : `Provide between 1 and ${MAX_PACKAGES_PER_CALL} Python package requirements.`,
        summary: 'refused Python package installation',
        isError: true,
      };
    }
    if (!ctx.workspace) {
      return {
        content: 'Marifold refused package installation without an isolated run workspace.',
        summary: 'blocked Python package installation',
        isError: true,
      };
    }
    const environmentError = await ensurePythonEnvironment(ctx.workspace, ctx.outputLimit, ctx.signal);
    if (environmentError) return environmentError;
    const uv = findExecutable(process.platform === 'win32' ? 'uv.exe' : 'uv');
    if (!uv) {
      return {
        content: 'uv is required for isolated package installation, but it was not found on PATH.',
        summary: 'could not install Python packages',
        isError: true,
      };
    }
    const installerRoots = [
      ctx.workspace.workDir,
      ctx.workspace.homeDir,
      ctx.workspace.tempDir,
      ctx.workspace.cacheDir,
      ctx.workspace.venvDir,
    ];
    return runScopedProcess({
      executable: uv,
      args: ['pip', 'install', '--python', pythonInVenv(ctx.workspace), ...packages],
      workspace: ctx.workspace,
      cwd: ctx.workspace.workDir,
      // Package build hooks are untrusted third-party code. While network is
      // enabled they may only see the disposable environment, never attached
      // files, the selected repository, or trusted host folders.
      readRoots: installerRoots,
      writeRoots: installerRoots,
      network: true,
      timeoutMs: 180_000,
      outputLimit: ctx.outputLimit,
      signal: ctx.signal,
      successSummary: `installed ${packages.join(', ')} into this run’s Python environment`,
      failureSummary: `could not install ${packages.join(', ')}`,
    });
  }
}

function packageInputs(input: Record<string, JSONValue>): string[] {
  const value = input.packages;
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => typeof item === 'string' && item.trim() ? [item.trim()] : []);
}
