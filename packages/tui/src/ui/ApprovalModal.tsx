import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest, PriestJSONValue } from '@marifold/core';
import { ACCENT, ATTACHMENT, DIM } from './theme.js';

const PREVIEW_MAX_LINES = 12;
const PREVIEW_MAX_BODY_LINES = 8;
const PREVIEW_MAX_LINE_CHARS = 120;

/** A compact, dim preview of the tool's arguments so the user approves with
 * sight of the actual content (file body, shell command) — not just the kind. */
function previewLines(input: Record<string, PriestJSONValue>): string[] {
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(input)) {
    if (typeof raw === 'string') {
      if (raw.includes('\n') || raw.length > 60) {
        const body = raw.split('\n');
        lines.push(`${key}:`);
        for (const line of body.slice(0, PREVIEW_MAX_BODY_LINES)) {
          lines.push(`  ${line.length > PREVIEW_MAX_LINE_CHARS ? `${line.slice(0, PREVIEW_MAX_LINE_CHARS)}…` : line}`);
        }
        if (body.length > PREVIEW_MAX_BODY_LINES) lines.push('  …');
      } else {
        lines.push(`${key}: ${raw}`);
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(raw)}`);
    }
  }
  return lines.slice(0, PREVIEW_MAX_LINES);
}

/** What the user chose in the approval modal. The App maps this to an
 * ApprovalDecision plus any session-grant or config-persist side effect. */
export type ApprovalChoice = 'once' | 'session' | 'persist' | 'deny';

export function ApprovalModal({
  request,
  onResolve,
}: {
  request: ApprovalRequest;
  onResolve: (choice: ApprovalChoice) => void;
}): React.ReactElement {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (key.escape || ch === 'n' || ch === 'd') onResolve('deny');
    else if (key.return || ch === 'a' || ch === 'y') onResolve('once');
    else if (ch === 's') onResolve('session');
    else if (ch === 'p') onResolve('persist');
  });

  return (
    <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
      <Text bold color="yellow">Approve {request.kind} action?</Text>
      <Text>{request.summary}</Text>
      {request.escalated && request.escalationReason ? (
        <Text color="red">! {request.escalationReason}</Text>
      ) : null}
      {previewLines(request.input).length > 0 ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={1} borderStyle="single" borderColor="gray">
          {previewLines(request.input).map((line, i) => (
            <Text key={i} dimColor>{line}</Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text>
          <Text color={ATTACHMENT} bold>[a]</Text><Text color={DIM}>llow once</Text>
          <Text color={DIM}> · </Text>
          <Text color={ACCENT} bold>[s]</Text><Text color={DIM}>ession {request.kind}</Text>
          <Text color={DIM}> · </Text>
          <Text color={ACCENT} bold>[p]</Text><Text color={DIM}>ersist {request.kind}</Text>
          <Text color={DIM}> · </Text>
          <Text color="red" bold>[d]</Text><Text color={DIM}>eny</Text>
        </Text>
      </Box>
      {request.escalated ? (
        <Text dimColor>(escalated calls always prompt — session/persist apply to future non-escalated {request.kind} calls)</Text>
      ) : null}
    </Box>
  );
}
