import styles from './AppsScreen.module.css';

/** Apps (design 1c) — structured SkillApp mini tools. The runtime doesn't
 * exist yet (the spec is validator-only until a client can render it), so
 * this milestone ships the layout shell as an honest placeholder. */
export function AppsScreen() {
  return (
    <div className={styles.layout}>
      <section className={styles.list} aria-label="Apps">
        <div className={styles.header}>Apps</div>
        <div className={styles.empty}>
          No apps installed yet.
          <br />
          SkillApps arrive in a later milestone.
        </div>
      </section>
      <div className={styles.surface}>
        <div className={styles.placeholder}>
          <div className={styles.placeholderTitle}>Structured AI tools</div>
          <div className={styles.placeholderHint}>
            Focused mini apps — translator, writing assistant, research summarizer — built from your skills.
          </div>
        </div>
      </div>
    </div>
  );
}
