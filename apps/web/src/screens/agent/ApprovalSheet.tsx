import { useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, RunApprovalAction, SudoResponse, ToolKind } from '../../api/types';
import { encryptSudoPassword } from '../../lib/sudoCredentials';
import styles from './ApprovalSheet.module.css';

const KIND_ACTION_LABEL: Record<ToolKind, string> = {
  read: 'file reads',
  write: 'file writes',
  shell: 'shell commands',
  network: 'network access',
  delegate: 'profile delegation',
};

export interface ApprovalSheetProps {
  request: ApprovalRequest;
  busy?: boolean;
  onAnswer: (action: RunApprovalAction, sudoResponse?: SudoResponse) => void;
}

/**
 * The trust surface (design 1a/1b): the run is paused on this decision.
 * Allow once is the safe default (⌘⏎/Ctrl⏎); the middle button persists —
 * "Trust this folder" for an escalated file write, else "Always allow <kind>".
 */
export function ApprovalSheet({ request, busy, onAnswer }: ApprovalSheetProps) {
  const password = useRef<HTMLInputElement>(null);
  const [encrypting, setEncrypting] = useState(false);
  const [error, setError] = useState('');
  const activeRequest = useRef(request.id);
  activeRequest.current = request.id;
  useEffect(() => {
    activeRequest.current = request.id;
    if (password.current) { password.current.value = ''; }
    setError('');
    return () => { activeRequest.current = ''; if (password.current) { password.current.value = ''; } };
  }, [request.id]);
  async function answer(action: RunApprovalAction): Promise<void> {
    if (busy || encrypting) { return; }
    if (!request.sudo || action === 'deny') {
      if (password.current) { password.current.value = ''; }
      onAnswer(action);
      return;
    }
    if (action !== 'once') { return; }
    setEncrypting(true);
    setError('');
    try {
      const pending = encryptSudoPassword(request.sudo, password.current?.value ?? '');
      if (password.current) { password.current.value = ''; }
      const encrypted = await pending;
      if (activeRequest.current === request.id) { onAnswer('once', encrypted); }
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not encrypt authorization.'); }
    finally { setEncrypting(false); }
  }
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !busy) {
        event.preventDefault();
        void answer('once');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, encrypting, onAnswer, request]);

  const canPersist = !request.sudo && request.persistable !== false;
  const trustFolder = canPersist && request.escalatedPath !== undefined;

  return (
    <div className={styles.sheet} role="alertdialog" aria-label="Approval required">
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden>
          ⚙
        </span>
        <div className={styles.text}>
          <div className={styles.title}>The agent wants to {verbFor(request.kind)}</div>
          <div className={styles.summary}>{request.summary}</div>
          {request.escalatedPath ? <code className={styles.path}>{request.escalatedPath}</code> : null}
          <div className={styles.meta}>
            {request.tool} · {request.kind}
            {request.escalationReason ? ` — ${request.escalationReason}` : ''}
          </div>
        </div>
      </div>
      {request.sudo ? (
        <div className={styles.text}>
          <label>
            Administrator password for {request.sudo.account} on {request.sudo.device}
            {/* Chrome ignores autocomplete=off on password fields. This is a
                per-action secret, not a website login to save or autofill. */}
            <input className={styles.password} ref={password} type="password" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false}
              aria-label={`Password for ${request.sudo.account} on ${request.sudo.device}`} disabled={busy || encrypting} />
          </label>
          <div className={styles.meta}>Encrypted for this device and command only. Not saved by Marifold or sent to the AI. Expires in five minutes.</div>
          {error ? <div role="alert">{error}</div> : null}
        </div>
      ) : null}
      <div className={styles.actions}>
        <button className={styles.deny} disabled={busy || encrypting} onClick={() => void answer('deny')}>
          Deny
        </button>
        {canPersist ? (
          <button
            className={styles.persist}
            disabled={busy}
            onClick={() => onAnswer(trustFolder ? 'trust' : 'always')}
          >
            {trustFolder ? 'Trust this folder' : `Always allow ${KIND_ACTION_LABEL[request.kind]}`}
          </button>
        ) : null}
        <button className={styles.allow} disabled={busy || encrypting} onClick={() => void answer('once')}>
          {request.sudo ? 'Authorize sudo once' : 'Allow once'} <span className={styles.kbd}>⌘⏎</span>
        </button>
      </div>
    </div>
  );
}

function verbFor(kind: ToolKind): string {
  switch (kind) {
    case 'read':
      return 'read a file';
    case 'write':
      return 'write a file';
    case 'shell':
      return 'run a command';
    case 'network':
      return 'use the network';
    case 'delegate':
      return 'ask another profile';
  }
}
