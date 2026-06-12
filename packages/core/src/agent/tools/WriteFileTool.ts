import * as fs from 'fs';
import * as path from 'path';
import { JSONValue } from '@priest-ai/core';
import { expandHome } from '../../workspace/WorkspacePaths';
import { AgentTool, requireStringInput, ToolExecutionContext, ToolExecutionResult, ToolRiskAssessment } from '../ToolRegistry';
import { formatBytes } from './ReadFileTool';

export class WriteFileTool implements AgentTool {
  readonly kind = 'write' as const;
  readonly definition = {
    name: 'write_file',
    description: 'Write text content to a local file, creating parent directories as needed. Overwrites existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the working directory.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
    },
  };

  summarizeCall(input: Record<string, JSONValue>): string {
    const target = typeof input.path === 'string' ? input.path : '<missing path>';
    const size = typeof input.content === 'string' ? formatBytes(Buffer.byteLength(input.content, 'utf-8')) : '?';
    return `write ${size} to ${target}`;
  }

  assessRisk(input: Record<string, JSONValue>, ctx: ToolExecutionContext): ToolRiskAssessment {
    if (typeof input.path !== 'string') return { escalate: false };
    const target = path.resolve(ctx.cwd, expandHome(input.path));
    if (!isInsideWorkspace(target, ctx.cwd)) {
      return { escalate: true, reason: `target ${target} is outside the working directory ${ctx.cwd}` };
    }
    return { escalate: false };
  }

  async execute(input: Record<string, JSONValue>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const target = path.resolve(ctx.cwd, expandHome(requireStringInput(input, 'path', 'write_file')));
    const content = typeof input.content === 'string' ? input.content : '';
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    } catch (error) {
      return {
        content: `Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`,
        summary: `failed to write ${target}`,
        isError: true,
      };
    }
    const size = formatBytes(Buffer.byteLength(content, 'utf-8'));
    return {
      content: `Wrote ${size} to ${target}.`,
      summary: `wrote ${size} to ${target}`,
    };
  }
}

export function isInsideWorkspace(target: string, cwd: string): boolean {
  const relative = path.relative(path.resolve(cwd), target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
