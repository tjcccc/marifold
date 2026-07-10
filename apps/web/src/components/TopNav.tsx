import type { ThemePreference } from '../theme/theme';
import { nextThemePreference } from '../theme/theme';
import { MarigoldLogo } from './MarigoldLogo';
import { SegmentedControl } from './SegmentedControl';
import styles from './TopNav.module.css';

export type AppView = 'agent' | 'apps' | 'config';

const VIEWS = [
  { id: 'agent', label: 'Agent' },
  { id: 'apps', label: 'Apps' },
  { id: 'config', label: 'Config' },
] as const;

const THEME_GLYPH: Record<ThemePreference, string> = {
  auto: '◐',
  light: '○',
  dark: '●',
};

export interface TopNavProps {
  view: AppView;
  onViewChange: (view: AppView) => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onOpenConnection?: () => void;
}

export function TopNav({ view, onViewChange, theme, onThemeChange, onOpenConnection }: TopNavProps) {
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <span className={styles.logo}>
          <MarigoldLogo size={32} />
        </span>
        marifold
      </div>
      <SegmentedControl options={VIEWS} value={view} onChange={onViewChange} aria-label="View" />
      <div className={styles.actions}>
        {onOpenConnection ? (
          <button
            className={styles.themeButton}
            title="Connection settings"
            aria-label="Connection settings"
            onClick={onOpenConnection}
          >
            ⌁
          </button>
        ) : null}
        <button
          className={styles.themeButton}
          title={`Theme: ${theme}`}
          aria-label={`Theme: ${theme} — switch`}
          onClick={() => onThemeChange(nextThemePreference(theme))}
        >
          {THEME_GLYPH[theme]}
        </button>
      </div>
    </header>
  );
}
