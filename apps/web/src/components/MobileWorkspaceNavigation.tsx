import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ThemePreference } from '../theme/theme';
import { nextThemePreference } from '../theme/theme';
import styles from './MobileWorkspaceNavigation.module.css';

export type MobileWorkspaceView = 'agent' | 'apps' | 'config';

export interface MobileWorkspaceNavigationProps {
  active: MobileWorkspaceView;
  theme: ThemePreference;
  connectionName?: string;
  onAgent: () => void;
  onApps: () => void;
  onOpenConnection: () => void;
  onThemeChange: (theme: ThemePreference) => void;
  onOpenSettings: () => void;
}

/** Phone-only workspace tabs plus the Config action sheet. */
export function MobileWorkspaceNavigation({
  active,
  theme,
  connectionName,
  onAgent,
  onApps,
  onOpenConnection,
  onThemeChange,
  onOpenSettings,
}: MobileWorkspaceNavigationProps) {
  const [configOpen, setConfigOpen] = useState(false);
  const configButton = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!configOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    sheet.current?.querySelector<HTMLButtonElement>('button')?.focus();
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      setConfigOpen(false);
      configButton.current?.focus();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [configOpen]);

  function run(action: () => void): void {
    setConfigOpen(false);
    action();
  }

  return (
    <div className={styles.root}>
      {configOpen ? createPortal(
        <div className={styles.backdrop} onPointerDown={() => setConfigOpen(false)}>
          <div
            ref={sheet}
            className={styles.sheet}
            role="dialog"
            aria-modal="true"
            aria-label="Config menu"
            onPointerDown={event => event.stopPropagation()}
          >
            <button className={styles.action} type="button" onClick={() => run(onOpenConnection)}>
              <span className={styles.actionIcon}><ConnectionGlyph /></span>
              <span>Connection</span>
              {connectionName ? <span className={styles.value}>{connectionName}</span> : null}
            </button>
            <button
              className={styles.action}
              type="button"
              onClick={() => run(() => onThemeChange(nextThemePreference(theme)))}
            >
              <span className={styles.actionIcon}><AppearanceGlyph /></span>
              <span>Appearance</span>
              <span className={styles.value}>{theme}</span>
            </button>
            <button className={styles.action} type="button" onClick={() => run(onOpenSettings)}>
              <span className={styles.actionIcon}><SettingsGlyph /></span>
              <span>Settings</span>
              <span className={styles.chevron} aria-hidden>›</span>
            </button>
          </div>
        </div>,
        document.body,
      ) : null}
      <nav className={styles.bar} aria-label="Mobile workspace">
        <button
          className={active === 'agent' && !configOpen ? styles.tabSelected : styles.tab}
          type="button"
          aria-current={active === 'agent' ? 'page' : undefined}
          onClick={() => run(onAgent)}
        >
          <AgentGlyph />
          <span>Agent</span>
        </button>
        <button
          className={active === 'apps' && !configOpen ? styles.tabSelected : styles.tab}
          type="button"
          aria-current={active === 'apps' ? 'page' : undefined}
          onClick={() => run(onApps)}
        >
          <AppsGlyph />
          <span>Apps</span>
        </button>
        <button
          ref={configButton}
          className={active === 'config' || configOpen ? styles.tabSelected : styles.tab}
          type="button"
          aria-expanded={configOpen}
          aria-haspopup="dialog"
          aria-current={active === 'config' ? 'page' : undefined}
          onClick={() => setConfigOpen(open => !open)}
        >
          <ConfigGlyph />
          <span>Config</span>
        </button>
      </nav>
    </div>
  );
}

function AgentGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d="M7 18.5c1.3-1.2 3-1.8 5-1.8s3.7.6 5 1.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="12" cy="9" r="4" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="m18.6 5.1.5-1.4.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5Z" fill="currentColor" />
    </svg>
  );
}

function AppsGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function ConfigGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d="M5 7h14M5 12h14M5 17h14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="9" cy="7" r="2" fill="var(--surface)" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="15" cy="12" r="2" fill="var(--surface)" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="10.5" cy="17" r="2" fill="var(--surface)" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function ConnectionGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d="m9.5 14.5 5-5M8 17H6.5a4 4 0 0 1 0-8H9M16 7h1.5a4 4 0 0 1 0 8H15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function AppearanceGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 5a7 7 0 0 1 0 14Z" fill="currentColor" opacity=".22" />
    </svg>
  );
}

function SettingsGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
