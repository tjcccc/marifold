import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { CreateProfileInput } from '../../api/profiles';
import { createProfileWithSetup } from '../../api/profiles';
import { Avatar } from '../../components/Avatar';
import { CreateProfileSheet } from '../../components/CreateProfileSheet';
import { MobileNavigationBar } from '../../components/MobileNavigationBar';
import { MobileWorkspaceNavigation } from '../../components/MobileWorkspaceNavigation';
import { ResizableSidebar } from '../../components/ResizableSidebar';
import { SidebarSystemFooter } from '../../components/SidebarChrome';
import type { WorkspaceView } from '../../components/WorkspaceTabs';
import type { Route } from '../../lib/route';
import { useMediaQuery } from '../../lib/useMediaQuery';
import type { ThemePreference } from '../../theme/theme';
import { AppsScreen } from '../apps/AppsScreen';
import { AppsSidebarContent } from '../apps/AppsSidebar';
import { useAppsCatalog } from '../apps/useAppsCatalog';
import { CatchUpBanner } from './CatchUpBanner';
import { InputBar } from './InputBar';
import { ProfileSidebarContent } from './ProfileSidebar';
import { SessionListContent, sessionTitle } from './SessionList';
import { ThreadHeader } from './ThreadHeader';
import { ThreadView } from './ThreadView';
import { useAgentController } from './useAgentController';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import styles from './AgentScreen.module.css';

const SIDEBARS_KEY = 'marifold.sidebars';
const MOBILE_QUERY = '(max-width: 899px)';

