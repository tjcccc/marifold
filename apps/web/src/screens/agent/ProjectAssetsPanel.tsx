import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ApiClient } from '../../api/client';
import type { ListedProjectAsset, ProjectAssetVersion } from '../../api/types';
import { formatRelativeTime } from '../../lib/format';
import {
  assetsSummary,
  formatStorage,
  linkLabel,
  linkUnavailable,
  MAX_UPLOAD_BYTES,
  nearLimit,
  outputInAssets,
  storedMeta,
  usedFraction,
  type SessionOutput,
} from '../../lib/projectAssets';
import { downloadRunArtifact } from '../../lib/runArtifacts';
import { LinkAssetSheet } from './LinkAssetSheet';
import { downloadKey, outputKey, type ProjectAssetsState } from './useProjectAssets';
import styles from './ProjectAssetsPanel.module.css';

const MENU_WIDTH = 220;

export interface ProjectAssetsPanelProps {
  client: ApiClient;
  state: ProjectAssetsState;
  /** The desktop column, the phone's bottom sheet, or the phone's session list (Assets only). */
  variant: 'column' | 'sheet' | 'list';
  onOpenSettings: () => void;
}

type Menu = { kind: 'add' } | { kind: 'asset'; asset: ListedProjectAsset };
type Dialog = { kind: 'rename' | 'describe' | 'delete'; asset: ListedProjectAsset };

/** Project assets as Claude-style cards (spec/ui.md#project-assets): the
 * project's Assets with storage use, and this session's Outputs. */
