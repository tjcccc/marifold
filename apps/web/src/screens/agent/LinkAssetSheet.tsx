import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApiClient } from '../../api/client';
import { listExecutionDevices, type ExecutionDevices } from '../../api/misc';
import { listHomeFolders } from '../../api/profiles';
import { FolderPickerSheet } from '../../components/FolderPickerSheet';
import { defaultLinkName, linkTarget } from '../../lib/projectAssets';
import sheet from './ProjectSheet.module.css';
import styles from './LinkAssetSheet.module.css';

/** The sending device; a link to it is sent as a bare path. */
const THIS_DEVICE = '';

export interface LinkAssetSheetProps {
  client: ApiClient;
  /** Resolves to the problem, or undefined once linked. */
  onLink: (input: { target: string; name?: string; description?: string }) => Promise<string | undefined>;
  onClose: () => void;
}

/** Link a file or folder on a workspace device to the project. Browse lists
 * the host's folders (the service's `/v1/folders`); elsewhere the path is typed. */
export function LinkAssetSheet({ client, onLink, onClose }: LinkAssetSheetProps) {
  const [workspace, setWorkspace] = useState<ExecutionDevices>();
  const [device, setDevice] = useState(THIS_DEVICE);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const loadFolders = useCallback((folder: string) => listHomeFolders(client, folder), [client]);

  useEffect(() => {
    let cancelled = false;
    listExecutionDevices(client).then(
      result => { if (!cancelled) { setWorkspace(result); } },
      () => { if (!cancelled) { setWorkspace({ devices: [] }); } },
    );
    return () => { cancelled = true; };
  }, [client]);

  const devices = workspace?.devices ?? [];
  const self = devices.find(candidate => candidate.id === workspace?.deviceId);
  const host = devices.find(candidate => candidate.host);
  const others = devices.filter(candidate => candidate.id !== workspace?.deviceId);
  const chosen = device === THIS_DEVICE ? self : devices.find(candidate => candidate.id === device);
  const chosenName = chosen?.name ?? 'this device';
  // Profiles read a link on its device, so one that cannot run tasks leaves it unread (the host always can).
  const state = (candidate: { host?: boolean; online: boolean; executor: boolean }) =>
    !candidate.online ? 'offline' : candidate.executor || candidate.host ? undefined : 'execution off';
  const duplicate = (deviceName: string) => devices.filter(candidate => candidate.name.toLowerCase() === deviceName.toLowerCase()).length > 1;
  const canLink = path.trim().length > 0 && !busy;

  function choosePath(next: string): void {
    setPath(next);
    if (!nameEdited) { setName(defaultLinkName(next)); }
  }

  async function submit(): Promise<void> {
    if (!canLink) { return; }
    setBusy(true);
    setProblem(undefined);
    const failed = await onLink({
      target: linkTarget(device === THIS_DEVICE ? undefined : device, path),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
    });
    setBusy(false);
    if (failed) { setProblem(failed); }
    else { onClose(); }
  }

  return createPortal(
    <div className={sheet.backdrop} onClick={() => { if (!busy) { onClose(); } }}>
      <form
        className={sheet.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-asset-title"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'Escape' && !busy && !browsing) { onClose(); } }}
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <div id="link-asset-title" className={sheet.title}>Link a file or folder</div>
          <div className={styles.intro}>
            It stays on its device and never counts toward storage. Profiles read it there, and runs on that device may read it without asking.
          </div>
        </div>

        {others.length > 0 ? (
          <label className={sheet.field}>
            <span className={sheet.fieldLabel}>Device</span>
            <select className={sheet.inviteSelect} value={device} onChange={event => setDevice(event.target.value)}>
              <option value={THIS_DEVICE}>{self ? `${self.name} (this device${state(self) ? `, ${state(self)}` : ''})` : 'This device'}</option>
              {others.map(candidate => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}{duplicate(candidate.name) ? ` · ${candidate.id}` : ''}{state(candidate) ? ` (${state(candidate)})` : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className={sheet.field}>
          <label className={sheet.fieldLabel} htmlFor="link-asset-path">Path on {chosenName}</label>
          <div className={styles.pathRow}>
            <input
              id="link-asset-path"
              className={`${sheet.nameInput} ${styles.path}`}
              placeholder="~/folder or /absolute/path"
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={path}
              onChange={event => choosePath(event.target.value)}
            />
            <button type="button" className={sheet.cancel} disabled={!workspace} onClick={() => setBrowsing(true)}>
              {host && host.id !== chosen?.id ? `Browse ${host.name}…` : 'Browse…'}
            </button>
          </div>
          <span className={sheet.hint}>
            ~ is {chosenName}’s home.
            {chosen && state(chosen) === 'execution off' ? ` ${chosenName} has not enabled execution, so profiles cannot read it there yet.` : ''}
            {host && host.id !== chosen?.id ? ` Browse lists folders on ${host.name}; on ${chosenName}, type the path.` : ''}
          </span>
        </div>

        <div className={styles.pair}>
          <label className={sheet.field}>
            <span className={sheet.fieldLabel}>Name</span>
            <input
              className={sheet.nameInput}
              maxLength={200}
              value={name}
              onChange={event => {
                setName(event.target.value);
                setNameEdited(true);
              }}
            />
          </label>
          <label className={`${sheet.field} ${styles.wide}`}>
            <span className={sheet.fieldLabel}>Description</span>
            <input
              className={sheet.nameInput}
              placeholder="Optional, shown to profiles"
              maxLength={1000}
              value={description}
              onChange={event => setDescription(event.target.value)}
            />
          </label>
        </div>

        {problem ? <div className={sheet.problem} role="alert">{problem}</div> : null}

        <div className={sheet.actions}>
          <span className={sheet.spacer} />
          <button type="button" className={sheet.cancel} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className={sheet.save} disabled={!canLink}>{busy ? 'Linking…' : 'Link'}</button>
        </div>

        {browsing ? (
          <FolderPickerSheet
            load={loadFolders}
            hint={folder => `Links ${folder} on ${host?.name ?? 'this device'}.`}
            onChoose={folder => {
              setBrowsing(false);
              // The folders listed are the host's, so the link is too.
              setDevice(host && host.id !== workspace?.deviceId ? host.id : THIS_DEVICE);
              choosePath(folder);
            }}
            onClose={() => setBrowsing(false)}
          />
        ) : null}
      </form>
    </div>,
    document.body,
  );
}
