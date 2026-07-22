import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import type { ModelsView, ProviderStatusEntry } from '../../api/misc';
import {
  addModel,
  getConfig,
  getModels,
  getProviderStatus,
  removeModel,
  setConfigValue,
  setDefaultModel,
} from '../../api/misc';
import {
  addTrustedFolder,
  createProfileWithSetup,
  deleteAvatar,
  deleteMemory,
  getProfile,
  listMemories,
  listProfiles,
  putAvatar,
  putProfileFile,
  removeTrustedFolder,
  updateProfile,
} from '../../api/profiles';
import type { CreateProfileInput, ProfileFileKind, ProfilePatchInput } from '../../api/profiles';
import type { MemoryEntry, ProfileDetail, ProfileSummary, PublicConfig } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { CreateProfileSheet } from '../../components/CreateProfileSheet';
import { ResizableSidebar } from '../../components/ResizableSidebar';
import { SidebarBrand, SidebarSystemFooter } from '../../components/SidebarChrome';
import { fileToBase64 } from '../../lib/attachments';
import type { ConfigSection, Route } from '../../lib/route';
import type { ThemePreference } from '../../theme/theme';
import { ModelsPage } from './ModelsPage';
import { ProfileSettingsPage } from './ProfileSettingsPage';
import { ProvidersPage } from './ProvidersPage';
import { ServicePage } from './ServicePage';
import styles from './ConfigScreen.module.css';

const SECTIONS: Array<{ id: ConfigSection; label: string }> = [
  { id: 'profiles', label: 'Profiles' },
  { id: 'providers', label: 'Providers' },
  { id: 'models', label: 'Models' },
  { id: 'service', label: 'Service' },
];

export interface ConfigScreenProps {
  client: ApiClient;
  route: Extract<Route, { view: 'config' }>;
  navigate: (route: Route) => void;
  onUnauthorized: () => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onOpenConnection: () => void;
  onOpenSettings: () => void;
  onDone: () => void;
}

/** Config — Mail-style columns: sections → the section's items (profiles,
 * providers) → detail. Writes go through the service routes; each response's
 * fresh state replaces local state (no optimistic writes). */