export function ProjectAssetsPanel({ client, state, variant, onOpenSettings }: ProjectAssetsPanelProps) {
  const [assetsOpen, setAssetsOpen] = useState(variant !== 'list');
  const [outputsOpen, setOutputsOpen] = useState(variant === 'column');
  const [menu, setMenu] = useState<{ menu: Menu; top: number; left: number; trigger: HTMLButtonElement }>();
  const [dialog, setDialog] = useState<Dialog>();
  const [linking, setLinking] = useState(false);
  const [versions, setVersions] = useState<{ assetId: string; list?: ProjectAssetVersion[]; problem?: string }>();
  const [dropActive, setDropActive] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const versionName = useRef<string | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);
  const touch = variant !== 'column';

  useMenuDismiss(menuRef, menu?.trigger, () => setMenu(undefined));

  const stored = state.assets.filter(asset => asset.kind === 'stored');
  const linked = state.assets.filter(asset => asset.kind === 'linked');
  const notAdded = state.outputs.filter(output => !outputInAssets(output, state.assets)).length;
  const usage = state.usage;
  const warn = usage !== undefined && nearLimit(usage);

  function openMenu(next: Menu, trigger: HTMLButtonElement): void {
    if (menu && menu.trigger === trigger) {
      setMenu(undefined);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    setMenu({
      menu: next,
      trigger,
      left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 240)),
    });
  }

  function pickFiles(name?: string): void {
    setMenu(undefined);
    versionName.current = name;
    if (uploadInput.current) {
      uploadInput.current.multiple = name === undefined;
      uploadInput.current.click();
    }
  }

  async function toggleVersions(asset: ListedProjectAsset): Promise<void> {
    setMenu(undefined);
    if (versions?.assetId === asset.id) {
      setVersions(undefined);
      return;
    }
    setVersions({ assetId: asset.id });
    try {
      const list = await state.versions(asset);
      setVersions(current => current?.assetId === asset.id ? { assetId: asset.id, list } : current);
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      setVersions(current => current?.assetId === asset.id ? { assetId: asset.id, problem } : current);
    }
  }

  const dropHandlers = variant === 'list' ? {} : {
    onDragOver: (event: React.DragEvent) => {
      if (![...event.dataTransfer.types].includes('Files')) { return; }
      event.preventDefault();
      event.stopPropagation();
      setDropActive(true);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setDropActive(false); }
    },
    onDrop: (event: React.DragEvent) => {
      if (![...event.dataTransfer.types].includes('Files')) { return; }
      event.preventDefault();
      event.stopPropagation();
      setDropActive(false);
      const files = [...event.dataTransfer.files];
      if (files.length > 0) { void state.upload(files); }
    },
  };

  const assetRow = (asset: ListedProjectAsset) => {
    const loading = state.downloading.has(downloadKey(asset));
    const unavailable = asset.kind === 'linked' ? linkUnavailable(asset) : undefined;
    return (
      <div key={asset.id}>
        <div className={styles.row} data-touch={touch || undefined}>
          <span className={asset.kind === 'linked' ? styles.tileLinked : styles.tile} aria-hidden>
            {asset.kind === 'linked' ? <FolderGlyph /> : asset.mediaType.startsWith('image/') ? <ImageGlyph /> : <FileGlyph />}
          </span>
          <span className={styles.rowText}>
            <span className={styles.rowName} title={asset.description ?? asset.name}>{asset.name}</span>
            {asset.kind === 'stored' ? (
              <span className={styles.rowMeta}>{loading ? `Downloading… ${formatStorage(asset.size)}` : storedMeta(asset)}</span>
            ) : (
              <span className={styles.metaLine} title={linkLabel(asset)}>
                <span className={styles.rowMetaMono}>{linkLabel(asset)}</span>
                {unavailable ? <span className={styles.metaNote}>· {unavailable}</span> : null}
              </span>
            )}
          </span>
          {asset.kind === 'stored' && !touch ? (
            <button type="button" className={styles.rowAction} aria-label={`Download ${asset.name}`} title="Download" disabled={loading} onClick={() => void state.download(asset)}>
              <DownloadGlyph />
            </button>
          ) : null}
          <button
            type="button"
            className={styles.rowAction}
            aria-label={`More for ${asset.name}`}
            aria-haspopup="menu"
            aria-expanded={menu?.menu.kind === 'asset' && menu.menu.asset.id === asset.id}
            onClick={event => openMenu({ kind: 'asset', asset }, event.currentTarget)}
          >
            <MoreGlyph />
          </button>
        </div>
        {versions?.assetId === asset.id ? (
          <div className={styles.versions} role="group" aria-label={`Versions of ${asset.name}`}>
            <div className={styles.versionsTitle}>Versions</div>
            {versions.problem ? <div className={styles.problemText}>{versions.problem}</div> : null}
            {!versions.list && !versions.problem ? <div className={styles.rowMeta}>Loading…</div> : null}
            {versions.list?.map(version => (
              <div key={version.version} className={styles.version}>
                <span className={styles.versionNumber}>v{version.version}</span>
                <span className={styles.versionMeta}>
                  {state.downloading.has(downloadKey(asset, version.version))
                    ? 'Downloading…'
                    : `${formatStorage(version.size)} · ${version.savedBy ?? 'uploaded'} · ${formatRelativeTime(version.createdAt)}`}
                </span>
                <button
                  type="button"
                  className={styles.versionDownload}
                  aria-label={`Download version ${version.version}`}
                  disabled={state.downloading.has(downloadKey(asset, version.version))}
                  onClick={() => void state.download(asset, version.version)}
                >
                  <DownloadGlyph />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  const outputRow = (output: SessionOutput) => {
    const key = outputKey(output);
    const added = outputInAssets(output, state.assets);
    const name = output.artifact.name.slice(output.artifact.name.lastIndexOf('/') + 1);
    return (
      <div key={key} className={styles.row} data-touch={touch || undefined}>
        <span className={styles.rowText}>
          <span className={styles.rowName} title={output.artifact.name}>{name}</span>
          <span className={styles.rowMeta}>{formatStorage(output.artifact.size)} · {output.profile}</span>
        </span>
        {!touch ? (
          <button type="button" className={styles.rowAction} aria-label={`Download ${name}`} title="Download" onClick={() => void downloadRunArtifact(client, output.runId, output.artifact).catch(() => undefined)}>
            <DownloadGlyph />
          </button>
        ) : null}
        {added ? (
          <span className={styles.added}>In assets ✓</span>
        ) : (
          <button type="button" className={styles.addPill} disabled={state.adding.has(key)} onClick={() => void state.addOutput(output)}>
            {state.adding.has(key) ? 'Adding…' : '+ Add to assets'}
          </button>
        )}
      </div>
    );
  };

  const menuItems = (current: Menu): ReactNode => {
    if (current.kind === 'add') {
      return (
        <>
          <button type="button" role="menuitem" className={styles.menuItemTwoLine} onClick={() => pickFiles()}>
            <span className={styles.menuItemTitle}>Upload files…</span>
            <span className={styles.menuItemHint}>Stored here, with versions; up to {formatStorage(MAX_UPLOAD_BYTES)} each</span>
          </button>
          <button type="button" role="menuitem" className={styles.menuItemTwoLine} onClick={() => { setMenu(undefined); setLinking(true); }}>
            <span className={styles.menuItemTitle}>Link a file or folder…</span>
            <span className={styles.menuItemHint}>Stays on its device; doesn't count</span>
          </button>
        </>
      );
    }
    const { asset } = current;
    const open = (kind: Dialog['kind']) => { setMenu(undefined); setDialog({ kind, asset }); };
    return (
      <>
        {asset.kind === 'stored' && touch ? (
          <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { setMenu(undefined); void state.download(asset); }}>Download</button>
        ) : null}
        {asset.kind === 'stored' ? (
          <button type="button" role="menuitem" className={styles.menuItem} onClick={() => void toggleVersions(asset)}>
            {versions?.assetId === asset.id ? 'Hide versions' : 'Show versions'}
          </button>
        ) : null}
        <button type="button" role="menuitem" className={styles.menuItem} onClick={() => open('rename')}>Rename…</button>
        <button type="button" role="menuitem" className={styles.menuItem} onClick={() => open('describe')}>Describe…</button>
        {asset.kind === 'stored' ? (
          <button type="button" role="menuitem" className={styles.menuItem} onClick={() => pickFiles(asset.name)}>Upload a new version…</button>
        ) : null}
        <div className={styles.menuSeparator} role="separator" />
        <button type="button" role="menuitem" className={styles.menuItemDanger} onClick={() => open('delete')}>
          {asset.kind === 'stored' ? 'Delete with all versions' : 'Remove link'}
        </button>
      </>
    );
  };

  return (
    <div className={styles.panel} data-variant={variant} {...dropHandlers}>
      {dropActive ? <div className={styles.dropOverlay} aria-hidden>Drop to add to assets</div> : null}
      <section className={styles.card} aria-label="Assets">
        <div className={styles.cardHeader}>
          <button type="button" className={styles.cardToggle} aria-expanded={assetsOpen} onClick={() => setAssetsOpen(open => !open)}>
            <ChevronGlyph open={assetsOpen} />
            <span className={styles.cardTitle}>Assets</span>
            <span className={styles.spacer} />
            <span className={warn ? styles.summaryWarn : styles.summary}>
              {usage ? (warn ? `${formatStorage(usage.usedBytes)} of ${formatStorage(usage.limitBytes)}` : assetsSummary(state.assets.length, usage)) : state.loading ? 'Loading…' : ''}
            </span>
          </button>
          <button
            type="button"
            className={styles.addButton}
            aria-label="Add an asset"
            title="Add an asset"
            aria-haspopup="menu"
            aria-expanded={menu?.menu.kind === 'add'}
            onClick={event => openMenu({ kind: 'add' }, event.currentTarget)}
          >
            <PlusGlyph />
          </button>
        </div>
        {usage ? (
          <div className={styles.meter} aria-hidden>
            <div className={warn ? styles.meterFillWarn : styles.meterFill} style={{ width: `${usedFraction(usage) * 100}%` }} />
          </div>
        ) : null}
        {warn && usage ? (
          <div className={styles.note}>
            {usage.usedBytes >= usage.limitBytes
              ? 'Storage is full. '
              : `A new upload over ${formatStorage(usage.limitBytes - usage.usedBytes)} won't fit. `}
            Remove assets or raise the limit in{' '}
            <button type="button" className={styles.inlineLink} onClick={onOpenSettings}>Project settings</button>.
          </div>
        ) : null}
        {state.problem ? (
          <div className={styles.problem} role="alert">
            <span>{state.problem}</span>
            <button type="button" className={styles.dismiss} aria-label="Dismiss" onClick={state.dismissProblem}>×</button>
          </div>
        ) : null}
        {assetsOpen ? (
          <div className={styles.rows}>
            {state.uploads.map(upload => (
              <div key={upload.key} className={styles.row}>
                <span className={styles.tile} aria-hidden><FileGlyph /></span>
                <span className={styles.rowText}>
                  <span className={styles.rowName}>{upload.name}</span>
                  <span className={styles.progress} aria-hidden><span /></span>
                  <span className={styles.rowMeta}>Uploading… {formatStorage(upload.size)}</span>
                </span>
              </div>
            ))}
            {!state.loading && state.assets.length === 0 && state.uploads.length === 0 ? (
              <div className={styles.empty}>
                No assets yet. Upload files or link a folder; profiles in this project can read them
                {variant === 'list' ? '.' : ', and Add to assets keeps a run’s output.'}
              </div>
            ) : null}
            {stored.length > 0 && linked.length > 0 ? <div className={styles.group}>Stored</div> : null}
            {stored.map(assetRow)}
            {linked.length > 0 ? <div className={styles.group}>Linked</div> : null}
            {linked.map(assetRow)}
          </div>
        ) : null}
      </section>

      {variant !== 'list' ? (
        <section className={styles.card} aria-label="Outputs">
          <div className={styles.cardHeader}>
            <button type="button" className={styles.cardToggle} aria-expanded={outputsOpen} onClick={() => setOutputsOpen(open => !open)}>
              <ChevronGlyph open={outputsOpen} />
              <span className={styles.cardTitle}>Outputs</span>
              <span className={styles.spacer} />
              <span className={styles.summary}>
                {state.outputs.length === 0
                  ? 'none yet'
                  : `${state.outputs.length} in this session${!outputsOpen && notAdded > 0 ? ` · ${notAdded} not added` : ''}`}
              </span>
            </button>
          </div>
          {outputsOpen ? (
            <div className={styles.rows}>
              {state.outputs.length === 0 ? (
                <div className={styles.empty}>Files that runs in this session create appear here.</div>
              ) : state.outputs.map(outputRow)}
            </div>
          ) : null}
        </section>
      ) : null}

      <input
        ref={uploadInput}
        className={styles.fileInput}
        type="file"
        tabIndex={-1}
        aria-hidden
        onChange={event => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length > 0) { void state.upload(files, versionName.current); }
        }}
      />

      {menu ? createPortal(
        <div
          ref={menuRef}
          className={styles.menu}
          role="menu"
          aria-label={menu.menu.kind === 'add' ? 'Add an asset' : menu.menu.asset.name}
          style={{ top: menu.top, left: menu.left, width: MENU_WIDTH }}
        >
          {menuItems(menu.menu)}
        </div>,
        document.body,
      ) : null}

      {dialog ? (
        <AssetDialog
          dialog={dialog}
          onClose={() => setDialog(undefined)}
          onSubmit={async value => {
            if (dialog.kind === 'delete') { return state.remove(dialog.asset); }
            if (dialog.kind === 'rename') { return state.update(dialog.asset, { name: value }); }
            return state.update(dialog.asset, { description: value.trim() ? value.trim() : null });
          }}
        />
      ) : null}

      {linking ? (
        <LinkAssetSheet client={client} onLink={state.link} onClose={() => setLinking(false)} />
      ) : null}
    </div>
  );
}

/** Close a popup menu on an outside press, Escape, or scroll; arrows move focus. */
function useMenuDismiss(menuRef: React.RefObject<HTMLDivElement | null>, trigger: HTMLButtonElement | undefined, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!trigger) { return; }
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node) || menuRef.current?.contains(target) || trigger?.contains(target)) { return; }
      closeRef.current();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        closeRef.current();
        trigger?.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
      const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (items.length === 0) { return; }
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % items.length
            : (index - 1 + items.length) % items.length;
      items[next]?.focus();
    }
    function onScroll(event: Event): void {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) { return; }
      closeRef.current();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menuRef, trigger]);
}

