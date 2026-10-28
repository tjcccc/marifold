import { useState } from 'react';
import type { ApiClient } from '../../api/client';
import { createArtifactFolder, deleteArtifactFolder, renameArtifactFolder } from '../../api/artifacts';
import styles from '../agent/ProfileSidebar.module.css';
import own from './ArtifactsSidebar.module.css';
import type { ArtifactLibraryState } from './useArtifactLibrary';

/** The fixed library views; any other key is a folder id. */
export const FIXED_FOLDERS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'unfiled', label: 'Unfiled' },
] as const;

export interface ArtifactsSidebarContentProps {
  client: ApiClient;
  library: ArtifactLibraryState;
  selected: string;
  onSelect: (folder: string) => void;
}

/** Folders are names for groups of artifacts, not places on disk: deleting
 * one leaves its artifacts Unfiled. */
export function ArtifactsSidebarContent({ client, library, selected, onSelect }: ArtifactsSidebarContentProps) {
  const [editing, setEditing] = useState<{ id?: string; name: string }>();
  const [actions, setActions] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const counts = library.counts;

  async function run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      setProblem(undefined);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
    await library.refresh();
  }

  function submitName(): void {
    const name = editing?.name.trim();
    const id = editing?.id;
    setEditing(undefined);
    if (!name) { return; }
    void run(async () => {
      const folder = id ? await renameArtifactFolder(client, id, name) : await createArtifactFolder(client, name);
      if (!id) { onSelect(folder.id); }
    });
  }

  const row = (key: string, label: string, count: number | undefined, unread?: number) => (
    <div key={key} className={selected === key ? styles.rowSelected : styles.row}>
      <button type="button" className={`${styles.rowMain} ${own.rowMain}`} aria-current={selected === key ? 'page' : undefined} onClick={() => onSelect(key)}>
        <span className={styles.name}>{label}</span>
        {unread ? <span className={own.unread} aria-label={`${unread} unread`} /> : null}
        <span className={own.count}>{count ?? ''}</span>
      </button>
    </div>
  );
  const nameInput = (
    <form className={own.nameForm} onSubmit={event => { event.preventDefault(); submitName(); }}>
      <input className={own.nameInput} aria-label="Folder name" autoFocus maxLength={80} value={editing?.name ?? ''}
        onChange={event => setEditing(current => current && { ...current, name: event.target.value })}
        onBlur={submitName} onKeyDown={event => { if (event.key === 'Escape') { setEditing(undefined); } }} />
    </form>
  );

  return (
    <div className={styles.list}>
      {FIXED_FOLDERS.map(folder => row(folder.key, folder.label, counts?.[folder.key]))}
      <div className={styles.header}>
        <span>Folders</span>
        <button type="button" className={styles.newButton} aria-label="New folder" onClick={() => setEditing({ name: '' })}>+</button>
      </div>
      {editing && !editing.id ? nameInput : null}
      {library.folders.length === 0 && !editing ? <div className={styles.empty}>No folders yet.</div> : null}
      {library.folders.map(folder => editing?.id === folder.id ? <div key={folder.id}>{nameInput}</div> : (
        <div key={folder.id}>
          {row(folder.id, folder.name, folder.count, folder.unread)}
          <div className={own.folderActions}>
            {actions === folder.id ? (
              <>
                <button type="button" className={own.action} onClick={() => { setActions(undefined); setEditing({ id: folder.id, name: folder.name }); }}>Rename</button>
                <button type="button" className={`${own.action} ${own.danger}`} onClick={() => { setActions(undefined); if (selected === folder.id) { onSelect('unfiled'); } void run(() => deleteArtifactFolder(client, folder.id)); }}>Delete folder (keeps artifacts)</button>
                <button type="button" className={own.action} onClick={() => setActions(undefined)}>Cancel</button>
              </>
            ) : selected === folder.id ? (
              <button type="button" className={own.action} aria-label={`Folder actions for ${folder.name}`} onClick={() => setActions(folder.id)}>Folder actions…</button>
            ) : null}
          </div>
        </div>
      ))}
      <div className={own.spacer} />
      {row('deleted', 'Recently deleted', counts?.deleted)}
      {problem ?? library.error ? <div className={own.problem} role="alert">{problem ?? library.error}</div> : null}
    </div>
  );
}
