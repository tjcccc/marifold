import styles from './AppsScreen.module.css';

export interface AppsScreenProps {
  profileName?: string;
}

/** Apps (design 1c) — structured SkillApp mini tools. The runtime doesn't
 * exist yet (the spec is validator-only until a client can render it), so
 * this milestone ships the layout shell as an honest placeholder. */
export function AppsScreen({
  profileName,
}: AppsScreenProps) {
  return (
    <div className={styles.surface}>
      <div className={styles.placeholder}>
        <div className={styles.placeholderTitle}>Structured AI tools</div>
        <div className={styles.placeholderHint}>
          {profileName ? `${profileName} · ` : ''}Focused mini apps built from your skills.
        </div>
      </div>
    </div>
  );
}
