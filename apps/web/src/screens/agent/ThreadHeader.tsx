import styles from './ThreadHeader.module.css';

export interface ThreadHeaderProps {
  profileName?: string;
  /** 'agent' | 'chat' — the effective profile mode. */
  profileMode?: string;
  sessionTitle: string;
  sidebarsHidden: boolean;
  onToggleSidebars: () => void;
}

/** Bar above the conversation: sidebar toggle + where-am-I (session title,
 * profile · mode). The only orientation left once the sidebars are hidden. */
export function ThreadHeader({
  profileName,
  profileMode,
  sessionTitle,
  sidebarsHidden,
  onToggleSidebars,
}: ThreadHeaderProps) {
  return (
    <div className={styles.bar}>
      <button
        className={styles.toggle}
        title={sidebarsHidden ? 'Show sidebars' : 'Hide sidebars'}
        aria-label={sidebarsHidden ? 'Show sidebars' : 'Hide sidebars'}
        aria-pressed={sidebarsHidden}
        onClick={onToggleSidebars}
      >
        <SidebarGlyph />
      </button>
      <div className={styles.titles}>
        <div className={styles.session}>{sessionTitle}</div>
        {profileName ? (
          <div className={styles.profile}>
            {profileName}
            {profileMode ? ` · ${profileMode}` : ''}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SidebarGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable="false">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
