import styles from './AppsScreen.module.css';
import { formatActivityTime, formatMetrics, type RunMetrics } from './skillAppHelpers';

export type ActivityTone = 'info' | 'success' | 'warning' | 'error';

export interface ActivityEntry {
  id: number;
  createdAt: Date;
  tone: ActivityTone;
  title: string;
  message?: string;
  metrics?: RunMetrics;
}

/** Bottom drawer listing one App instance's runs, warnings, and errors. */
export function SkillAppActivityDrawer({
  activity,
  onClear,
  onClose,
}: {
  activity: ActivityEntry[];
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <section aria-label="App activity" className={styles.activityDrawer} id="skillapp-activity">
      <div className={styles.activityHeader}>
        <div>
          <h2>Activity</h2>
          <p>Runs, warnings, and errors for this app.</p>
        </div>
        <div className={styles.activityActions}>
          {activity.length > 0 ? (
            <button onClick={onClear} type="button">Clear</button>
          ) : null}
          <button onClick={onClose} type="button">Close</button>
        </div>
      </div>
      <div className={styles.activityList} role="log">
        {activity.length > 0 ? [...activity].reverse().map(entry => (
          <article className={`${styles.activityEntry} ${styles[`activity_${entry.tone}`]}`} key={entry.id}>
            <span aria-hidden className={styles.activityDot} />
            <div className={styles.activityBody}>
              <div className={styles.activityTitleLine}>
                <strong>{entry.title}</strong>
                <time>{formatActivityTime(entry.createdAt)}</time>
              </div>
              {entry.message ? <p>{entry.message}</p> : null}
              {entry.metrics && formatMetrics(entry.metrics) ? (
                <div className={styles.activityMetrics}>{formatMetrics(entry.metrics)}</div>
              ) : null}
            </div>
          </article>
        )) : (
          <div className={styles.activityEmpty}>No activity yet.</div>
        )}
      </div>
    </section>
  );
}
