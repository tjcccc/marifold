import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import * as os from 'os';
import * as path from 'path';
import { Box, Text, useInput } from 'ink';
import { approvalSensitiveGrant, approvalTrustFolder, encryptSudoPassword, type ApprovalRequest, type PriestJSONValue, type SudoResponse } from '@marifold/core';
import { ACCENT, ATTACHMENT, DIM } from './theme.js';

/** The folder a "trust" action would add, for an escalated file call. */
export function trustTargetFolder(request: ApprovalRequest): string | undefined {
  return approvalTrustFolder(request);
}

/** Whether `[t]` applies: trusting a folder, allowing a sensitive read root,
 * or allowing an ordinary call's kind. Any other escalated path offers none:
 * "allow always" would not cover it. */
export function canAlwaysAllow(request: ApprovalRequest): boolean {
  return request.persistable !== false
    && (trustTargetFolder(request) !== undefined || approvalSensitiveGrant(request) !== undefined || !request.escalatedPath);
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
        if (body.length > PREVIEW_MAX_BODY_LINES) { lines.push('  …'); }
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
export type ApprovalChoice = 'once' | 'run' | 'always' | 'no';

export function ApprovalModal({
  request,
  onResolve,
}: {
  request: ApprovalRequest;
  onResolve: (choice: ApprovalChoice, sudoResponse?: SudoResponse) => void;
}): React.ReactElement {
  const password = useRef('');
  const [length, setLength] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    password.current = '';
    setLength(0);
    setError('');
    return () => { password.current = ''; };
  }, [request.id]);
  useInput((input, key) => {
    if (request.sudo) {
      if (key.escape || (key.ctrl && input === 'c')) { password.current = ''; onResolve('no'); return; }
      if (key.return) {
        try {
          const response = encryptSudoPassword(request.sudo, password.current);
          password.current = '';
          setLength(0);
          onResolve('once', response);
        } catch (error) { password.current = ''; setLength(0); setError(error instanceof Error ? error.message : 'Authorization failed.'); }
        return;
      }
      if (key.backspace || key.delete) { password.current = [...password.current].slice(0, -1).join(''); }
      else if (!key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input)) { password.current += input; }
      setLength(password.current.length);
      return;
    }
    const ch = input.toLowerCase();
    // Enter = allow once (safe default) — never persists/trusts on a stray keypress.
    if (key.escape || ch === 'd') { onResolve('no'); }
    else if (key.return || ch === 'a' || ch === 'y') { onResolve('once'); }
    else if (ch === 't' && canAlwaysAllow(request)) { onResolve('always'); }
    else if (ch === 'r' && request.runGrant) { onResolve('run'); }
  });

  // The "always" action: trust this folder (escalated write), allow reading
  // a sensitive root, else allow this kind.
  const trustFolder = trustTargetFolder(request);
  const sensitiveGrant = approvalSensitiveGrant(request);
  const alwaysLabel = trustFolder
    ? `rust (${tildify(trustFolder)}) and allow always`
    : sensitiveGrant ? `rust: always allow reading ${sensitiveGrant}`
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
        {request.sudo ? <Text>Target: {request.sudo.account}@{request.sudo.device}{'\n'}Password: {'•'.repeat(Math.min(length, 64))}{'\n'}Enter authorizes once · Esc cancels. Not saved or sent to the AI.{error ? `\n${error}` : ''}</Text> :
        <Text>
          <Text color={ATTACHMENT} bold>[a]</Text><Text color={DIM}>llow once</Text>
          {request.runGrant ? (
            <>
              <Text color={DIM}> · </Text>
              <Text color={ACCENT} bold>[r]</Text><Text color={DIM}>{`un: allow ${tildify(request.runGrant.folder)} until this task ends`}</Text>
            </>
          ) : null}
          {canAlwaysAllow(request) ? (
            <>
              <Text color={DIM}> · </Text>
              <Text color={ACCENT} bold>[t]</Text><Text color={DIM}>{alwaysLabel}</Text>
            </>
          ) : null}
          <Text color={DIM}> · </Text>
          <Text color="red" bold>[d]</Text><Text color={DIM}>eny (this time)</Text>
        </Text>}
      </Box>
    </Box>
  );
}
