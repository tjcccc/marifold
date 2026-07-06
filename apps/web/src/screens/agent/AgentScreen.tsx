import { useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
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
            profiles={controller.profiles}
            selected={controller.profileName}
            workingProfiles={workingProfiles}
            onSelect={controller.selectProfile}
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
          onSubmit={text => void controller.send(text)}
        />
      </div>
    </div>
  );
}
