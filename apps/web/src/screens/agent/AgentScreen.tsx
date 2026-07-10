import { useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { CreateProfileInput } from '../../api/profiles';
import { createProfileWithSetup } from '../../api/profiles';
import { Avatar } from '../../components/Avatar';
import { CreateProfileSheet } from '../../components/CreateProfileSheet';
import type { Route } from '../../lib/hashRoute';
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
  navigate: (route: Route) => void;
  onUnauthorized: () => void;
}

/** The 3-pane Agent view: profiles → sessions → conversation (design 1a). */
export function AgentScreen(props: AgentScreenProps) {
  const controller = useAgentController(props);
  const [sidebarsHidden, setSidebarsHidden] = useState(
    () => localStorage.getItem(SIDEBARS_KEY) === 'hidden',
  );
  const [dropActive, setDropActive] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();

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

  return (
    <div className={styles.layout}>
      {sidebarsHidden ? null : (
        <>
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
          />
          <SessionList
            sessions={controller.sessions}
            selected={controller.sessionId}
            onSelect={controller.selectSession}
            onNew={controller.newSession}
          />
        </>
      )}
      <div
        className={styles.threadPane}
        onDragOver={onDragOver}
        onDragLeave={() => setDropActive(false)}
        onDrop={onDrop}
      >
        {dropActive ? (
          <div className={styles.dropOverlay} aria-hidden>
            Drop to attach
          </div>
        ) : null}
        <ThreadHeader
          profileName={controller.profileName}
          profileMode={controller.profileDetail?.settings.mode ?? 'agent'}
          sessionTitle={currentSession ? sessionTitle(currentSession) : 'New session'}
          avatar={
            controller.profileName ? (
              <Avatar
                client={props.client}
                name={controller.profileName}
                hasAvatar={controller.profiles.some(
                  profile => profile.name === controller.profileName && profile.avatar !== undefined,
                )}
                size={26}
              />
            ) : undefined
          }
          sidebarsHidden={sidebarsHidden}
          onToggleSidebars={toggleSidebars}
        />
        <CatchUpBanner
          runs={controller.thread.catchUp}
          onShow={controller.expandCatchUp}
          onDismiss={controller.dismissCatchUp}
        />
        <ThreadView
          items={controller.thread.items}
          onCancelRun={runId => void controller.cancel(runId)}
          onAnswerApproval={(runId, requestId, action) => void controller.answer(runId, requestId, action)}
          onToggleRun={controller.toggleRun}
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
          onSubmit={text => void controller.send(text)}
        />
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
