import type { RunRecord } from '../../api/types';
import { formatRelativeTime } from '../../lib/format';
import styles from './CatchUpBanner.module.css';

export interface CatchUpBannerProps {
  runs: RunRecord[];
  onShow: (run: RunRecord) => void;
  onDismiss: () => void;
}

/** "While you were away…" (design 1b): agent work that finished without the
 * tab attached. Show expands the run into the thread via event replay. */
export function CatchUpBanner({ runs, onShow, onDismiss }: CatchUpBannerProps) {
  if (runs.length === 0) return null;
  return (
    <div className={styles.banner}>
      <div className={styles.rows}>
        {runs.map(run => (
          <div key={run.id} className={styles.row}>
            <span className={styles.text}>
              While you were away — “{truncate(run.objective, 64)}” {run.status}
              {run.finishedAt ? ` ${formatRelativeTime(run.finishedAt)}` : ''}
            </span>
            <button className={styles.show} onClick={() => onShow(run)}>
              Show ⌄
            </button>
          </div>
        ))}
      </div>
      <button className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
