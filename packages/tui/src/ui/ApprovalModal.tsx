import React from 'react';
import * as os from 'os';
import * as path from 'path';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest, PriestJSONValue } from '@marifold/core';
import { ACCENT, ATTACHMENT, DIM } from './theme.js';

/** The folder a "trust" action would add, for an escalated file write. */
export function trustTargetFolder(request: ApprovalRequest): string | undefined {
  return request.persistable !== false && request.escalated && request.escalatedPath
    ? path.dirname(request.escalatedPath)
    : undefined;
}

function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p;
}

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
 * ApprovalDecision plus the "Always" side effect (persist allow / trust folder). */
export type ApprovalChoice = 'once' | 'always' | 'no';

export function ApprovalModal({
  request,
  onResolve,
}: {
  request: ApprovalRequest;
  onResolve: (choice: ApprovalChoice) => void;
}): React.ReactElement {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    // Enter = allow once (safe default) — never persists/trusts on a stray keypress.
    if (key.escape || ch === 'd') onResolve('no');
    else if (key.return || ch === 'a' || ch === 'y') onResolve('once');
    else if (ch === 't' && request.persistable !== false) onResolve('always');
  });

  // The "always" action: trust this folder (escalated write), else allow this kind.
  const trustFolder = trustTargetFolder(request);
  const alwaysLabel = trustFolder
    ? `rust (${tildify(trustFolder)}) and allow always`
    : `rust ${request.kind} (allow always)`;

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
          {request.persistable !== false ? (
            <>
              <Text color={DIM}> · </Text>
              <Text color={ACCENT} bold>[t]</Text><Text color={DIM}>{alwaysLabel}</Text>
            </>
          ) : null}
          <Text color={DIM}> · </Text>
          <Text color="red" bold>[d]</Text><Text color={DIM}>eny (this time)</Text>
        </Text>
      </Box>
    </Box>
  );
}
