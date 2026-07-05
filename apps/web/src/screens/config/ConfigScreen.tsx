import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import { getConfig, getModels } from '../../api/misc';
import {
  addTrustedFolder,
  deleteMemory,
  getProfile,
  listMemories,
  listProfiles,
  putProfileFile,
  removeTrustedFolder,
  updateProfile,
} from '../../api/profiles';
import type { ProfileFileKind, ProfilePatchInput } from '../../api/profiles';
import type { MemoryEntry, ProfileDetail, ProfileSummary, PublicConfig } from '../../api/types';
import type { Route } from '../../lib/hashRoute';
import { ProfileSettingsPage } from './ProfileSettingsPage';
import styles from './ConfigScreen.module.css';

export interface ConfigScreenProps {
  client: ApiClient;
  route: Extract<Route, { view: 'config' }>;
  navigate: (route: Route) => void;
  onUnauthorized: () => void;
}

/** Config (design 1d) — the system control layer. Per-profile settings are
 * editable (v0.37.0): each write goes through the profile write routes, and
 * the response's fresh ProfileDetail replaces local state (no optimistic
 * writes — the server is the source of truth for merged settings). */
export function ConfigScreen({ client, route, navigate, onUnauthorized }: ConfigScreenProps) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [config, setConfig] = useState<PublicConfig | undefined>();
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [detail, setDetail] = useState<ProfileDetail | undefined>();
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const selected = route.profile;

  const handleError = useCallback((error: unknown) => {
    if (error instanceof MarifoldApiError && error.code === 'UNAUTHORIZED') onUnauthorized();
    else setProblem(error instanceof Error ? error.message : String(error));
  }, [onUnauthorized]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [profileList, publicConfig, models] = await Promise.all([
          listProfiles(client),
          getConfig(client),
          getModels(client),
        ]);
        if (cancelled) return;
        setProfiles(profileList);
        setConfig(publicConfig);
        setModelOptions(models.options);
        if (!route.profile) navigate({ view: 'config', profile: publicConfig.default.profile });
      } catch (error) {
        if (cancelled) return;
        handleError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      try {
        const [profileDetail, memoryEntries] = await Promise.all([
          getProfile(client, selected),
          listMemories(client, selected),
        ]);
        if (cancelled) return;
        setDetail(profileDetail);
        setMemories(memoryEntries);
        setProblem(undefined);
      } catch (error) {
        if (cancelled) return;
        handleError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, selected, handleError]);

  /** Run one write; the fresh ProfileDetail the route returns replaces state. */
  const mutate = useCallback(async (write: () => Promise<ProfileDetail>) => {
    if (!selected) return;
    setBusy(true);
    try {
      setDetail(await write());
      setProblem(undefined);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }, [selected, handleError]);

  const onPatch = useCallback((patch: ProfilePatchInput) => {
    if (selected) void mutate(() => updateProfile(client, selected, patch));
  }, [client, selected, mutate]);

  const onSaveFile = useCallback((file: ProfileFileKind, content: string) => {
    if (selected) void mutate(() => putProfileFile(client, selected, file, content));
  }, [client, selected, mutate]);

  const onAddTrustedFolder = useCallback((folder: string) => {
    if (selected) void mutate(() => addTrustedFolder(client, selected, folder));
  }, [client, selected, mutate]);

  const onRemoveTrustedFolder = useCallback((folder: string) => {
    if (selected) void mutate(() => removeTrustedFolder(client, selected, folder));
  }, [client, selected, mutate]);

  const onMemoryAction = useCallback(async (id: string, mode: 'forget' | 'delete') => {
    if (!selected) return;
    setBusy(true);
    try {
      setMemories(await deleteMemory(client, selected, id, mode));
      setProblem(undefined);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }, [client, selected, handleError]);

  return (
    <div className={styles.layout}>
      <nav className={styles.sections} aria-label="Config sections">
        <div className={styles.header}>Profiles</div>
        {profiles.map(profile => (
          <button
            key={profile.name}
            className={profile.name === selected ? styles.rowSelected : styles.row}
            onClick={() => navigate({ view: 'config', profile: profile.name })}
          >
            {profile.name}
          </button>
        ))}
        <div className={styles.header}>System</div>
        <div className={styles.systemInfo}>
          <div>
            default · {config ? `${config.default.provider ?? '—'}/${config.default.model ?? '—'}` : '…'}
          </div>
          <div>{config ? `${Object.keys(config.providers).length} providers` : ''}</div>
        </div>
      </nav>
      <div className={styles.page}>
        {problem ? <div className={styles.problem}>{problem}</div> : null}
        {detail ? (
          <ProfileSettingsPage
            detail={detail}
            memories={memories}
            globalAgent={config?.agent}
            modelOptions={modelOptions}
            busy={busy}
            onPatch={onPatch}
            onSaveFile={onSaveFile}
            onAddTrustedFolder={onAddTrustedFolder}
            onRemoveTrustedFolder={onRemoveTrustedFolder}
            onMemoryAction={onMemoryAction}
          />
        ) : (
          <div className={styles.empty}>Select a profile.</div>
        )}
      </div>
    </div>
  );
}
