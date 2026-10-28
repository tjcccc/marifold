import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ApiClient } from '../../api/client';
import { ProjectArtifactsCard } from './ProjectArtifactsCard';
import { FolderGlyph, ProjectAssetsPanel, type ProjectAssetsPanelProps } from './ProjectAssetsPanel';
import { useProjectAssets } from './useProjectAssets';
import styles from './ProjectAssets.module.css';

export interface ProjectAssetsProps {
  client: ApiClient;
  projectId: string;
  /** The open session, whose outputs the Outputs card lists. */
  sessionId?: string;
  responding: boolean;
  /** The project's limit; a change reloads the usage. */
  limitBytes?: number;
  variant: ProjectAssetsPanelProps['variant'];
  onOpenSettings: () => void;
  /** Opens one of the project's artifacts in the viewer. */
  onOpenArtifact: (artifactId: string) => void;
}

/** The asset cards with their state; mount one per place they show. */
export function ProjectAssets({ client, projectId, sessionId, responding, limitBytes, variant, onOpenSettings, onOpenArtifact }: ProjectAssetsProps) {
  const state = useProjectAssets(client, projectId, variant === 'list' ? undefined : sessionId, responding, limitBytes);
  const artifacts = variant === 'list' ? undefined : (
    <ProjectArtifactsCard client={client} projectId={projectId} responding={responding} touch={variant !== 'column'} onOpen={onOpenArtifact} />
  );
  return <ProjectAssetsPanel client={client} state={state} variant={variant} onOpenSettings={onOpenSettings} artifacts={artifacts} />;
}

/** The thread header's Assets switch for the desktop column. */
export function AssetsToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={styles.toggle}
      aria-pressed={shown}
      aria-label={shown ? 'Hide assets' : 'Show assets'}
      title={shown ? 'Hide assets' : 'Show assets'}
      onClick={onToggle}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable="false">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <line x1="10" y1="2.5" x2="10" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
      </svg>
      <span>Assets</span>
    </button>
  );
}

/** The phone navigation bar's button that opens the Assets sheet. */
export function AssetsSheetButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className={styles.sheetButton} aria-label="Assets" aria-haspopup="dialog" onClick={onOpen}>
      <FolderGlyph size={20} />
    </button>
  );
}

/** Phone: the cards in a bottom sheet over the session. */
export function ProjectAssetsSheet({ projectName, onClose, ...props }: Omit<ProjectAssetsProps, 'variant'> & { projectName: string; onClose: () => void }) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);
  return createPortal(
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Project assets"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'Escape') { onClose(); } }}
      >
        <div className={styles.grabber} aria-hidden />
        <div className={styles.sheetHeader}>
          <div className={styles.sheetTitle}>{projectName}</div>
          <button type="button" className={styles.done} autoFocus onClick={onClose}>Done</button>
        </div>
        <div className={styles.sheetBody}>
          <ProjectAssets {...props} variant="sheet" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