export function ConfigScreen({
  client,
  route,
  navigate,
  onUnauthorized,
  theme,
  onThemeChange,
  onOpenConnection,
  onOpenSettings,
  onDone,
}: ConfigScreenProps) {
  const { section, item } = route;

  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [config, setConfig] = useState<PublicConfig | undefined>();
  const [models, setModels] = useState<ModelsView | undefined>();
  const [providerStatus, setProviderStatus] = useState<ProviderStatusEntry[] | undefined>();
  const [detail, setDetail] = useState<ProfileDetail | undefined>();
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();

  const go = useCallback(
    (nextSection: ConfigSection, nextItem?: string) =>
      navigate({ view: 'config', section: nextSection, ...(nextItem ? { item: nextItem } : {}) }),
    [navigate],
  );

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof MarifoldApiError && error.code === 'UNAUTHORIZED') onUnauthorized();
      else setProblem(error instanceof Error ? error.message : String(error));
    },
    [onUnauthorized],
  );

  // Bootstrap: profiles, config, models.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [profileList, publicConfig, modelsView] = await Promise.all([
          listProfiles(client),
          getConfig(client),
          getModels(client),
        ]);
        if (cancelled) return;
        setProfiles(profileList);
        setConfig(publicConfig);
        setModels(modelsView);
      } catch (error) {
        if (!cancelled) handleError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, handleError]);

  // Landing on a list section without an item selects a sensible default.
  useEffect(() => {
    if (item || !config) return;
    if (section === 'profiles') go('profiles', config.default.profile);
    else if (section === 'providers') {
      const first = Object.keys(config.providers).sort()[0];
      if (first) go('providers', first);
    }
  }, [section, item, config, go]);

  // Profile detail for the selected profile.
  useEffect(() => {
    if (section !== 'profiles' || !item) return;
    let cancelled = false;
    (async () => {
      try {
        const [profileDetail, memoryEntries] = await Promise.all([
          getProfile(client, item),
          listMemories(client, item),
        ]);
        if (cancelled) return;
        setDetail(profileDetail);
        setMemories(memoryEntries);
        setProblem(undefined);
      } catch (error) {
        if (!cancelled) handleError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, section, item, handleError]);

  // Provider reachability, fetched when the section first opens (it probes).
  const refreshProviderStatus = useCallback(async () => {
    try {
      setProviderStatus(await getProviderStatus(client));
    } catch (error) {
      handleError(error);
    }
  }, [client, handleError]);

  useEffect(() => {
    if (section === 'providers' && providerStatus === undefined) void refreshProviderStatus();
  }, [section, providerStatus, refreshProviderStatus]);

  /** Run one profile write; the fresh ProfileDetail replaces local state. */
  const mutate = useCallback(
    async (write: () => Promise<ProfileDetail>) => {
      setBusy(true);
      try {
        setDetail(await write());
        setProblem(undefined);
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
      }
    },
    [handleError],
  );

  const refreshProfiles = useCallback(async () => {
    try {
      setProfiles(await listProfiles(client));
    } catch {
      // Cosmetic list refresh.
    }
  }, [client]);

  const onAvatarPick = useCallback(
    async (file: File) => {
      if (!item) return;
      const data = await fileToBase64(file);
      await mutate(() => putAvatar(client, item, data, file.type));
      setAvatarVersion(version => version + 1);
      void refreshProfiles();
    },
    [client, item, mutate, refreshProfiles],
  );

  async function submitCreateProfile(input: CreateProfileInput): Promise<void> {
    setCreateBusy(true);
    setCreateError(undefined);
    try {
      await createProfileWithSetup(client, input);
      await refreshProfiles();
      setCreateOpen(false);
      go('profiles', input.name);
    } catch (error) {
      await refreshProfiles();
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreateBusy(false);
    }
  }

  /** setConfigValue with the shared busy/problem handling; refreshes config. */
  const writeConfig = useCallback(
    async (key: string, value: string) => {
      setBusy(true);
      try {
        setConfig(await setConfigValue(client, key, value));
        setProblem(undefined);
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
      }
    },
    [client, handleError],
  );

  const providerEntries = config ? Object.keys(config.providers).sort() : [];

  return (
    <div className={styles.layout}>
      <ResizableSidebar>
        <nav className={styles.sections} aria-label="Config sections">
          <SidebarBrand />
          <div className={styles.settingsHeader}>
            <button className={styles.doneButton} onClick={onDone}>‹ Agent</button>
            <span>Settings</span>
          </div>
          <div className={styles.sectionRows}>
            {SECTIONS.map(entry => (
              <button
                key={entry.id}
                className={entry.id === section ? styles.rowSelected : styles.row}
                onClick={() => go(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <SidebarSystemFooter
            theme={theme}
            onThemeChange={onThemeChange}
            onOpenConnection={onOpenConnection}
            onOpenSettings={onOpenSettings}
            settingsActive
          />
        </nav>
      </ResizableSidebar>

      {section === 'profiles' ? (
        <nav className={styles.items} aria-label="Profiles">
          <div className={styles.itemsHeader}>
            <span>Profiles</span>
            <button
              className={styles.newButton}
              title="New profile"
              onClick={() => {
                setCreateError(undefined);
                setCreateOpen(true);
              }}
            >
              +
            </button>
          </div>
          {profiles.map(profile => (
            <button
              key={profile.name}
              className={profile.name === item ? styles.itemRowSelected : styles.itemRow}
              onClick={() => go('profiles', profile.name)}
            >
              <Avatar
                client={client}
                name={profile.name}
                hasAvatar={profile.avatar !== undefined}
                size={26}
                version={avatarVersion}
              />
              <span className={styles.itemName}>{profile.name}</span>
            </button>
          ))}
        </nav>
      ) : null}

      {section === 'providers' ? (
        <nav className={styles.items} aria-label="Providers">
          <div className={styles.itemsHeader}>
            <span>Providers</span>
          </div>
          {providerEntries.map(name => {
            const status = providerStatus?.find(entry => entry.name === name);
            return (
              <button
                key={name}
                className={name === item ? styles.itemRowSelected : styles.itemRow}
                onClick={() => go('providers', name)}
              >
                <span
                  className={
                    status === undefined
                      ? styles.dotUnknown
                      : status.reachable === true
                        ? styles.dotOk
                        : status.reachable === false
                          ? styles.dotBad
                          : styles.dotUnknown
                  }
                  aria-hidden
                />
                <span className={styles.itemName}>{name}</span>
                <span className={styles.itemSub}>{config?.providers[name]?.type}</span>
              </button>
            );
          })}
        </nav>
      ) : null}

      <div className={styles.page}>
        {problem ? <div className={styles.problem}>{problem}</div> : null}

        {section === 'profiles' ? (
          detail && detail.name === item ? (
            <ProfileSettingsPage
              detail={detail}
              memories={memories}
              globalAgent={config?.agent}
              modelOptions={models?.options ?? []}
              busy={busy}
              avatar={
                <Avatar
                  client={client}
                  name={detail.name}
                  hasAvatar={detail.avatar !== undefined}
                  size={120}
                  version={avatarVersion}
                />
              }
              onAvatarPick={file => void onAvatarPick(file)}
              onAvatarDelete={() => {
                if (!item) return;
                void mutate(() => deleteAvatar(client, item)).then(() => {
                  setAvatarVersion(version => version + 1);
                  void refreshProfiles();
                });
              }}
              onPatch={(patch: ProfilePatchInput) => {
                if (item) void mutate(() => updateProfile(client, item, patch));
              }}
              onSaveFile={(file: ProfileFileKind, content: string) => {
                if (item) void mutate(() => putProfileFile(client, item, file, content));
              }}
              onAddTrustedFolder={folder => {
                if (item) void mutate(() => addTrustedFolder(client, item, folder));
              }}
              onRemoveTrustedFolder={folder => {
                if (item) void mutate(() => removeTrustedFolder(client, item, folder));
              }}
              onMemoryAction={(id, mode) => {
                if (!item) return;
                setBusy(true);
                deleteMemory(client, item, id, mode)
                  .then(fresh => {
                    setMemories(fresh);
                    setProblem(undefined);
                  })
                  .catch(handleError)
                  .finally(() => setBusy(false));
              }}
            />
          ) : (
            <div className={styles.empty}>Select a profile.</div>
          )
        ) : null}

        {section === 'providers' ? (
          <ProvidersPage
            selected={item}
            config={config}
            status={providerStatus}
            busy={busy}
            onSaveField={(name, key, value) => void writeConfig(`providers.${name}.${key}`, value)}
            onRefreshStatus={() => void refreshProviderStatus()}
            onAddProvider={async input => {
              await writeConfig(`providers.${input.name}.type`, input.type);
              if (input.baseUrl) await writeConfig(`providers.${input.name}.base_url`, input.baseUrl);
              if (input.apiKeyEnv) await writeConfig(`providers.${input.name}.api_key_env`, input.apiKeyEnv);
              if (input.proxy) await writeConfig(`providers.${input.name}.proxy`, input.proxy);
              setProviderStatus(undefined); // re-probe with the new entry
              go('providers', input.name);
            }}
          />
        ) : null}

        {section === 'models' ? (
          <ModelsPage
            client={client}
            models={models}
            providers={providerEntries}
            busy={busy}
            onSetDefault={async (provider, model) => {
              setBusy(true);
              try {
                setModels(await setDefaultModel(client, provider, model));
                setProblem(undefined);
              } catch (error) {
                handleError(error);
              } finally {
                setBusy(false);
              }
            }}
            onRemove={async (provider, model) => {
              setBusy(true);
              try {
                setModels(await removeModel(client, provider, model));
                setProblem(undefined);
              } catch (error) {
                handleError(error);
              } finally {
                setBusy(false);
              }
            }}
            onAdd={async input => {
              setBusy(true);
              try {
                setModels(await addModel(client, input));
                setProblem(undefined);
              } catch (error) {
                handleError(error);
              } finally {
                setBusy(false);
              }
            }}
          />
        ) : null}

        {section === 'service' ? (
          <ServicePage
            service={config?.service}
            busy={busy}
            onSave={(key, value) => void writeConfig(`service.${key}`, value)}
          />
        ) : null}
      </div>

      {createOpen ? (
        <CreateProfileSheet
          existingNames={profiles.map(profile => profile.name)}
          modelOptions={models?.options ?? []}
          busy={createBusy}
          error={createError}
          onSubmit={input => void submitCreateProfile(input)}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </div>
  );
}
