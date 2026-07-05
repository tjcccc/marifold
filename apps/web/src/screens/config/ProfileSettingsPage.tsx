import { useState } from 'react';
import type { ProfileFileKind, ProfilePatchInput } from '../../api/profiles';
import type { ApprovalMode, MarifoldAgentConfig, MemoryEntry, ProfileDetail } from '../../api/types';
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
  /** Disables the controls while a write is in flight. */
  busy?: boolean;
}

const APPROVAL_OPTIONS = [
  { id: 'allow', label: 'Allow' },
  { id: 'ask', label: 'Ask' },
  { id: 'deny', label: 'Deny' },
] as const;

const MODE_OPTIONS = [
  { id: 'agent', label: 'Agent' },
  { id: 'chat', label: 'Chat' },
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

  return (
    <div className={styles.page}>
      <header className={styles.identity}>
        <span className={styles.avatar} aria-hidden>
          {detail.name.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <div className={styles.name}>{detail.name}</div>
          <div className={styles.identitySub}>
            {detail.source} profile
            {detail.settings.think ? ' · thinking on' : ''}
          </div>
        </div>
      </header>

      <section className={styles.group} aria-label="Model">
        <div className={styles.groupTitle}>Model</div>
        <div className={styles.card}>
          <div className={styles.rowLine}>
            <span className={styles.rowLabel}>Mode</span>
            <SegmentedControl
              options={MODE_OPTIONS}
              value={detail.settings.mode ?? 'agent'}
              onChange={mode => props.onPatch({ mode })}
              aria-label="Default mode"
            />
          </div>
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

      <section className={styles.group} aria-label="Instructions">
        <div className={styles.groupTitle}>Instructions</div>
        {(
          [
            ['PROFILE', 'profile', detail.files.profile.content],
            ['RULES', 'rules', detail.files.rules.content],
            ['CUSTOM', 'custom', detail.files.custom.content],
          ] as const
        ).map(([label, file, content]) => (
          <FileEditor
            key={`${detail.name}:${file}`}
            label={label}
            content={content}
            busy={busy}
            onSave={next => props.onSaveFile(file, next)}
          />
        ))}
      </section>
    </div>
  );
}

/** One instruction-file editor: textarea with Save/Revert, dirty-tracked locally. */
function FileEditor(props: { label: string; content: string; busy?: boolean; onSave: (content: string) => void }) {
  const [draft, setDraft] = useState(props.content);
  const dirty = draft !== props.content;
  return (
    <details className={styles.fileBlock}>
      <summary className={styles.fileSummary}>
        {props.label}
        {dirty ? <span className={styles.dirtyTag}>edited</span> : null}
      </summary>
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
    </details>
  );
}