export interface AgentScreenProps {
  client: ApiClient;
  route: Extract<Route, { view: 'agent' }>;
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

/** Responsive Agent workspace: desktop sidebar or mobile navigation stack plus conversation. */
export function AgentScreen(props: AgentScreenProps) {
  const controller = useAgentController(props);
  const appsCatalog = useAppsCatalog(props.client, props.onUnauthorized);
  const mobile = useMediaQuery(MOBILE_QUERY);
  const [sidebarsHidden, setSidebarsHidden] = useState(
    () => localStorage.getItem(SIDEBARS_KEY) === 'hidden',
  );
  const [appBusy, setAppBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();
  const [scrollToBottomRequest, setScrollToBottomRequest] = useState(0);
  const [mobileConversationOpen, setMobileConversationOpen] = useState(() => props.route.session !== undefined);
  const [mobileAppOpen, setMobileAppOpen] = useState(false);
  const appsView = props.workspaceView === 'apps';

  useEffect(() => {
    if (!props.route.profile) setMobileConversationOpen(false);
    else if (props.route.session) setMobileConversationOpen(true);
  }, [props.route.profile, props.route.session]);

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

  function onDragOver(event: React.DragEvent): void {
    if (![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    setDropActive(true);
  }

  function onDrop(event: React.DragEvent): void {
    if (![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    setDropActive(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) void controller.addFiles(files);
  }

  const workingProfiles = useMemo(() => {
    const names = new Set<string>();
    if (controller.steeringRun && controller.profileName) names.add(controller.profileName);
    return names;
  }, [controller.steeringRun, controller.profileName]);

  const currentSession = controller.sessions.find(session => session.id === controller.sessionId);
  const mobileWorkspaceOpen = appsView
    ? mobileAppOpen && appsCatalog.selected !== undefined
    : controller.profileName !== undefined && mobileConversationOpen;
  const sidebarFooter = mobile ? (
    <MobileWorkspaceNavigation
      active={appsView ? 'apps' : 'agent'}
      theme={props.theme}
      connectionName={props.connectionName}
      onAgent={() => {
        if (appsView) props.onWorkspaceViewChange('agent');
      }}
      onApps={() => {
        setMobileAppOpen(false);
        if (!appsView) props.onWorkspaceViewChange('apps');
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
      ariaLabel={appsView ? 'Apps' : controller.profileName ? 'Sessions' : 'Profiles'}
      footer={sidebarFooter}
      showBrand={appsView || !controller.profileName}
    >
      {appsView ? (
        <AppsSidebarContent
          client={props.client}
          apps={appsCatalog.apps}
          selected={appsCatalog.selectedName}
          busy={appBusy}
          loading={appsCatalog.loading}
          onSelect={name => {
            appsCatalog.select(name);
            setMobileAppOpen(true);
          }}
        />
      ) : controller.profileName ? (
        <SessionListContent
          sessions={controller.sessions}
          selected={controller.sessionId}
          profileName={controller.profileName}
          profileDisplayName={controller.profileDetail?.displayName}
          profileAvatar={(
            <Avatar
              client={props.client}
              name={controller.profileName}
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
        />
      ) : (
        <ProfileSidebarContent
          client={props.client}
          profiles={controller.profiles}
          selected={controller.profileName}
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
      {!mobile || mobileWorkspaceOpen ? <div
        className={styles.threadPane}
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
              ? appsCatalog.selected?.app.title ?? 'Apps'
              : currentSession ? sessionTitle(currentSession) : 'New session'}
            backLabel={appsView ? 'Apps' : 'Sessions'}
            onBack={() => {
              if (appsView) setMobileAppOpen(false);
              else {
                setMobileConversationOpen(false);
                if (controller.profileName && props.route.session) {
                  props.navigate({ view: 'agent', profile: controller.profileName });
                }
              }
            }}
          />
        ) : (
          <ThreadHeader
            sessionTitle={appsView
              ? 'Apps'
              : controller.profileName
                ? (currentSession ? sessionTitle(currentSession) : 'New session')
                : 'Profiles'}
            sidebarsHidden={sidebarsHidden}
            onToggleSidebars={toggleSidebars}
            view={props.workspaceView}
            onViewChange={props.onWorkspaceViewChange}
          />
        )}
        {appsView ? (
          <AppsScreen
            client={props.client}
            onUnauthorized={props.onUnauthorized}
            app={appsCatalog.selected}
            loading={appsCatalog.loading}
            loadError={appsCatalog.error}
            onBusyChange={setAppBusy}
          />
        ) : controller.profileName ? (
          <>
            <CatchUpBanner
              runs={controller.thread.catchUp}
              onShow={controller.expandCatchUp}
              onDismiss={controller.dismissCatchUp}
            />
            <ThreadView
              client={props.client}
              key={controller.sessionId ?? 'new-session'}
              items={controller.thread.items}
              scrollToBottomRequest={scrollToBottomRequest}
              onCancelRun={runId => void controller.cancel(runId)}
              onAnswerApproval={(runId, requestId, action) => void controller.answer(runId, requestId, action)}
              onSubmitUserInput={(runId, requestId, submission) => void controller.answerInput(runId, requestId, submission)}
              onToggleRun={controller.toggleRun}
              onEditUserMessage={controller.resendEdited}
              editingDisabled={controller.steeringRun !== undefined || controller.sending}
            />
            <InputBar
              draftKey={`${props.connectionId}:${controller.profileName}:${controller.sessionId ?? 'new'}`}
              steering={controller.steeringRun !== undefined}
              responding={controller.responding}
              disabled={controller.sending}
              think={controller.think}
              onToggleThink={() => controller.setThink(!controller.think)}
              modelOptions={controller.modelOptions}
              modelChoice={controller.modelChoice}
              onSelectModel={controller.setModelChoice}
              attachments={controller.attachments}
              onAttachFiles={files => void controller.addFiles(files)}
              onRemoveAttachment={controller.removeAttachment}
              skills={controller.skills}
              onSubmit={text => {
                setScrollToBottomRequest(request => request + 1);
                void controller.send(text);
              }}
              onStop={() => void controller.stop()}
            />
          </>
        ) : (
          <div className={styles.chooseProfile}>
            <div className={styles.chooseTitle}>Choose a profile</div>
            <div className={styles.chooseHint}>Profiles keep their own instructions, sessions, skills, and memories.</div>
          </div>
        )}
      </div> : null}
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
