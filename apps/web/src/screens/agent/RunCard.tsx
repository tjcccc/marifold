import { useEffect, useState } from 'react';
import type { RunApprovalAction } from '../../api/types';
import { formatDuration, formatElapsed, formatTokens } from '../../lib/format';
import type { RunCardState } from '../../state/thread';
import { ApprovalSheet } from './ApprovalSheet';
import styles from './RunCard.module.css';

export interface RunCardProps {
  run: RunCardState;
  onCancel: () => void;
  onAnswer: (requestId: string, action: RunApprovalAction) => void;
  onToggle: () => void;
}

/** A live agent run inline in the thread (design "THE RUN" + 1b edge states):
 * status line with elapsed + Cancel, plan checklist, folding tool rows,
 * steering pills, the approval sheet, and the collapsed ✓ footer. */
export function RunCard({ run, onCancel, onAnswer, onToggle }: RunCardProps) {
  const running = run.status === 'running';
  const showDetails = running || !run.collapsed;

  return (
    <div className={running ? styles.cardRunning : styles.card}>
      {running ? (
        <div className={styles.statusLine}>
          <span className={styles.spinner} aria-hidden />
          <span className={styles.statusText}>
            {run.approval ? 'Waiting for your approval' : `Working — ${activity(run)}`}
          </span>
          <Elapsed startedAt={run.startedAt} />
          <button className={styles.cancel} onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <button className={styles.footerLine} onClick={onToggle}>
          <span className={statusGlyphClass(run)}>{statusGlyph(run)}</span>
          <span className={styles.footerText}>{footerText(run)}</span>
          <span className={styles.footerToggle}>{run.collapsed ? 'Show ⌄' : 'Hide ⌃'}</span>
        </button>
      )}

      {showDetails ? (
        <div className={styles.details}>
          {run.plan && run.plan.length > 0 ? (
            <ul className={styles.plan}>
              {run.plan.map(step => (
                <li key={step.id} className={styles.planStep}>
                  <span className={step.status === 'completed' ? styles.stepDone : styles.stepPending} aria-hidden>
                    {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '›' : '○'}
                  </span>
                  {step.text}
                </li>
              ))}
            </ul>
          ) : null}

          {run.rows.length > 0 ? (
            <div className={styles.rows}>
              {run.rows.map(row => (
                <div key={row.callId} className={styles.toolRow}>
                  <span
                    className={row.isError ? styles.rowError : row.phase === 'done' ? styles.rowDone : styles.rowRunning}
                    aria-hidden
                  >
                    {row.isError ? '✕' : row.phase === 'done' ? '✓' : '→'}
                  </span>
                  <span className={styles.rowTool}>{row.tool}</span>
                  <span className={styles.rowSummary}>{row.summary}</span>
                </div>
              ))}
            </div>
          ) : null}

          {run.steering.map((text, index) => (
            <div key={index} className={styles.steeringPill}>
              Guidance applied — “{text}”
            </div>
          ))}

          {run.denials.map((reason, index) => (
            <div key={index} className={styles.denial}>
              Denied: {reason}
            </div>
          ))}

          {run.errors.map((error, index) => (
            <div key={index} className={styles.error}>
              {error.code}: {error.message}
            </div>
          ))}
        </div>
      ) : null}

      {run.approval ? (
        <ApprovalSheet
          request={run.approval}
          busy={run.approvalBusy}
          onAnswer={action => onAnswer(run.approval!.id, action)}
        />
      ) : null}

      {!running && !run.collapsed && run.usage ? (
        <div className={styles.usage}>
          {durationText(run)}
          {run.usage.totalTokens !== undefined ? ` · ${formatTokens(run.usage.totalTokens)} tokens` : ''}
          {run.usage.estimatedCostUSD !== undefined ? ` · $${run.usage.estimatedCostUSD.toFixed(3)}` : ''}
        </div>
      ) : null}
    </div>
  );
}

function Elapsed({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const started = Date.parse(startedAt);
  return <span className={styles.elapsed}>{Number.isFinite(started) ? formatElapsed(now - started) : ''}</span>;
}

function activity(run: RunCardState): string {
  const runningRow = run.rows.findLast(row => row.phase === 'running');
  if (runningRow) return runningRow.summary;
  const step = run.plan?.find(item => item.status === 'in_progress');
  if (step) return step.text.toLowerCase();
  const lastRow = run.rows.at(-1);
  if (lastRow) return lastRow.summary;
  return 'thinking…';
}

function statusGlyph(run: RunCardState): string {
  switch (run.status) {
    case 'completed':
      return '✓';
    case 'cancelled':
      return '◼';
    case 'failed':
      return '✕';
    case 'blocked':
      return '◔';
    default:
      return '·';
  }
}

function statusGlyphClass(run: RunCardState): string {
  switch (run.status) {
    case 'completed':
      return styles.glyphOk;
    case 'failed':
      return styles.glyphError;
    default:
      return styles.glyphNeutral;
  }
}

function footerText(run: RunCardState): string {
  const toolCount = run.rows.length;
  const tools = toolCount > 0 ? ` · ${toolCount} tool ${toolCount === 1 ? 'action' : 'actions'}` : '';
  switch (run.status) {
    case 'completed':
      return `Ran ${durationText(run)}${tools}`;
    case 'cancelled':
      return `Cancelled after ${durationText(run)}${tools}`;
    case 'failed':
      return `Failed after ${durationText(run)}${tools}`;
    case 'blocked':
      return `Blocked${run.summary ? ` — ${run.summary}` : ''}${tools}`;
    default:
      return run.status;
  }
}

function durationText(run: RunCardState): string {
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  return formatDuration(end - start);
}
