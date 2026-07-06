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

  function toggleSidebars(): void {
    setSidebarsHidden(hidden => {
      localStorage.setItem(SIDEBARS_KEY, hidden ? 'shown' : 'hidden');
      return !hidden;
    });
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
      <div className={styles.threadPane}>
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
          onSubmit={text => void controller.send(text)}
        />
      </div>
    </div>
  );
}
