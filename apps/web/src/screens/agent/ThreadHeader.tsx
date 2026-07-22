import type { ReactNode } from 'react';
import type { WorkspaceView } from '../../components/WorkspaceTabs';
import { WorkspaceToolbar } from '../../components/WorkspaceToolbar';
import styles from './ThreadHeader.module.css';

export interface ThreadHeaderProps {
  sessionTitle: string;
  /** Rendered avatar node (the screen owns the client wiring). */
  avatar?: ReactNode;
  sidebarsHidden: boolean;
  onToggleSidebars: () => void;
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
}

/** Right-workspace toolbar: sidebar toggle, location, and Agent/Apps switch. */
export function ThreadHeader({
  sessionTitle,
  avatar,
  sidebarsHidden,
  onToggleSidebars,
  view,
  onViewChange,
}: ThreadHeaderProps) {
  return (
    <WorkspaceToolbar
      view={view}
      onViewChange={onViewChange}
      leading={(
        <>
          <button
            className={styles.toggle}
            title={sidebarsHidden ? 'Show sidebar' : 'Hide sidebar'}
            aria-label={sidebarsHidden ? 'Show sidebar' : 'Hide sidebar'}
            aria-pressed={sidebarsHidden}
            onClick={onToggleSidebars}
          >
            <SidebarGlyph />
          </button>
          {avatar}
          <div className={styles.session}>{sessionTitle}</div>
        </>
      )}
    />
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
