import { parseToolArguments, ToolCall, ToolDefinition } from '@priest-ai/core';

/**
 * Prompt-based tool calling for models without native tool support, following
 * the same hidden-control-block pattern as <memory_save>. The model emits:
 *
 *   <tool_call name="read_file">{"path": "a.txt"}</tool_call>
 *
 * Blocks are stripped from visible text and results are replayed as plain
 * text, so this works with any chat-capable model.
 */
const TOOL_CALL_BLOCK = /<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/g;

export function buildControlBlockInstructions(tools: ToolDefinition[]): string {
  const lines = [
    'You can use tools. To call a tool, emit a control block on its own line:',
    '<tool_call name="TOOL_NAME">{"argument": "value"}</tool_call>',
    'The arguments must be a single JSON object matching the tool parameters.',
    'You may emit several tool_call blocks in one reply. After your tool calls, stop and wait — the results will arrive in the next message inside <tool_result> blocks.',
    'When you have everything you need, reply normally without any tool_call block.',
    '',
    'Available tools:',
  ];
  for (const tool of tools) {
    lines.push(`- ${tool.name}: ${tool.description ?? ''}`);
    lines.push(`  parameters: ${JSON.stringify(tool.parameters ?? {})}`);
  }
  return lines.join('\n');
}

export interface ParsedControlBlocks {
  visibleText: string;
  calls: ToolCall[];
}

export function parseControlBlockCalls(text: string): ParsedControlBlocks {
  const calls: ToolCall[] = [];
  const visibleText = text.replace(TOOL_CALL_BLOCK, (_match, name: string, rawArgs: string) => {
    calls.push({
      id: `call_${calls.length}`,
      name,
      arguments: parseToolArguments(rawArgs),
    });
    return '';
  }).trim();
  return { visibleText, calls };
}

export function formatControlBlockResult(call: ToolCall, content: string, isError?: boolean): string {
  const status = isError ? ' status="error"' : '';
  return `<tool_result name="${call.name}"${status}>\n${content}\n</tool_result>`;
}
