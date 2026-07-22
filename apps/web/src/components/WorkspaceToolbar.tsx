import type { ReactNode } from 'react';
import type { WorkspaceView } from './WorkspaceTabs';
import { WorkspaceTabs } from './WorkspaceTabs';
import styles from './WorkspaceToolbar.module.css';

export interface WorkspaceToolbarProps {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  leading?: ReactNode;
  trailing?: ReactNode;
}

/** Contextual toolbar for the right-hand workspace, never global window chrome. */
export function WorkspaceToolbar({ view, onViewChange, leading, trailing }: WorkspaceToolbarProps) {
  return (
    <header className={styles.bar}>
      <div className={styles.leading}>{leading}</div>
      <div className={styles.trailing}>
        {trailing}
        <WorkspaceTabs view={view} onChange={onViewChange} />
      </div>
    </header>
  );
}
