import type { MarifoldAgentConfig, MemoryEntry, ProfileDetail } from '../../api/types';
import { formatRelativeTime } from '../../lib/format';
import { resolveEffectivePermissions, TOOL_KIND_LABELS, TOOL_KINDS } from '../../lib/permissions';
import styles from './ProfileSettingsPage.module.css';

export interface ProfileSettingsPageProps {
  detail: ProfileDetail;
  memories: MemoryEntry[];
  globalAgent?: MarifoldAgentConfig;
}

/** Apple-Settings-style grouped page for one profile (design 1d). Read-only
 * this milestone — the segmented controls show the resolved values inert. */
export function ProfileSettingsPage({ detail, memories, globalAgent }: ProfileSettingsPageProps) {
  const effective = resolveEffectivePermissions(globalAgent, detail.settings.agent);
  const active = memories.filter(entry => entry.status === 'active');

  return (
    <div className={styles.page}>
      <header className={styles.identity}>
        <span className={styles.avatar} aria-hidden>
          {detail.name.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <div className={styles.name}>{detail.name}</div>
          <div className={styles.identitySub}>
            {detail.source} profile · mode {detail.settings.mode ?? 'agent'}
            {detail.settings.think ? ' · thinking on' : ''}
          </div>
        </div>
      </header>

      <section className={styles.group} aria-label="Model">
        <div className={styles.groupTitle}>Model</div>
        <div className={styles.card}>
          <div className={styles.rowLine}>
            <span className={styles.rowLabel}>Model</span>
            <span className={styles.rowValue}>
              {detail.settings.provider && detail.settings.model
                ? `${detail.settings.provider}/${detail.settings.model}`
                : 'Default'}
            </span>
          </div>
          <div className={styles.rowLine}>
            <span className={styles.rowLabel}>Memories</span>
            <span className={styles.rowValue}>{detail.settings.memories ? 'On' : 'Off'}</span>
          </div>
        </div>
      </section>

      <section className={styles.group} aria-label="Memory">
        <div className={styles.groupTitle}>Memory</div>
        <div className={styles.card}>
          {active.length === 0 ? <div className={styles.emptyRow}>Nothing remembered yet.</div> : null}
          {active.map(entry => (
            <div key={entry.id} className={styles.memoryRow}>
              <div className={styles.memoryText}>{entry.text}</div>
              <div className={styles.memoryMeta}>
                {entry.kind} · p{entry.priority} · {formatRelativeTime(entry.updated_at)}
              </div>
            </div>
          ))}
        </div>
        <div className={styles.groupHint}>Review what the agent remembers. Editing arrives with the next milestone.</div>
      </section>

      <section className={styles.group} aria-label="Agent permissions">
        <div className={styles.groupTitle}>Agent permissions</div>
        <div className={styles.card}>
          {TOOL_KINDS.map(kind => (
            <div key={kind} className={styles.rowLine}>
              <span className={styles.rowLabel}>{TOOL_KIND_LABELS[kind]}</span>
              <span className={styles.segments}>
                {(['allow', 'ask', 'deny'] as const).map(mode => (
                  <span
                    key={mode}
                    className={effective.approval[kind] === mode ? styles.segmentSelected : styles.segment}
                  >
                    {mode[0].toUpperCase() + mode.slice(1)}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
        {effective.trustedFolders.length > 0 ? (
          <div className={styles.card}>
            <div className={styles.rowLine}>
              <span className={styles.rowLabel}>Trusted folders</span>
            </div>
            {effective.trustedFolders.map(folder => (
              <div key={folder} className={styles.folderRow}>
                <code>{folder}</code>
              </div>
            ))}
          </div>
        ) : null}
        <div className={styles.groupHint}>The agent still narrates everything it does.</div>
      </section>

      <section className={styles.group} aria-label="Instructions">
        <div className={styles.groupTitle}>Instructions</div>
        {(
          [
            ['PROFILE', detail.files.profile.content],
            ['RULES', detail.files.rules.content],
            ['CUSTOM', detail.files.custom.content],
          ] as const
        ).map(([label, content]) => (
          <details key={label} className={styles.fileBlock}>
            <summary className={styles.fileSummary}>{label}</summary>
            <pre className={styles.fileContent}>{content.trim() || '(empty)'}</pre>
          </details>
        ))}
      </section>
    </div>
  );
}
