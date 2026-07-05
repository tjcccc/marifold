import { useEffect, useRef } from 'react';
import { Markdown } from '../../components/Markdown';
import type { RunApprovalAction } from '../../api/types';
import type { ThreadItem } from '../../state/thread';
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
  onCancelRun,
  onAnswerApproval,
  onToggleRun,
}: {
  item: ThreadItem;
} & Pick<ThreadViewProps, 'onCancelRun' | 'onAnswerApproval' | 'onToggleRun'>) {
  switch (item.kind) {
    case 'user':
      return <div className={styles.userBubble}>{item.text}</div>;
    case 'assistant':
      return (
        <div className={styles.assistant}>
          <Markdown source={item.markdown} />
          {item.streaming ? <span className={styles.cursor} aria-hidden /> : null}
        </div>
      );
    case 'notice':
      return <div className={`${styles.notice} ${styles[`notice_${item.tone}`]}`}>{item.text}</div>;
    case 'run':
      return (
        <RunCard
          run={item.run}
          onCancel={() => onCancelRun(item.run.runId)}
          onAnswer={(requestId, action) => onAnswerApproval(item.run.runId, requestId, action)}
          onToggle={() => onToggleRun(item.run.runId)}
        />
      );
  }
}
