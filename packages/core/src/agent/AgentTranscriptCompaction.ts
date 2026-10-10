import type { ToolExchangeTurn } from '@priest-ai/core';

/** Total characters of tool exchange kept in model context; older tool
 * results beyond it are replaced with a short "compacted" marker. */
const MODEL_TOOL_EXCHANGE_MAX_CHARS = 64_000;

export function compactNativeToolExchange(exchange: ToolExchangeTurn[]): void {
  let total = exchange.reduce((sum, turn) => (
    sum + (turn.kind === 'tool_result' ? turn.content.length : (turn.text?.length ?? 0))
  ), 0);
  if (total <= MODEL_TOOL_EXCHANGE_MAX_CHARS) { return; }

  for (let index = 0; index < exchange.length && total > MODEL_TOOL_EXCHANGE_MAX_CHARS; index += 1) {
    const turn = exchange[index];
    if (turn.kind !== 'tool_result' || turn.content.startsWith('[Earlier tool result compacted')) { continue; }
    const replacement = `[Earlier tool result compacted: ${turn.name}; ${turn.content.length.toLocaleString('en-US')} characters omitted. Re-run a bounded read or search if the details are still needed.]`;
    total -= turn.content.length - replacement.length;
    exchange[index] = { ...turn, content: replacement };
  }
}

export function compactControlBlockTranscript(transcript: string[]): void {
  let total = transcript.reduce((sum, turn) => sum + turn.length, 0);
  if (total <= MODEL_TOOL_EXCHANGE_MAX_CHARS) { return; }
  for (let index = 0; index < transcript.length - 1 && total > MODEL_TOOL_EXCHANGE_MAX_CHARS; index += 1) {
    const turn = transcript[index];
    if (turn.startsWith('[Earlier control-block turn compacted')) { continue; }
    const replacement = `[Earlier control-block turn compacted; ${turn.length.toLocaleString('en-US')} characters omitted.]`;
    total -= turn.length - replacement.length;
    transcript[index] = replacement;
  }
}
