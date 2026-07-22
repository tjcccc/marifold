import type { ThemePreference } from '../theme/theme';
import { nextThemePreference } from '../theme/theme';
import { MarigoldLogo } from './MarigoldLogo';
import styles from './SidebarChrome.module.css';

export interface SidebarBrandProps {
  /** Larger identity treatment for the root profile view. */
  prominent?: boolean;
}

export function SidebarBrand({ prominent = false }: SidebarBrandProps) {
  return (
    <div className={prominent ? styles.brandProminent : styles.brand} aria-label="Marifold">
      <span className={styles.logo}><MarigoldLogo size={prominent ? 32 : 25} /></span>
      <span className={styles.wordmark}>marifold</span>
    </div>
  );
}

export interface SidebarSystemFooterProps {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onOpenConnection: () => void;
  onOpenSettings: () => void;
  settingsActive?: boolean;
}

/** Stable system controls shared by every primary sidebar state. */
export function SidebarSystemFooter({
  theme,
  onThemeChange,
  onOpenConnection,
  onOpenSettings,
  settingsActive = false,
}: SidebarSystemFooterProps) {
  return (
    <div className={styles.footer} aria-label="System controls">
      <button className={styles.row} onClick={onOpenConnection}>
        <span className={styles.icon}><ConnectionGlyph /></span>
        <span>Connection</span>
      </button>
      <button className={styles.row} onClick={() => onThemeChange(nextThemePreference(theme))}>
        <span className={styles.icon}><AppearanceGlyph /></span>
        <span>Appearance</span>
        <span className={styles.value}>{theme}</span>
      </button>
      <button
        className={settingsActive ? styles.rowSelected : styles.row}
        aria-current={settingsActive ? 'page' : undefined}
        disabled={settingsActive}
        onClick={onOpenSettings}
      >
        <span className={styles.icon}><SettingsGlyph /></span>
        <span>Settings</span>
      </button>
    </div>
  );
}

function ConnectionGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M6.2 5.1 4.9 3.8a2.4 2.4 0 0 0-3.4 3.4l2.1 2.1A2.4 2.4 0 0 0 7 9.3l1-1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="m9.8 10.9 1.3 1.3a2.4 2.4 0 0 0 3.4-3.4l-2.1-2.1A2.4 2.4 0 0 0 9 6.7l-1 1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function AppearanceGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" opacity=".28" />
    </svg>
  );
}

function SettingsGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
