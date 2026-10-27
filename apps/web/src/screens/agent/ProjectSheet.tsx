import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { listProjectAssets } from '../../api/projectAssets';
import {
  createProject,
  deleteProject,
  deleteProjectIcon,
  dismissProjectMember,
  inviteProjectMember,
  setProjectIcon,
  updateProject,
} from '../../api/projects';
import type { ProfileSummary, ProjectDetail } from '../../api/types';
import { AvatarCropper } from '../../components/AvatarCropper';
import { ProjectIcon } from '../../components/ProjectIcon';
import { fileToBase64 } from '../../lib/attachments';
import { DEFAULT_LIMIT_BYTES, formatStorage, limitBytes, limitParts, type LimitUnit } from '../../lib/projectAssets';
import styles from './ProjectSheet.module.css';

const ICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface ProjectSheetProps {
  client: ApiClient;
  /** Edit this project; without one the sheet creates a project (name and icon). */
  project?: ProjectDetail;
  profiles: ProfileSummary[];
  onSaved: (project: ProjectDetail) => void;
  onDeleted?: () => void;
  onClose: () => void;
}

/** Project settings (docs/projects.md#web-ui): name, icon, instructions,
 * roster and Lead. Roster and Lead changes apply together on Save. */
export function ProjectSheet({ client, project, profiles, onSaved, onDeleted, onClose }: ProjectSheetProps) {
  const [name, setName] = useState(project?.name ?? '');
  const [instructions, setInstructions] = useState(project?.instructions ?? '');
  const [members, setMembers] = useState<string[]>(project?.members ?? []);
  const [lead, setLead] = useState(project?.lead ?? '');
  /** A new icon to upload, or `null` to remove the current one. */
  const [icon, setIcon] = useState<{ data: string; mediaType: string } | null>();
  const [cropping, setCropping] = useState<File>();
  const initialLimit = limitParts(project?.assetLimitBytes ?? DEFAULT_LIMIT_BYTES);
  const [limitValue, setLimitValue] = useState(initialLimit.value);
  const [limitUnit, setLimitUnit] = useState<LimitUnit>(initialLimit.unit);
  /** "Use default" sends `null`, so the project follows the default. */
  const [limitDefault, setLimitDefault] = useState(false);
  const [usedBytes, setUsedBytes] = useState<number>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const label = (profile: string) => profiles.find(candidate => candidate.name === profile)?.displayName ?? profile;
  const invitable = profiles.filter(profile => !members.includes(profile.name));
  const typedLimit = limitBytes(limitValue, limitUnit);
  const canSave = name.trim().length > 0 && !busy && (!project || limitDefault || typedLimit !== undefined);
  const projectId = project?.id;

  useEffect(() => {
    if (!projectId) { return; }
    let cancelled = false;
    listProjectAssets(client, projectId).then(
      list => { if (!cancelled) { setUsedBytes(list.usage.usedBytes); } },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [client, projectId]);

  async function save(): Promise<void> {
    if (!canSave) { return; }
    setBusy(true);
    setProblem(undefined);
    try {
      let saved = project
        ? await updateProject(client, project.id, {
            ...(name.trim() !== project.name ? { name: name.trim() } : {}),
            ...(instructions !== project.instructions ? { instructions } : {}),
            ...(limitDefault ? { assetLimitBytes: null }
              : typedLimit !== undefined && typedLimit !== project.assetLimitBytes ? { assetLimitBytes: typedLimit } : {}),
          })
        : await createProject(client, { name: name.trim() });
      if (project) {
        // Invite first and dismiss last, so a former Lead can leave once replaced.
        for (const member of members.filter(member => !project.members.includes(member))) {
          saved = await inviteProjectMember(client, saved.id, member);
        }
        if (lead && lead !== project.lead) { saved = await updateProject(client, saved.id, { lead }); }
        for (const member of project.members.filter(member => !members.includes(member))) {
          saved = await dismissProjectMember(client, saved.id, member);
        }
      }
      if (icon) { saved = await setProjectIcon(client, saved.id, icon); }
      else if (icon === null && saved.icon) { saved = await deleteProjectIcon(client, saved.id); }
      onSaved(saved);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!project || busy) { return; }
    setBusy(true);
    try {
      await deleteProject(client, project.id);
      onDeleted?.();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  function pickIcon(file: File | undefined): void {
    if (!file) { return; }
    if (!ICON_TYPES.has(file.type)) {
      setProblem('Icons must be PNG, JPEG, or WebP.');
      return;
    }
    setProblem(undefined);
    setCropping(file);
  }

  if (cropping) {
    return (
      <AvatarCropper
        file={cropping}
        onCancel={() => setCropping(undefined)}
        onConfirm={file => {
          setCropping(undefined);
          void fileToBase64(file).then(data => setIcon({ data, mediaType: file.type || 'image/webp' }));
        }}
      />
    );
  }

  return (
    <div className={styles.backdrop} onClick={() => { if (!busy) { onClose(); } }}>
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={project ? 'Project settings' : 'New project'}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'Escape' && !busy) { onClose(); } }}
      >
        <div className={styles.title}>{project ? 'Project settings' : 'New project'}</div>

        <div className={styles.identityRow}>
          <button type="button" className={styles.iconButton} title="Choose icon" aria-label="Choose icon" onClick={() => fileInputRef.current?.click()}>
            {icon ? (
              <img className={styles.iconPreview} src={`data:${icon.mediaType};base64,${icon.data}`} alt="" />
            ) : (
              <ProjectIcon client={client} id={project?.id ?? ''} hasIcon={icon !== null && project?.icon !== undefined} size={52} />
            )}
          </button>
          <input
            ref={fileInputRef}
            className={styles.fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={event => {
              pickIcon(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <input
            className={styles.nameInput}
            aria-label="Project name"
            placeholder="Project name"
            maxLength={100}
            value={name}
            autoFocus
            onChange={event => setName(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { void save(); } }}
          />
        </div>

        {project ? (
          <>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Instructions</span>
              <textarea
                className={styles.instructions}
                rows={5}
                placeholder="For every profile in this project; they apply on top of each profile's own instructions."
                value={instructions}
                onChange={event => setInstructions(event.target.value)}
              />
            </label>

            <div className={styles.field}>
              <span className={styles.fieldLabel}>Profiles</span>
              <ul className={styles.roster} aria-label="Profiles in this project">
                {members.map(member => (
                  <li key={member} className={styles.member}>
                    <span className={styles.memberName}>{label(member)}</span>
                    {member === lead ? <span className={styles.leadBadge}>Lead</span> : (
                      <>
                        <button type="button" className={styles.linkButton} onClick={() => setLead(member)}>Make Lead</button>
                        <button
                          type="button"
                          className={styles.removeButton}
                          aria-label={`Remove ${label(member)}`}
                          title="Remove from project; its replies stay"
                          onClick={() => setMembers(current => current.filter(candidate => candidate !== member))}
                        >
                          ×
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {invitable.length > 0 ? (
                <select
                  className={styles.inviteSelect}
                  aria-label="Invite a profile"
                  value=""
                  onChange={event => {
                    const invited = event.target.value;
                    if (invited) { setMembers(current => [...current, invited]); }
                  }}
                >
                  <option value="">Invite a profile…</option>
                  {invitable.map(profile => <option key={profile.name} value={profile.name}>{profile.displayName}</option>)}
                </select>
              ) : null}
              <span className={styles.hint}>The Lead answers when a message addresses no one. Address others with @name.</span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="project-asset-limit">Asset storage limit</label>
              <div className={styles.limitRow}>
                <input
                  id="project-asset-limit"
                  className={`${styles.nameInput} ${styles.limitInput}`}
                  inputMode="decimal"
                  value={limitValue}
                  onChange={event => {
                    setLimitValue(event.target.value);
                    setLimitDefault(false);
                  }}
                />
                <select
                  className={`${styles.inviteSelect} ${styles.limitUnit}`}
                  aria-label="Unit"
                  value={limitUnit}
                  onChange={event => {
                    setLimitUnit(event.target.value as LimitUnit);
                    setLimitDefault(false);
                  }}
                >
                  <option value="MB">MB</option>
                  <option value="GB">GB</option>
                </select>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => {
                    const fallback = limitParts(DEFAULT_LIMIT_BYTES);
                    setLimitValue(fallback.value);
                    setLimitUnit(fallback.unit);
                    setLimitDefault(true);
                  }}
                >
                  Use default
                </button>
              </div>
              {usedBytes !== undefined && typedLimit ? (
                <div className={styles.meter} aria-hidden>
                  <div className={styles.meterFill} style={{ width: `${Math.min(1, usedBytes / typedLimit) * 100}%` }} />
                </div>
              ) : null}
              <span className={styles.hint}>
                {usedBytes !== undefined ? `Using ${formatStorage(usedBytes)}. ` : ''}
                Stored assets count once per content, across all versions; linked ones never count. 1 MB to 1 TB; the default is {formatStorage(DEFAULT_LIMIT_BYTES)}.
              </span>
            </div>
          </>
        ) : null}

        {problem ? <div className={styles.problem} role="alert">{problem}</div> : null}

        <div className={styles.actions}>
          {project && onDeleted ? (
            confirmDelete ? (
              <button type="button" className={styles.delete} disabled={busy} onClick={() => void remove()}>
                Delete; sessions return to their profiles
              </button>
            ) : (
              <button type="button" className={styles.deleteLink} disabled={busy} onClick={() => setConfirmDelete(true)}>Delete project</button>
            )
          ) : null}
          {!confirmDelete && (icon || (icon === undefined && project?.icon)) ? (
            <button type="button" className={styles.linkButton} disabled={busy} onClick={() => setIcon(null)}>Remove icon</button>
          ) : null}
          <span className={styles.spacer} />
          <button type="button" className={styles.cancel} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={styles.save} onClick={() => void save()} disabled={!canSave}>
            {busy ? 'Saving…' : project ? 'Save' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
}
