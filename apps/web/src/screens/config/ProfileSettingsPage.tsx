import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ProfileFileKind, ProfilePatchInput } from '../../api/profiles';
import type { ApprovalMode, MarifoldAgentConfig, MemoryEntry, ProfileDetail } from '../../api/types';
import { AvatarCropper } from '../../components/AvatarCropper';
import { SegmentedControl } from '../../components/SegmentedControl';
import { formatRelativeTime } from '../../lib/format';
import { resolveEffectivePermissions, TOOL_KIND_LABELS, TOOL_KINDS } from '../../lib/permissions';
import styles from './ProfileSettingsPage.module.css';

export interface ProfileSettingsPageProps {
  detail: ProfileDetail;
  memories: MemoryEntry[];
  globalAgent?: MarifoldAgentConfig;
  /** Saved provider/model options ("provider/model") for the model picker. */
  modelOptions: string[];
  onPatch: (patch: ProfilePatchInput) => void;
  onSaveFile: (file: ProfileFileKind, content: string) => void;
  onAddTrustedFolder: (folder: string) => void;
  onRemoveTrustedFolder: (folder: string) => void;
  onMemoryAction: (id: string, mode: 'forget' | 'delete') => void;
  onDelete?: () => void;
  deleteDisabledReason?: string;
  /** Rendered avatar (the screen owns client wiring); falls back to initials. */
  avatar?: ReactNode;
  onAvatarPick?: (file: File) => void;
  onAvatarDelete?: () => void;
  /** Disables the controls while a write is in flight. */
  busy?: boolean;
}

const APPROVAL_OPTIONS = [
  { id: 'allow', label: 'Allow' },
  { id: 'ask', label: 'Ask' },
  { id: 'deny', label: 'Deny' },
] as const;

/** Apple-Settings-style grouped page for one profile (design 1d). Editable:
 * every control writes the PROFILE OVERRIDE (never the resolved effective
 * value), so clearing an override falls back to the global default again. */
