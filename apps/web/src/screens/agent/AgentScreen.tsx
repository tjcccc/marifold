import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { CreateProfileInput } from '../../api/profiles';
import { createProfileWithSetup } from '../../api/profiles';
import { listProjects } from '../../api/projects';
import type { ProjectDetail, ProjectSummary } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { ProfileLabel, ProfileStack } from '../../components/ProfileLabel';
import { ProjectIcon } from '../../components/ProjectIcon';
import { CreateProfileSheet } from '../../components/CreateProfileSheet';
import { MobileNavigationBar } from '../../components/MobileNavigationBar';
import { MobileWorkspaceNavigation } from '../../components/MobileWorkspaceNavigation';
import { ResizableSidebar } from '../../components/ResizableSidebar';
import { SidebarSystemFooter } from '../../components/SidebarChrome';
import type { WorkspaceView } from '../../components/WorkspaceTabs';
import { PROJECT_COMMANDS, parseCommand, WEB_COMMANDS } from '../../lib/commandSyntax';
import { commandProfiles, previewProjectRoute } from '../../lib/projectRouting';
import type { ChatRoute, Route } from '../../lib/route';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import type { ThemePreference } from '../../theme/theme';
import { AppsScreen } from '../apps/AppsScreen';
import { AppsSidebarContent } from '../apps/AppsSidebar';
import { useAppsCatalog } from '../apps/useAppsCatalog';
import { CatchUpBanner } from './CatchUpBanner';
import { SessionArchivedBanner, SessionBlockedBanner } from './SessionBlockedBanner';
import { InputBar } from './InputBar';
import { AssetsSheetButton, AssetsToggle, ProjectAssets, ProjectAssetsSheet } from './ProjectAssets';
import { useDeepAvailable } from './useGlobalDeep';
import { ProfileSidebarContent } from './ProfileSidebar';
import { ProjectSheet } from './ProjectSheet';
import { ProjectSidebarContent } from './ProjectSidebar';
import { SessionListContent, sessionTitle } from './SessionList';
import { ThreadHeader } from './ThreadHeader';
import { ThreadView } from './ThreadView';
import { useAgentController } from './useAgentController';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import styles from './AgentScreen.module.css';

const SIDEBARS_KEY = 'marifold.sidebars';
const ASSETS_KEY = 'marifold.assetsColumn';
const ASSETS_WIDTH_KEY = 'marifold.assetsWidth';
/** Where the Assets column fits beside the conversation; AgentScreen.module.css repeats it. */
const ASSETS_BESIDE_QUERY = '(min-width: 1100px)';

export interface AgentScreenProps {
  client: ApiClient;
  route: ChatRoute;
  appName?: string;
  navigate: (route: Route) => void;
  onUnauthorized: () => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onOpenConnection: () => void;
  onOpenSettings: () => void;
  connectionId: string;
  connectionName: string;
  workspaceView: WorkspaceView;
  onWorkspaceViewChange: (view: WorkspaceView) => void;
}

/** Responsive Agent and Projects workspace: desktop sidebar or mobile
 * navigation stack plus conversation. One screen per view (App keys it). */
