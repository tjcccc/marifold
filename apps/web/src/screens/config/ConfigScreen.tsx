import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import { getConfig } from '../../api/misc';
import { getProfile, listMemories, listProfiles } from '../../api/profiles';
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

/** Config (design 1d) — the system control layer. Read-only in this
 * milestone: editing lands with the config write routes (next milestone),
 * so every affordance here renders real data but stays inert. */
export function ConfigScreen({ client, route, navigate, onUnauthorized }: ConfigScreenProps) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [config, setConfig] = useState<PublicConfig | undefined>();
  const [detail, setDetail] = useState<ProfileDetail | undefined>();
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [problem, setProblem] = useState<string | undefined>();

  const selected = route.profile;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [profileList, publicConfig] = await Promise.all([listProfiles(client), getConfig(client)]);
        if (cancelled) return;
        setProfiles(profileList);
        setConfig(publicConfig);
        if (!route.profile) navigate({ view: 'config', profile: publicConfig.default.profile });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof MarifoldApiError && error.code === 'UNAUTHORIZED') onUnauthorized();
        else setProblem(error instanceof Error ? error.message : String(error));
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
        if (error instanceof MarifoldApiError && error.code === 'UNAUTHORIZED') onUnauthorized();
        else setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, selected, onUnauthorized]);

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
          <ProfileSettingsPage detail={detail} memories={memories} globalAgent={config?.agent} />
        ) : (
          <div className={styles.empty}>Select a profile.</div>
        )}
      </div>
    </div>
  );
}
