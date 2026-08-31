import type { ReactNode } from 'react';
import styles from './MobileNavigationBar.module.css';

export interface MobileNavigationBarProps {
  title: string;
  backLabel?: string;
  onBack?: () => void;
  trailing?: ReactNode;
}

/** Compact iOS-style navigation bar for one level of the mobile workspace. */
export function MobileNavigationBar({ title, backLabel, onBack, trailing }: MobileNavigationBarProps) {
  return (
    <header className={styles.bar}>
      <div className={styles.side}>
        {onBack ? (
          <button className={styles.back} type="button" onClick={onBack} aria-label={`Back to ${backLabel ?? 'previous screen'}`}>
            <BackGlyph />
            <span>{backLabel}</span>
          </button>
        ) : null}
      </div>
      <div className={styles.title}>{title}</div>
      <div className={`${styles.side} ${styles.trailing}`}>{trailing}</div>
    </header>
  );
}

function BackGlyph() {
  return (
    <svg width="11" height="20" viewBox="0 0 11 20" aria-hidden focusable="false">
      <path d="m9 2-7 8 7 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