export function AgentScreen(props: AgentScreenProps) {
  const controller = useAgentController(props);
  const projectView = props.route.view === 'projects';
  const routeOwner = props.route.view === 'projects' ? props.route.project : props.route.profile;
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  /** The project sheet: settings of `project`, else a new project (moving `moveSessionId` into it). */
  const [projectSheet, setProjectSheet] = useState<{ project?: ProjectDetail; moveSessionId?: string }>();
  const refreshProjects = useCallback(async () => {
    try { setProjects(await listProjects(props.client)); } catch { /* The list stays as it was. */ }
    finally { setProjectsLoading(false); }
  }, [props.client]);
  useEffect(() => { void refreshProjects(); }, [refreshProjects]);
  const deepAvailable = useDeepAvailable(props.client, controller.modelChoice, controller.profileDetail?.settings);
  const appsCatalog = useAppsCatalog(props.client, props.onUnauthorized, props.appName);
  const mobile = useMediaQuery(MOBILE_QUERY);
  const assetsBeside = useMediaQuery(ASSETS_BESIDE_QUERY);
  const [sidebarsHidden, setSidebarsHidden] = useState(
    () => localStorage.getItem(SIDEBARS_KEY) === 'hidden',
  );
  const [assetsShown, setAssetsShown] = useState(() => {
    try { return localStorage.getItem(ASSETS_KEY) !== 'hidden'; } catch { return true; }
  });
  // Narrower, the column covers the composer, so it opens only on request and closes on a press in the conversation.
  const [assetsOverlay, setAssetsOverlay] = useState(false);
  const [assetsSheetOpen, setAssetsSheetOpen] = useState(false);
  const [appBusy, setAppBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();
  const [scrollToBottomRequest, setScrollToBottomRequest] = useState(0);
  const [mobileConversationOpen, setMobileConversationOpen] = useState(() => props.route.session !== undefined);
  const [mobileAppOpen, setMobileAppOpen] = useState(false);
  const appsView = props.workspaceView === 'apps';
  const [appsMounted, setAppsMounted] = useState(appsView);
  const refreshInstalledApp = useCallback(async (): Promise<void> => {
    await appsCatalog.refresh();
  }, [appsCatalog.refresh]);

  useEffect(() => {
    if (appsView) { setAppsMounted(true); }
  }, [appsView]);

  useEffect(() => {
    if (!appsView || !appsCatalog.selectedName || props.appName === appsCatalog.selectedName) { return; }
    props.navigate({ view: 'apps', app: appsCatalog.selectedName });
  }, [appsCatalog.selectedName, appsView, props.appName, props.navigate]);

  useEffect(() => {
    if (!routeOwner) { setMobileConversationOpen(false); }
    else if (props.route.session) { setMobileConversationOpen(true); }
  }, [routeOwner, props.route.session]);

  async function submitCreateProfile(input: CreateProfileInput): Promise<void> {
    setCreateBusy(true);
    setCreateError(undefined);
    try {
      await createProfileWithSetup(props.client, input);
      await controller.refreshProfiles();
      setCreateOpen(false);
      controller.selectProfile(input.name); // start chatting with the new profile
    } catch (error) {
      // The scaffold may have landed before a follow-up failed — refresh so
      // the sidebar reflects reality either way.
      await controller.refreshProfiles();
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreateBusy(false);
    }
  }

  function toggleSidebars(): void {
    setSidebarsHidden(hidden => {
      localStorage.setItem(SIDEBARS_KEY, hidden ? 'shown' : 'hidden');
      return !hidden;
    });
  }

  function toggleAssets(): void {
    if (!assetsBeside) {
      setAssetsOverlay(open => !open);
      return;
    }
    setAssetsShown(shown => {
      try { localStorage.setItem(ASSETS_KEY, shown ? 'hidden' : 'shown'); } catch { /* Shown or hidden for this page only. */ }
      return !shown;
    });
  }

  function onDragOver(event: React.DragEvent): void {
    if (![...event.dataTransfer.types].includes('Files')) { return; }
    event.preventDefault();
    setDropActive(true);
  }

  function onDrop(event: React.DragEvent): void {
    if (![...event.dataTransfer.types].includes('Files')) { return; }
    event.preventDefault();
    setDropActive(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) { void controller.addFiles(files); }
  }

  const workingProfiles = useMemo(() => {
    const names = new Set<string>();
    if (controller.steeringRun && controller.profileName) { names.add(controller.profileName); }
    return names;
  }, [controller.steeringRun, controller.profileName]);

  // A route naming a profile that isn't listed (deleted, renamed, or mistyped).
  // An empty list means it failed to load (`default` is always listed).
  const missingProfile = controller.profileName !== undefined && !controller.profilesLoading && controller.profiles.length > 0
    && !controller.profiles.some(profile => profile.name === controller.profileName);
  const openProfile = missingProfile ? undefined : controller.profileName;
  const { project } = controller;
  // A conversation is open once its profile, or its project, is known.
  const conversationOpen = projectView ? project !== undefined : openProfile !== undefined;
  const currentSession = controller.sessions.find(session => session.id === controller.sessionId);
  const sessionArchived = currentSession?.archived === true;
  const projectConversation = !appsView && conversationOpen ? project : undefined;
  const assetsColumn = assetsBeside ? assetsShown : assetsOverlay;
  const assetsProps = project ? {
    client: props.client,
    projectId: project.id,
    ...(controller.sessionId ? { sessionId: controller.sessionId } : {}),
    responding: controller.responding,
    limitBytes: project.assetLimitBytes,
    onOpenSettings: () => setProjectSheet({ project }),
  } : undefined;
  const mobileWorkspaceOpen = appsView
    ? mobileAppOpen && appsCatalog.selectedName !== undefined
    : routeOwner !== undefined && controller.profileName !== undefined && mobileConversationOpen;
  const profileNames = useMemo(() => controller.profiles.map(profile => profile.name), [controller.profiles]);
  const profileSuggestion = (name: string) => ({
    name,
    usage: `@${name}`,
    description: `${controller.profiles.find(profile => profile.name === name)?.displayName ?? name}${name === project?.lead ? ' · Lead' : ''}`,
  });
  const sidebarFooter = mobile ? (
    <MobileWorkspaceNavigation
      active={appsView ? 'apps' : projectView ? 'projects' : 'agent'}
      theme={props.theme}
      connectionName={props.connectionName}
      onAgent={() => {
        if (props.workspaceView !== 'agent') { props.onWorkspaceViewChange('agent'); }
      }}
      onProjects={() => {
        if (props.workspaceView !== 'projects') { props.onWorkspaceViewChange('projects'); }
      }}
      onApps={() => {
        setMobileAppOpen(false);
        if (!appsView) { props.onWorkspaceViewChange('apps'); }
      }}
      onOpenConnection={props.onOpenConnection}
      onThemeChange={props.onThemeChange}
      onOpenSettings={props.onOpenSettings}
    />
  ) : (
    <SidebarSystemFooter
      theme={props.theme}
      onThemeChange={props.onThemeChange}
      onOpenConnection={props.onOpenConnection}
      onOpenSettings={props.onOpenSettings}
      connectionName={props.connectionName}
    />
  );

  const navigation = (
    <WorkspaceSidebar
      ariaLabel={appsView ? 'Apps' : conversationOpen ? 'Sessions' : projectView ? 'Projects' : 'Profiles'}
      footer={sidebarFooter}
      showBrand={appsView || !conversationOpen}
    >
      {appsView ? (
        <AppsSidebarContent
          client={props.client}
          apps={appsCatalog.apps}
          invalidApps={appsCatalog.invalidApps}
          selected={appsCatalog.selectedName}
          busy={appBusy}
          loading={appsCatalog.loading}
          onSelect={name => {
            props.navigate({ view: 'apps', app: name });
            setMobileAppOpen(true);
          }}
        />
      ) : projectView && project ? (
        <SessionListContent
          sessions={controller.sessions}
          loading={controller.sessionsLoading}
          selected={controller.sessionId}
          profileName={project.name}
          profileAvatar={<ProjectIcon client={props.client} id={project.id} hasIcon={project.icon !== undefined} size={64} />}
          configureLabel={`Project settings for ${project.name}`}
          backTo="projects"
          rowAccessory={session => (
            <ProfileStack
              client={props.client}
              names={session.speakers ?? []}
              profiles={controller.profiles}
              inactive={name => !project.members.includes(name)}
            />
          )}
          headerAccessory={mobile && assetsProps ? <ProjectAssets {...assetsProps} variant="list" /> : undefined}
          search={controller.sessionSearch}
          onSearchChange={controller.setSessionSearch}
          showArchived={controller.showArchivedSessions}
          onShowArchivedChange={controller.setShowArchivedSessions}
          runningSessionIds={controller.runningSessionIds}
          onSelect={id => {
            setMobileConversationOpen(true);
            controller.selectSession(id);
          }}
          onNew={() => {
            setMobileConversationOpen(true);
            controller.newSession();
          }}
          onBack={controller.showProfiles}
          onConfigureProfile={() => setProjectSheet({ project })}
          onRename={controller.renameSession}
          onSetPinned={controller.setSessionPinned}
          onSetArchived={controller.setSessionArchived}
          onDelete={controller.deleteSession}
        />
      ) : projectView ? (
        <ProjectSidebarContent
          client={props.client}
          projects={projects}
          loading={projectsLoading}
          selected={props.route.view === 'projects' ? props.route.project : undefined}
          onSelect={id => {
            setMobileConversationOpen(false);
            controller.selectProject(id);
          }}
          onCreate={() => setProjectSheet({})}
        />
      ) : openProfile ? (
        <SessionListContent
          sessions={controller.sessions}
          loading={controller.sessionsLoading}
          selected={controller.sessionId}
          profileName={openProfile}
          profileDisplayName={controller.profileDetail?.displayName}
          profileAvatar={(
            <Avatar
              client={props.client}
              name={openProfile}
              label={controller.profileDetail?.displayName}
              hasAvatar={controller.profiles.some(
                profile => profile.name === controller.profileName && profile.avatar !== undefined,
              )}
              size={64}
            />
          )}
          search={controller.sessionSearch}
          onSearchChange={controller.setSessionSearch}
          showArchived={controller.showArchivedSessions}
          onShowArchivedChange={controller.setShowArchivedSessions}
          runningSessionIds={controller.runningSessionIds}
          onSelect={id => {
            setMobileConversationOpen(true);
            controller.selectSession(id);
          }}
          onNew={() => {
            setMobileConversationOpen(true);
            controller.newSession();
          }}
          onBack={controller.showProfiles}
          onConfigureProfile={() => props.navigate({
            view: 'config',
            section: 'profiles',
            item: controller.profileName,
          })}
          onRename={controller.renameSession}
          onSetPinned={controller.setSessionPinned}
          onSetArchived={controller.setSessionArchived}
          onDelete={controller.deleteSession}
          moveTargets={projects.map(candidate => ({
            id: candidate.id,
            name: candidate.name,
            icon: <ProjectIcon client={props.client} id={candidate.id} hasIcon={candidate.icon !== undefined} size={18} />,
          }))}
          onMoveToProject={async (id, projectId) => {
            const moved = await controller.moveSession(id, projectId);
            if (moved) { void refreshProjects(); }
            return moved;
          }}
          onMoveToNewProject={id => setProjectSheet({ moveSessionId: id })}
        />
      ) : (
        <ProfileSidebarContent
          client={props.client}
          profiles={controller.profiles}
          loading={controller.profilesLoading}
          selected={openProfile}
          workingProfiles={workingProfiles}
          onSelect={name => {
            setMobileConversationOpen(false);
            controller.selectProfile(name);
          }}
          onSetPinned={controller.setProfilePinned}
          onConfigure={name => props.navigate({
            view: 'config',
            section: 'profiles',
            item: name,
          })}
          onCreate={() => {
            setCreateError(undefined);
            setCreateOpen(true);
          }}
        />
      )}
    </WorkspaceSidebar>
  );

  return (
    <div className={styles.layout}>
      {mobile ? (
        mobileWorkspaceOpen ? null : <div className={styles.mobileNavigation}>{navigation}</div>
      ) : sidebarsHidden ? null : (
        <ResizableSidebar>{navigation}</ResizableSidebar>
      )}
      <div
        className={styles.threadPane}
        hidden={mobile && !mobileWorkspaceOpen}
        onDragOver={appsView ? undefined : onDragOver}
        onDragLeave={() => setDropActive(false)}
        onDrop={appsView ? undefined : onDrop}
      >
        {!appsView && dropActive ? (
          <div className={styles.dropOverlay} aria-hidden>
            Drop to attach
          </div>
        ) : null}
        {mobile ? (
          <MobileNavigationBar
            title={appsView
              ? appsCatalog.selected?.app.title ?? appsCatalog.selectedInvalid?.name ?? 'Apps'
              : currentSession ? sessionTitle(currentSession) : 'New session'}
            backLabel={appsView ? 'Apps' : 'Sessions'}
            trailing={projectConversation ? <AssetsSheetButton onOpen={() => setAssetsSheetOpen(true)} /> : undefined}
            onBack={() => {
              if (appsView) { setMobileAppOpen(false); }
              else {
                setMobileConversationOpen(false);
                if (routeOwner && props.route.session) {
                  props.navigate(props.route.view === 'projects' ? { view: 'projects', project: routeOwner } : { view: 'agent', profile: routeOwner });
                }
              }
            }}
          />
        ) : (
          <ThreadHeader
            sessionTitle={appsView
              ? 'Apps'
              : conversationOpen
                ? (currentSession ? sessionTitle(currentSession) : 'New session')
                : projectView ? 'Projects' : 'Profiles'}
            sidebarsHidden={sidebarsHidden}
            onToggleSidebars={toggleSidebars}
            view={props.workspaceView}
            onViewChange={props.onWorkspaceViewChange}
            trailing={projectConversation ? <AssetsToggle shown={assetsColumn} onToggle={toggleAssets} /> : undefined}
          />
        )}
        {appsMounted ? (
          <div className={styles.appsPane} hidden={!appsView}>
            <AppsScreen
              client={props.client}
              onUnauthorized={props.onUnauthorized}
              app={appsCatalog.selected}
              invalidApp={appsCatalog.selectedInvalid}
              loading={appsCatalog.loading}
              loadError={appsCatalog.error}
              onBusyChange={setAppBusy}
              onAppInstalled={refreshInstalledApp}
            />
          </div>
        ) : null}
        {!appsView && conversationOpen ? (
          <div className={styles.conversationRow}>
            <div className={styles.conversation} onPointerDown={!assetsBeside && assetsOverlay ? () => setAssetsOverlay(false) : undefined}>
              <CatchUpBanner
                runs={controller.thread.catchUp}
                onShow={controller.expandCatchUp}
                onDismiss={controller.dismissCatchUp}
              />
              <ThreadView
                client={props.client}
                key={controller.sessionId ?? 'new-session'}
                items={controller.thread.items}
                loading={controller.sessionLoading}
                scrollToBottomRequest={scrollToBottomRequest}
                onCancelRun={runId => void controller.cancel(runId)}
                onAnswerApproval={(runId, requestId, action, sudoResponse) => void controller.answer(runId, requestId, action, sudoResponse)}
                onSubmitUserInput={(runId, requestId, submission) => void controller.answerInput(runId, requestId, submission)}
                onToggleRun={controller.toggleRun}
                onEditUserMessage={controller.resendEdited}
                editingDisabled={controller.steeringRun !== undefined || controller.sending}
                sendingBytes={controller.sendingBytes}
                {...(project ? {
                  renderSpeaker: (name: string) => (
                    <ProfileLabel client={props.client} name={name} profiles={controller.profiles} inactive={!project.members.includes(name)} />
                  ),
                  defaultSpeaker: currentSession?.profileName,
                } : {})}
              />
              {controller.sessionBlocked && controller.sessionId ? (
                <SessionBlockedBanner onTakeOver={controller.takeOverSession} />
              ) : null}
              {sessionArchived && controller.sessionId ? (
                <SessionArchivedBanner onUnarchive={() => controller.setSessionArchived(controller.sessionId!, false)} />
              ) : null}
              <InputBar
                draftKey={`${props.connectionId}:${project ? `project:${project.id}` : controller.profileName}:${controller.sessionId ?? 'new'}`}
                steering={controller.steeringRun !== undefined}
                responding={controller.responding}
                disabled={controller.sending || controller.sessionLoading || controller.sessionBlocked || sessionArchived}
                deep={controller.deep}
                deepAvailable={deepAvailable}
                onToggleDeep={() => controller.setDeep(!controller.deep)}
                modelOptions={controller.modelOptions}
                modelChoice={controller.modelChoice}
                onSelectModel={controller.setModelChoice}
                attachments={controller.attachments}
                onAttachFiles={files => void controller.addFiles(files)}
                onRemoveAttachment={controller.removeAttachment}
                skills={controller.skills}
                devices={controller.devices}
                {...(project ? {
                  mentions: (text: string) => {
                    const only = commandProfiles(text, project, profileNames);
                    return only ? only.map(profileSuggestion) : [...project.members.map(profileSuggestion), ...controller.devices];
                  },
                  commands: [...WEB_COMMANDS, ...PROJECT_COMMANDS],
                  // A `/command` is not a message: nothing routes it.
                  recipient: (text: string) => parseCommand(text) ? undefined : previewProjectRoute(text, project, controller.floor, profileNames),
                  onInvite: (name: string) => void controller.inviteToProject(name),
                } : {})}
                enterSubmits={!mobile}
                onSubmit={text => {
                  setScrollToBottomRequest(request => request + 1);
                  void controller.send(text);
                }}
                onStop={() => void controller.stop()}
              />
            </div>
            {!mobile && assetsColumn && assetsProps ? (
              assetsBeside ? (
                <ResizableSidebar side="right" storageKey={ASSETS_WIDTH_KEY} defaultWidth={316} minWidth={280} ariaLabel="Resize project assets">
                  <aside className={styles.assetsColumn} aria-label="Project assets">
                    <ProjectAssets {...assetsProps} variant="column" />
                  </aside>
                </ResizableSidebar>
              ) : (
                <aside className={styles.assetsOverlay} aria-label="Project assets">
                  <ProjectAssets {...assetsProps} variant="column" />
                </aside>
              )
            ) : null}
          </div>
        ) : !appsView && projectView && controller.projectMissing ? (
          <div className={styles.chooseProfile}>
            <div className={styles.chooseTitle}>This project doesn’t exist</div>
            <div className={styles.chooseHint}>It may have been deleted. Choose another project.</div>
            <button type="button" className={styles.chooseAction} onClick={controller.showProfiles}>Back to projects</button>
          </div>
        ) : !appsView && projectView ? (
          <div className={styles.chooseProfile}>
            <div className={styles.chooseTitle}>{routeOwner ? 'Opening project…' : 'Choose a project'}</div>
            <div className={styles.chooseHint}>A project gathers sessions, instructions, and the profiles working on them. Address a profile with @name.</div>
          </div>
        ) : !appsView && missingProfile ? (
          <div className={styles.chooseProfile}>
            <div className={styles.chooseTitle}>Profile “{controller.profileName}” doesn’t exist</div>
            <div className={styles.chooseHint}>It may have been renamed or deleted. Choose another profile.</div>
            <button type="button" className={styles.chooseAction} onClick={controller.showProfiles}>Back to profiles</button>
          </div>
        ) : !appsView ? (
          <div className={styles.chooseProfile}>
            <div className={styles.chooseTitle}>Choose a profile</div>
            <div className={styles.chooseHint}>Profiles keep their own instructions, sessions, skills, and memories.</div>
          </div>
        ) : null}
      </div>
      {assetsSheetOpen && mobile && projectConversation && assetsProps ? (
        <ProjectAssetsSheet {...assetsProps} projectName={projectConversation.name} onClose={() => setAssetsSheetOpen(false)} />
      ) : null}
      {projectSheet ? (
        <ProjectSheet
          client={props.client}
          project={projectSheet.project}
          profiles={controller.profiles}
          onClose={() => setProjectSheet(undefined)}
          onSaved={saved => {
            const moving = projectSheet.moveSessionId;
            setProjectSheet(undefined);
            void refreshProjects();
            if (moving) { void controller.moveSession(moving, saved.id).then(() => refreshProjects()); }
            else if (projectSheet.project) { void controller.refreshProject(); }
            else { controller.selectProject(saved.id); }
          }}
          onDeleted={() => {
            setProjectSheet(undefined);
            void refreshProjects();
            controller.showProfiles();
          }}
        />
      ) : null}
      {createOpen ? (
        <CreateProfileSheet
          existingNames={controller.profiles.map(profile => profile.name)}
          modelOptions={controller.modelOptions}
          busy={createBusy}
          error={createError}
          onSubmit={input => void submitCreateProfile(input)}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </div>
  );
}
