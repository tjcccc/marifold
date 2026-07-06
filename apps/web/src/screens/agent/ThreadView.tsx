import { useEffect, useRef } from 'react';
import { Markdown } from '../../components/Markdown';
import type { RunApprovalAction } from '../../api/types';
import { formatCostUSD, formatRunDuration, formatTokens } from '../../lib/format';
import type { RunCardState, ThreadItem } from '../../state/thread';
import { hasRunActivity, isTrivialRun } from '../../state/thread';
import { RunCard } from './RunCard';
import styles from './ThreadView.module.css';

export interface ThreadViewProps {
  items: ThreadItem[];
  onCancelRun: (runId: string) => void;
  onAnswerApproval: (runId: string, requestId: string, action: RunApprovalAction) => void;
  onToggleRun: (runId: string) => void;
}

/** The conversation: user bubbles right, assistant markdown blocks, notices,
 * and run cards. Auto-follows the tail unless the user scrolled up. */
export function ThreadView({ items, onCancelRun, onAnswerApproval, onToggleRun }: ThreadViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && pinnedRef.current) node.scrollTop = node.scrollHeight;
  }, [items]);

  function onScroll(): void {
    const node = scrollRef.current;
    if (!node) return;
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
  }

  // One pass: run lookup for the assistant meta suffix, plus which runs
  // already stream prose (their thinking line comes down at that point).
  const runs = new Map<string, RunCardState>();
  const proseRuns = new Set<string>();
  for (const item of items) {
    if (item.kind === 'run') runs.set(item.run.runId, item.run);
    else if (item.kind === 'assistant' && item.runId) proseRuns.add(item.runId);
  }

  return (
    <div ref={scrollRef} className={styles.scroll} onScroll={onScroll}>
      <div className={styles.thread}>
        {items.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>What should we work on?</div>
            <div className={styles.emptyHint}>Plain questions get answers; tasks run with tools.</div>
          </div>
        ) : null}
        {items.map(item => (
          <ThreadItemView
            key={item.id}
            item={item}
            runs={runs}
            proseRuns={proseRuns}
            onCancelRun={onCancelRun}
            onAnswerApproval={onAnswerApproval}
            onToggleRun={onToggleRun}
          />
        ))}
      </div>
    </div>
  );
}

function ThreadItemView({
  item,
  runs,
  proseRuns,
  onCancelRun,
  onAnswerApproval,
  onToggleRun,
}: {
  item: ThreadItem;
  runs: Map<string, RunCardState>;
  proseRuns: Set<string>;
} & Pick<ThreadViewProps, 'onCancelRun' | 'onAnswerApproval' | 'onToggleRun'>) {
  switch (item.kind) {
    case 'user':
      return (
        <div className={styles.userTurn}>
          {item.attachments && item.attachments.length > 0 ? (
            <div className={styles.userAttachments}>
              {item.attachments.map((attachment, index) =>
                attachment.kind === 'image' && attachment.previewUrl ? (
                  <img
                    key={index}
                    className={styles.userImage}
                    src={attachment.previewUrl}
                    alt={attachment.name}
                  />
                ) : (
                  <span key={index} className={styles.userFile}>
                    <span aria-hidden>📄</span> {attachment.name}
                  </span>
                ),
              )}
            </div>
          ) : null}
          <div className={styles.userBubble}>{item.text}</div>
        </div>
      );
    case 'assistant': {
      const run = item.runId ? runs.get(item.runId) : undefined;
      const meta = run && run.status !== 'running' ? runMetaText(run) : undefined;
      return (
        <div className={styles.assistant}>
          <Markdown source={item.markdown} />
          {item.streaming ? <span className={styles.cursor} aria-hidden /> : null}
          {meta ? <div className={styles.meta}>{meta}</div> : null}
        </div>
      );
    }
    case 'notice':
      return <div className={`${styles.notice} ${styles[`notice_${item.tone}`]}`}>{item.text}</div>;
    case 'run': {
      const run = item.run;
      if (!hasRunActivity(run)) {
        // No tools/plan/approval: nothing card-worthy. While the model is
        // still silent, show an inline thinking line; once prose streams (or
        // the run completes) the response itself carries the state.
        if (isTrivialRun(run)) return null;
        if (run.status === 'running') {
          if (proseRuns.has(run.runId)) return null;
          return (
            <div className={styles.thinking}>
              <span className={styles.thinkingLabel}>Thinking…</span>
              <button className={styles.cancelLink} onClick={() => onCancelRun(run.runId)}>
                Cancel
              </button>
            </div>
          );
        }
        // failed / cancelled / blocked without activity → the card's status
        // footer is still the only place that tells the user what happened.
      }
      return (
        <RunCard
          run={run}
          onCancel={() => onCancelRun(run.runId)}
          onAnswer={(requestId, action) => onAnswerApproval(run.runId, requestId, action)}
          onToggle={() => onToggleRun(run.runId)}
        />
      );
    }
  }
}

/** ChatGPT-style suffix under the run's response: `2s · 512 tokens · $0.01`. */
function runMetaText(run: RunCardState): string {
  const parts = [formatRunDuration(run.startedAt, run.finishedAt)];
  if (run.usage?.totalTokens !== undefined) parts.push(`${formatTokens(run.usage.totalTokens)} tokens`);
  if (run.usage?.estimatedCostUSD !== undefined) parts.push(formatCostUSD(run.usage.estimatedCostUSD));
  return parts.join(' · ');
}
