import { useRef, useState } from 'react';
import type { CreateProfileInput } from '../api/profiles';
import type { ProfileMode } from '../api/types';
import { fileToBase64 } from '../lib/attachments';
import { SegmentedControl } from './SegmentedControl';
import styles from './CreateProfileSheet.module.css';

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_AVATAR_BYTES = 1024 * 1024;

const MODES = [
  { id: 'agent', label: 'Agent' },
  { id: 'chat', label: 'Chat' },
] as const;

export interface CreateProfileSheetProps {
  existingNames: string[];
  modelOptions: string[];
  busy: boolean;
  error?: string;
  onSubmit: (input: CreateProfileInput) => void;
  onClose: () => void;
}

/** The light create-profile modal (name, avatar, mode, model). Everything
 * else — docs, permissions, memories — is edited on the Config page after
 * creation. Presentational: the screen owns the API flow. */
export function CreateProfileSheet(props: CreateProfileSheetProps) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ProfileMode>('agent');
  const [modelChoice, setModelChoice] = useState('');
  const [avatar, setAvatar] = useState<{ data: string; mediaType: string } | undefined>();
  const [localProblem, setLocalProblem] = useState<string | undefined>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const trimmed = name.trim();
  const taken = props.existingNames.includes(trimmed);
  const nameProblem =
    trimmed.length === 0
      ? undefined
      : !SAFE_NAME.test(trimmed)
        ? 'Letters, numbers, underscores, and hyphens only.'
        : taken
          ? `'${trimmed}' already exists.`
          : undefined;
  const canSubmit = trimmed.length > 0 && !nameProblem && !props.busy;

  async function pickAvatar(file: File | undefined): Promise<void> {
    if (!file) return;
    if (!AVATAR_TYPES.has(file.type)) {
      setLocalProblem('Avatars must be PNG, JPEG, or WebP.');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setLocalProblem('Avatars are limited to 1 MB.');
      return;
    }
    setLocalProblem(undefined);
    setAvatar({ data: await fileToBase64(file), mediaType: file.type });
  }

  function submit(): void {
    if (!canSubmit) return;
    const slash = modelChoice.indexOf('/');
    props.onSubmit({
      name: trimmed,
      mode,
      ...(modelChoice && slash > 0
        ? { provider: modelChoice.slice(0, slash), model: modelChoice.slice(slash + 1) }
        : {}),
      ...(avatar ? { avatar } : {}),
    });
  }

  const problem = props.error ?? localProblem ?? nameProblem;

  return (
    <div className={styles.backdrop} onClick={props.onClose}>
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="New profile"
        onClick={event => event.stopPropagation()}
      >
        <div className={styles.title}>New profile</div>

        <div className={styles.identityRow}>
          <button
            className={styles.avatarButton}
            title="Choose avatar"
            onClick={() => fileInputRef.current?.click()}
          >
            {avatar ? (
              <img
                className={styles.avatarPreview}
                src={`data:${avatar.mediaType};base64,${avatar.data}`}
                alt="Avatar preview"
              />
            ) : (
              <span className={styles.avatarPlaceholder} aria-hidden>
                {trimmed ? trimmed.slice(0, 1).toUpperCase() : '+'}
              </span>
            )}
          </button>
          <input
            ref={fileInputRef}
            className={styles.fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={event => void pickAvatar(event.target.files?.[0])}
          />
          <input
            className={styles.nameInput}
            placeholder="profile-name"
            value={name}
            autoFocus
            onChange={event => setName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') submit();
              if (event.key === 'Escape') props.onClose();
            }}
          />
        </div>

        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Mode</span>
          <SegmentedControl options={MODES} value={mode} onChange={setMode} aria-label="Mode" />
        </div>

        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Model</span>
          <select
            className={styles.modelSelect}
            value={modelChoice}
            onChange={event => setModelChoice(event.target.value)}
          >
            <option value="">Auto — global default</option>
            {props.modelOptions.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        {problem ? <div className={styles.problem}>{problem}</div> : null}

        <div className={styles.hint}>Docs, permissions, and memories are edited in Config after creation.</div>

        <div className={styles.actions}>
          <button className={styles.cancel} onClick={props.onClose} disabled={props.busy}>
            Cancel
          </button>
          <button className={styles.create} onClick={submit} disabled={!canSubmit}>
            {props.busy ? 'Creating…' : 'Create profile'}
          </button>
        </div>
      </div>
    </div>
  );
}