export function ProfileSettingsPage(props: ProfileSettingsPageProps) {
  const { detail, memories, globalAgent, modelOptions, busy } = props;
  const effective = resolveEffectivePermissions(globalAgent, detail.settings.agent);
  const active = memories.filter(entry => entry.status === 'active');
  const profileFolders = detail.settings.agent?.trustedFolders ?? [];
  const inheritedFolders = effective.trustedFolders.filter(folder => !profileFolders.includes(folder));
  const modelValue = detail.settings.provider && detail.settings.model
    ? `${detail.settings.provider}/${detail.settings.model}`
    : '';
  const [newFolder, setNewFolder] = useState('');
  const [displayName, setDisplayName] = useState(detail.settings.displayName ?? '');
  const [cropFile, setCropFile] = useState<File | undefined>();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeName, setRemoveName] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  const removeDialogRef = useRef<HTMLFormElement>(null);
  const removeInputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const canEditAvatar = props.onAvatarPick !== undefined;
  const removeConfirmed = removeName === detail.name;

  useEffect(() => {
    setRemoveOpen(false);
    setRemoveName('');
  }, [detail.name]);

  useEffect(() => {
    setDisplayName(detail.settings.displayName ?? '');
  }, [detail.name, detail.settings.displayName]);

  useEffect(() => {
    setAdvancedOpen(false);
  }, [detail.name]);

  useEffect(() => {
    if (!removeOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    removeInputRef.current?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busyRef.current) {
        setRemoveOpen(false);
        setRemoveName('');
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [...(removeDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled)',
      ) ?? [])];
      if (controls.length === 0) return;
      const current = controls.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current - 1 + controls.length) % controls.length
        : (current + 1) % controls.length;
      event.preventDefault();
      controls[next]?.focus();
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      removeTriggerRef.current?.focus();
    };
  }, [removeOpen]);

  function closeRemoveDialog(): void {
    if (busy) return;
    setRemoveOpen(false);
    setRemoveName('');
  }

  const avatarNode = props.avatar ?? (
    <span className={styles.avatar} aria-hidden>
      {detail.displayName.slice(0, 1).toUpperCase()}
    </span>
  );

  return (
    <div className={styles.page}>
      <header className={styles.identity}>
        {canEditAvatar ? (
          <button
            type="button"
            className={styles.avatarButton}
            disabled={busy}
            title={detail.avatar ? 'Change avatar' : 'Add avatar'}
            aria-label={detail.avatar ? 'Change avatar' : 'Add avatar'}
            onClick={() => avatarInputRef.current?.click()}
          >
            {avatarNode}
            <span className={styles.avatarOverlay} aria-hidden>
              <span className={styles.avatarOverlayIcon}>⌾</span>
              {detail.avatar ? 'Change' : 'Add'}
            </span>
          </button>
        ) : (
          <div className={styles.avatarButton}>{avatarNode}</div>
        )}
        <div className={styles.identityText}>
          <div className={styles.name}>{detail.displayName}</div>
          <div className={styles.identitySub}>
            {detail.source} profile
            {detail.settings.think ? ' · thinking on' : ''}
          </div>
        </div>
        {/* "Remove photo" hidden for now (per design); deletion stays available
            via the runtime/CLI. Re-add a control here when wanted. */}
        {canEditAvatar ? (
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className={styles.avatarInput}
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) setCropFile(file);
              event.target.value = '';
            }}
          />
        ) : null}
      </header>

      {cropFile ? (
        <AvatarCropper
          file={cropFile}
          busy={busy}
          onCancel={() => setCropFile(undefined)}
          onConfirm={processed => {
            props.onAvatarPick?.(processed);
            setCropFile(undefined);
          }}
        />
      ) : null}

      <section className={styles.group} aria-label="Profile">
        <div className={styles.groupTitle}>Profile</div>
        <div className={styles.card}>
          <div className={styles.rowLine}>
            <span className={styles.rowLabel}>Profile name</span>
            <code className={styles.profileName}>{detail.name}</code>
          </div>
          <div className={styles.rowLine}>
            <label className={styles.rowLabel} htmlFor="profile-display-name">Display name</label>
            <div className={styles.fieldEdit}>
              <input
                id="profile-display-name"
                className={styles.input}
                value={displayName}
                placeholder={detail.name}
                maxLength={100}
                disabled={busy}
                onChange={event => setDisplayName(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape') setDisplayName(detail.settings.displayName ?? '');
                }}
              />
              {displayName.trim() !== (detail.settings.displayName ?? '') ? (
                <button
                  type="button"
                  className={styles.saveAction}
                  disabled={busy}
                  onClick={() => props.onPatch({ displayName: displayName.trim() || null })}
                >
                  Save
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div className={styles.groupHint}>
          Profile names use letters, numbers, underscores, and hyphens only. Display names are shown throughout the Web UI; blank uses the profile name.
        </div>
      </section>

      <section className={styles.group} aria-label="Instructions">
        <div className={styles.groupTitle}>Instructions</div>
        <FileEditor
          key={`${detail.name}:instructions`}
          label="Instructions"
          content={detail.files.instructions.content}
          busy={busy}
          onSave={next => props.onSaveFile('instructions', next)}
        />
        {detail.instructionFormat === 'legacy' ? (
          <div className={styles.groupHint}>
            Saving creates INSTRUCTIONS.md. Run marifold doctor --fix to archive the legacy files now.
          </div>
        ) : detail.legacyInstructionFiles.length > 0 ? (
          <div className={styles.groupHint}>
            INSTRUCTIONS.md is active. Run marifold doctor --fix to back up and archive the old split files.
          </div>
        ) : null}
      </section>

      <section className={styles.group} aria-label="Model">
        <div className={styles.groupTitle}>Model</div>
        <div className={styles.card}>
          <div className={styles.rowLine}>
            <span className={styles.rowLabel}>Model</span>
            <select
              className={styles.select}
              aria-label="Model override"
              value={modelValue}
              disabled={busy}
              onChange={event => {
                const value = event.target.value;
                if (!value) {
                  props.onPatch({ provider: null, model: null });
                  return;
                }
                const slash = value.indexOf('/');
                props.onPatch({ provider: value.slice(0, slash), model: value.slice(slash + 1) });
              }}
            >
              <option value="">Default</option>
              {modelOptions.map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
          <div className={styles.rowLine}>
            <span className={styles.rowLabel}>Memories</span>
            <SegmentedControl
              options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }] as const}
              value={detail.settings.memories ? 'on' : 'off'}
              onChange={state => props.onPatch({ memories: state === 'on' })}
              aria-label="Memories"
            />
          </div>
          <div className={styles.rowLine}>
            <span className={styles.rowLabel}>Thinking</span>
            <SegmentedControl
              options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }] as const}
              value={detail.settings.think ? 'on' : 'off'}
              onChange={state => props.onPatch({ think: state === 'on' })}
              aria-label="Thinking"
            />
          </div>
        </div>
      </section>

      <button
        type="button"
        className={styles.advancedToggle}
        aria-expanded={advancedOpen}
        aria-controls="profile-advanced-settings"
        onClick={() => setAdvancedOpen(open => !open)}
      >
        <span>
          <span className={styles.advancedTitle}>Advanced settings</span>
          <span className={styles.advancedHint}>Memory and agent permissions</span>
        </span>
        <DisclosureChevron expanded={advancedOpen} />
      </button>

      {advancedOpen ? (
        <div id="profile-advanced-settings" className={styles.advancedGroups}>
          <section className={styles.group} aria-label="Memory">
            <div className={styles.groupTitle}>Memory</div>
            <div className={styles.card}>
              {active.length === 0 ? <div className={styles.emptyRow}>Nothing remembered yet.</div> : null}
              {active.map(entry => (
                <div key={entry.id} className={styles.memoryRow}>
                  <div className={styles.memoryBody}>
                    <div className={styles.memoryText}>{entry.text}</div>
                    <div className={styles.memoryMeta}>
                      {entry.kind} · p{entry.priority} · {formatRelativeTime(entry.updated_at)}
                    </div>
                  </div>
                  <div className={styles.memoryActions}>
                    <button
                      className={styles.smallButton}
                      disabled={busy}
                      onClick={() => props.onMemoryAction(entry.id, 'forget')}
                    >
                      Forget
                    </button>
                    <button
                      className={styles.smallButtonDanger}
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm('Permanently delete this memory? Forget keeps it recoverable.')) {
                          props.onMemoryAction(entry.id, 'delete');
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className={styles.groupHint}>
              Forget supersedes an entry (recoverable); Delete removes it for good. New memories still come from conversations.
            </div>
          </section>

          <section className={styles.group} aria-label="Agent permissions">
            <div className={styles.groupTitle}>Agent permissions</div>
            <div className={styles.card}>
              {TOOL_KINDS.map(kind => {
                const override = detail.settings.agent?.approval?.[kind];
                return (
                  <div key={kind} className={styles.rowLine}>
                    <span className={styles.rowLabel}>
                      {TOOL_KIND_LABELS[kind]}
                      {override ? (
                        <button
                          className={styles.inheritButton}
                          disabled={busy}
                          title="Remove this profile's override; inherit the global default"
                          onClick={() => props.onPatch({ approval: { [kind]: null } })}
                        >
                          overridden — inherit
                        </button>
                      ) : (
                        <span className={styles.inheritedTag}>inherited</span>
                      )}
                    </span>
                    <SegmentedControl
                      options={APPROVAL_OPTIONS}
                      value={effective.approval[kind]}
                      onChange={mode => props.onPatch({ approval: { [kind]: mode as ApprovalMode } })}
                      aria-label={`${TOOL_KIND_LABELS[kind]} approval`}
                    />
                  </div>
                );
              })}
            </div>
            <div className={styles.card}>
              <div className={styles.rowLine}>
                <span className={styles.rowLabel}>Trusted folders</span>
              </div>
              {inheritedFolders.map(folder => (
                <div key={folder} className={styles.folderRow}>
                  <code>{folder}</code>
                  <span className={styles.inheritedTag}>global</span>
                </div>
              ))}
              {profileFolders.map(folder => (
                <div key={folder} className={styles.folderRow}>
                  <code>{folder}</code>
                  <button
                    className={styles.smallButton}
                    disabled={busy}
                    onClick={() => props.onRemoveTrustedFolder(folder)}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className={styles.folderAdd}>
                <input
                  className={styles.input}
                  placeholder="/path/to/folder"
                  aria-label="New trusted folder"
                  value={newFolder}
                  disabled={busy}
                  onChange={event => setNewFolder(event.target.value)}
                />
                <button
                  className={styles.smallButton}
                  disabled={busy || !newFolder.trim()}
                  onClick={() => {
                    props.onAddTrustedFolder(newFolder.trim());
                    setNewFolder('');
                  }}
                >
                  Add
                </button>
              </div>
            </div>
            <div className={styles.groupHint}>The agent still narrates everything it does.</div>
          </section>
        </div>
      ) : null}

      {props.onDelete ? (
        <section className={styles.group} aria-label="Remove profile">
          <div className={styles.groupTitle}>Profile</div>
          <div className={styles.dangerCard}>
            <div>
              <div className={styles.dangerTitle}>Remove this profile</div>
              <div className={styles.dangerDescription}>
                Deletes its instructions, memories, skills, and avatar. Conversation history remains stored.
              </div>
            </div>
            <button
              ref={removeTriggerRef}
              className={styles.removeProfileButton}
              aria-label="Remove profile"
              disabled={busy || Boolean(props.deleteDisabledReason)}
              title={props.deleteDisabledReason}
              onClick={() => {
                setRemoveName('');
                setRemoveOpen(true);
              }}
            >
              Remove
            </button>
          </div>
          {props.deleteDisabledReason ? (
            <div className={styles.groupHint}>{props.deleteDisabledReason}</div>
          ) : null}
        </section>
      ) : null}

      {removeOpen ? createPortal(
        <div className={styles.removeBackdrop} onClick={closeRemoveDialog}>
          <form
            ref={removeDialogRef}
            className={styles.removeDialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="remove-profile-title"
            aria-describedby="remove-profile-description"
            onClick={event => event.stopPropagation()}
            onSubmit={event => {
              event.preventDefault();
              if (removeConfirmed && !busy) props.onDelete?.();
            }}
          >
            <div id="remove-profile-title" className={styles.removeDialogTitle}>
              Remove “{detail.name}”?
            </div>
            <div id="remove-profile-description" className={styles.removeDialogDescription}>
              Its instructions, memories, skills, and avatar will be permanently deleted.
              Conversation history will remain stored.
            </div>
            <label className={styles.removeConfirmLabel}>
              Type <strong>{detail.name}</strong> to confirm
              <input
                ref={removeInputRef}
                className={styles.removeConfirmInput}
                aria-label="Profile name confirmation"
                autoComplete="off"
                spellCheck={false}
                value={removeName}
                disabled={busy}
                onChange={event => setRemoveName(event.target.value)}
              />
            </label>
            <div className={styles.removeDialogActions}>
              <button
                type="button"
                className={styles.removeDialogCancel}
                disabled={busy}
                onClick={closeRemoveDialog}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={styles.removeDialogDelete}
                disabled={busy || !removeConfirmed}
              >
                {busy ? 'Removing…' : 'Remove profile'}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function DisclosureChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={styles.advancedChevron}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
      focusable="false"
    >
      <path
        d={expanded ? 'm5 12.5 5-5 5 5' : 'm5 7.5 5 5 5-5'}
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One instruction-file editor: textarea with Save/Revert, dirty-tracked locally. */
function FileEditor(props: { label: string; content: string; busy?: boolean; onSave: (content: string) => void }) {
  const [draft, setDraft] = useState(props.content);
  const dirty = draft !== props.content;
  return (
    <div className={styles.fileBlock}>
      <div className={styles.fileEditor}>
        <textarea
          className={styles.textarea}
          aria-label={`${props.label} content`}
          value={draft}
          disabled={props.busy}
          rows={Math.min(16, Math.max(4, draft.split('\n').length + 1))}
          onChange={event => setDraft(event.target.value)}
        />
        <div className={styles.editorActions}>
          {dirty ? <span className={styles.dirtyTag}>edited</span> : null}
          <button
            className={styles.smallButton}
            disabled={props.busy || !dirty}
            onClick={() => setDraft(props.content)}
          >
            Revert
          </button>
          <button
            className={styles.smallButtonPrimary}
            disabled={props.busy || !dirty}
            onClick={() => props.onSave(draft)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
