import { useEffect, useState } from 'react';
import type { HomeFolderListing } from '../api/types';
import styles from './FolderPickerSheet.module.css';

export interface FolderPickerSheetProps {
  /** Loads one level of the service device's home (`~`, `~/…`). */
  load: (folder: string) => Promise<HomeFolderListing>;
  onChoose: (folder: string) => void;
  onClose: () => void;
}

/** Browse folders in home and choose one. Browsers never reveal a picked
 * folder's real path, so the service lists the folders instead. */
export function FolderPickerSheet(props: FolderPickerSheetProps) {
  const { load } = props;
  const [current, setCurrent] = useState('~');
  const [listing, setListing] = useState<HomeFolderListing | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    load(current).then(
      next => { if (!cancelled) { setListing(next); } },
      (failure: unknown) => { if (!cancelled) { setError(failure instanceof Error ? failure.message : String(failure)); } },
    );
    return () => { cancelled = true; };
  }, [load, current]);

  const shown = listing?.path === current ? listing : undefined;

  return (
    <div className={styles.backdrop} onClick={props.onClose}>
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Choose a folder"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'Escape') { props.onClose(); } }}
      >
        <div className={styles.title}>Choose a folder</div>
        <div className={styles.pathRow}>
          <button
            type="button"
            className={styles.upButton}
            aria-label="Up one folder"
            disabled={!shown?.parent}
            onClick={() => { if (shown?.parent) { setCurrent(shown.parent); } }}
          >
            ‹
          </button>
          <code className={styles.path}>{current}</code>
        </div>
        <div className={styles.list} aria-label="Folders">
          {error ? <div className={styles.problem}>{error}</div> : null}
          {!error && !shown ? <div className={styles.empty}>Loading…</div> : null}
          {shown && shown.folders.length === 0 ? <div className={styles.empty}>No folders here.</div> : null}
          {shown?.folders.map(folder => (
            <button
              key={folder.path}
              type="button"
              className={styles.folder}
              onClick={() => setCurrent(folder.path)}
            >
              <span aria-hidden className={styles.folderIcon}>▸</span>
              {folder.name}
            </button>
          ))}
          {shown?.truncated ? <div className={styles.empty}>Showing the first {shown.folders.length} folders.</div> : null}
        </div>
        <div className={styles.hint}>
          {current === '~'
            ? 'Choosing home lets scripts create and edit files anywhere in home, but never delete or rename them.'
            : `Saved as ${current}: the same folder in home on every device.`}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={props.onClose}>Cancel</button>
          <button
            type="button"
            className={styles.choose}
            autoFocus
            disabled={!shown}
            onClick={() => props.onChoose(current)}
          >
            Choose {current === '~' ? 'home' : 'this folder'}
          </button>
        </div>
      </div>
    </div>
  );
}
