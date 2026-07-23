import { useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { CreateProfileInput } from '../../api/profiles';
import { createProfileWithSetup } from '../../api/profiles';
import { Avatar } from '../../components/Avatar';
import { CreateProfileSheet } from '../../components/CreateProfileSheet';
import { ResizableSidebar } from '../../components/ResizableSidebar';
import { SidebarSystemFooter } from '../../components/SidebarChrome';
import type { WorkspaceView } from '../../components/WorkspaceTabs';
import type { Route } from '../../lib/route';
import type { ThemePreference } from '../../theme/theme';
import { AppsScreen } from '../apps/AppsScreen';
import { CatchUpBanner } from './CatchUpBanner';
import { InputBar } from './InputBar';
import { ProfileSidebar } from './ProfileSidebar';
import { SessionList, sessionTitle } from './SessionList';
import { ThreadHeader } from './ThreadHeader';
import { ThreadView } from './ThreadView';
import { useAgentController } from './useAgentController';
import styles from './AgentScreen.module.css';

const SIDEBARS_KEY = 'marifold.sidebars';

export interface AgentScreenProps {
  client: ApiClient;
  route: Extract<Route, { view: 'agent' }>;
  workspaceView: WorkspaceView;
  navigate: (route: Route) => void;
  onUnauthorized: () => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onOpenConnection: () => void;
  onOpenSettings: () => void;
  onWorkspaceViewChange: (view: WorkspaceView) => void;
}

/** Desktop Agent workspace: one navigation-stack sidebar plus conversation. */
export function AgentScreen(props: AgentScreenProps) {
  const controller = useAgentController(props);
  const [sidebarsHidden, setSidebarsHidden] = useState(
    () => localStorage.getItem(SIDEBARS_KEY) === 'hidden',
  );
  const [dropActive, setDropActive] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();
  const [scrollToBottomRequest, setScrollToBottomRequest] = useState(0);

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
  const sidebarFooter = (
    <SidebarSystemFooter
      theme={props.theme}
      onThemeChange={props.onThemeChange}
      onOpenConnection={props.onOpenConnection}
      onOpenSettings={props.onOpenSettings}
    />
  );

  return (
    <div className={styles.layout}>
      {sidebarsHidden ? null : (
        <ResizableSidebar>
          {controller.profileName ? (
            <SessionList
              sessions={controller.sessions}
              selected={controller.sessionId}
              profileName={controller.profileName}
              profileAvatar={(
                <Avatar
                  client={props.client}
                  name={controller.profileName}
                  hasAvatar={controller.profiles.some(
                    profile => profile.name === controller.profileName && profile.avatar !== undefined,
                  )}
                  size={64}
                />
              )}
              onSelect={controller.selectSession}
              onNew={controller.newSession}
              onBack={controller.showProfiles}
              onRename={controller.renameSession}
              onSetPinned={controller.setSessionPinned}
              onDelete={controller.deleteSession}
              footer={sidebarFooter}
            />
          ) : (
            <ProfileSidebar
              client={props.client}
              profiles={controller.profiles}
              selected={controller.profileName}
              workingProfiles={workingProfiles}
              onSelect={controller.selectProfile}
              onCreate={() => {
                setCreateError(undefined);
                setCreateOpen(true);
              }}
              footer={sidebarFooter}
            />
          )}
        </ResizableSidebar>
      )}
      <div
        className={styles.threadPane}
        onDragOver={props.workspaceView === 'agent' ? onDragOver : undefined}
        onDragLeave={props.workspaceView === 'agent' ? () => setDropActive(false) : undefined}
        onDrop={props.workspaceView === 'agent' ? onDrop : undefined}
      >
        {dropActive ? (
          <div className={styles.dropOverlay} aria-hidden>
            Drop to attach
          </div>
        ) : null}
        <ThreadHeader
          sessionTitle={props.workspaceView === 'apps'
            ? 'Apps'
            : controller.profileName
              ? (currentSession ? sessionTitle(currentSession) : 'New session')
              : 'Profiles'}
          sidebarsHidden={sidebarsHidden}
          onToggleSidebars={toggleSidebars}
          view={props.workspaceView}
          onViewChange={props.onWorkspaceViewChange}
        />
        {props.workspaceView === 'apps' ? (
          <AppsScreen profileName={controller.profileName} />
        ) : controller.profileName ? (
          <>
            <CatchUpBanner
              runs={controller.thread.catchUp}
              onShow={controller.expandCatchUp}
              onDismiss={controller.dismissCatchUp}
            />
            <ThreadView
              key={controller.sessionId ?? 'new-session'}
              items={controller.thread.items}
              scrollToBottomRequest={scrollToBottomRequest}
              onCancelRun={runId => void controller.cancel(runId)}
              onAnswerApproval={(runId, requestId, action) => void controller.answer(runId, requestId, action)}
              onToggleRun={controller.toggleRun}
              onEditUserMessage={controller.resendEdited}
              editingDisabled={controller.steeringRun !== undefined || controller.sending}
            />
            <InputBar
              steering={controller.steeringRun !== undefined}
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
            />
          </>
        ) : (
          <div className={styles.chooseProfile}>
            <div className={styles.chooseTitle}>Choose a profile</div>
            <div className={styles.chooseHint}>Profiles keep their own instructions, sessions, skills, and memories.</div>
          </div>
        )}
      </div>
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