interface AssetDialogProps {
  dialog: Dialog;
  onClose: () => void;
  /** Resolves to the problem, or undefined when done. */
  onSubmit: (value: string) => Promise<string | undefined>;
}

/** Rename, describe, or delete one asset. */
function AssetDialog({ dialog, onClose, onSubmit }: AssetDialogProps) {
  const { asset, kind } = dialog;
  const [value, setValue] = useState(kind === 'rename' ? asset.name : kind === 'describe' ? asset.description ?? '' : '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => () => returnFocus.current?.focus(), []);

  async function submit(): Promise<void> {
    if (busy || (kind === 'rename' && !value.trim())) { return; }
    setBusy(true);
    setProblem(undefined);
    const failed = await onSubmit(kind === 'rename' ? value.trim() : value);
    setBusy(false);
    if (failed) { setProblem(failed); }
    else { onClose(); }
  }

  const title = kind === 'rename' ? `Rename ${asset.name}`
    : kind === 'describe' ? `Describe ${asset.name}`
      : asset.kind === 'stored' ? `Delete ${asset.name}?` : `Remove the link ${asset.name}?`;
  const description = kind === 'describe'
    ? 'Profiles see this beside the name when they list the project’s assets.'
    : kind === 'delete'
      ? asset.kind === 'stored'
        ? asset.version === 1 ? 'It will be permanently deleted.' : `It and all ${asset.version} of its versions will be permanently deleted.`
        : `Its files stay on ${asset.deviceName ?? 'their device'}; profiles in this project just stop seeing them.`
      : 'Profiles refer to assets by name.';

  return createPortal(
    <div className={styles.dialogBackdrop} onClick={() => { if (!busy) { onClose(); } }}>
      <form
        className={styles.dialog}
        role={kind === 'delete' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="asset-dialog-title"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'Escape' && !busy) { onClose(); } }}
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        <div id="asset-dialog-title" className={styles.dialogTitle}>{title}</div>
        <div className={styles.dialogDescription}>{description}</div>
        {kind === 'rename' ? (
          <input className={styles.dialogInput} aria-label="Asset name" maxLength={200} autoFocus value={value} onChange={event => setValue(event.target.value)} />
        ) : kind === 'describe' ? (
          <textarea className={styles.dialogInput} aria-label="Description" rows={3} maxLength={1000} autoFocus value={value} onChange={event => setValue(event.target.value)} />
        ) : null}
        {problem ? <div className={styles.problemText} role="alert">{problem}</div> : null}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.dialogCancel} disabled={busy} autoFocus={kind === 'delete'} onClick={onClose}>Cancel</button>
          <button type="submit" className={kind === 'delete' ? styles.dialogDelete : styles.dialogPrimary} disabled={busy || (kind === 'rename' && !value.trim())}>
            {busy ? 'Saving…' : kind === 'rename' ? 'Rename' : kind === 'describe' ? 'Save' : asset.kind === 'stored' ? 'Delete' : 'Remove link'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden focusable="false">
      <path d={open ? 'M3 4.5 6 7.5 9 4.5' : 'M4.5 3 7.5 6 4.5 9'} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function MoreGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden focusable="false">
      <circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
    </svg>
  );
}

function DownloadGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M4 1.5h5l3.5 3.5v9.5H4Z M9 1.5V5h3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function ImageGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden focusable="false">
      <rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="m3 12 3.5-4 2.5 3 1.5-1.5L13 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function FolderGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
