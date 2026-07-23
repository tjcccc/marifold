import type { ThemePreference } from '../../theme/theme';
import styles from './SystemPages.module.css';

export interface AppearancePageProps {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}

export function AppearancePage({ theme, onThemeChange }: AppearancePageProps) {
  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <div className={styles.pageTitle}>Appearance</div>
          <div className={styles.pageSub}>Choose a fixed theme or follow the operating system.</div>
        </div>
      </header>
      <section className={styles.card}>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Theme</span>
          <div className={styles.segmented} role="radiogroup" aria-label="Theme">
            {(['auto', 'light', 'dark'] as ThemePreference[]).map(option => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={theme === option}
                className={theme === option ? styles.segmentActive : styles.segment}
                onClick={() => onThemeChange(option)}
              >
                {option[0].toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
