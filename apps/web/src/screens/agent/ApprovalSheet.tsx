import { useEffect } from 'react';
import type { ApprovalRequest, RunApprovalAction, ToolKind } from '../../api/types';
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
  onAnswer: (action: RunApprovalAction) => void;
}

/**
 * The trust surface (design 1a/1b): the run is paused on this decision.
 * Allow once is the safe default (⌘⏎/Ctrl⏎); the middle button persists —
 * "Trust this folder" for an escalated file write, else "Always allow <kind>".
 */
export function ApprovalSheet({ request, busy, onAnswer }: ApprovalSheetProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !busy) {
        event.preventDefault();
        onAnswer('once');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onAnswer]);

  const canPersist = request.persistable !== false;
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
      <div className={styles.actions}>
        <button className={styles.deny} disabled={busy} onClick={() => onAnswer('deny')}>
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
        <button className={styles.allow} disabled={busy} onClick={() => onAnswer('once')}>
          Allow once <span className={styles.kbd}>⌘⏎</span>
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
