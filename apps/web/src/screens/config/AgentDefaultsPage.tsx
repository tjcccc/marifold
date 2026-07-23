import { useState } from 'react';
import type { ApprovalMode, MarifoldAgentConfig, ToolKind } from '../../api/types';
import styles from './SystemPages.module.css';

const APPROVAL_ROWS: Array<{ kind: ToolKind; label: string }> = [
  { kind: 'read', label: 'Read files' },
  { kind: 'write', label: 'Write & edit files' },
  { kind: 'shell', label: 'Run shell commands' },
  { kind: 'network', label: 'Search the web' },
  { kind: 'delegate', label: 'Ask another profile' },
];

const MODES: ApprovalMode[] = ['allow', 'ask', 'deny'];

export interface AgentDefaultsPageProps {
  agent?: MarifoldAgentConfig;
  busy: boolean;
  onSave: (key: string, value: string) => void;
}

/** Global defaults inherited by profiles that do not override a tool kind. */
export function AgentDefaultsPage({ agent, busy, onSave }: AgentDefaultsPageProps) {
  const [iterations, setIterations] = useState<string>();
  const [outputLimit, setOutputLimit] = useState<string>();

  if (!agent) return <div className={styles.empty}>Loading agent defaults…</div>;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <div className={styles.pageTitle}>Agent defaults</div>
          <div className={styles.pageSub}>Profiles inherit these permissions unless they define an override.</div>
        </div>
      </header>

      <section className={styles.card}>
        <div className={styles.cardTitle}>Approval policy</div>
        {APPROVAL_ROWS.map(row => (
          <div className={styles.fieldRow} key={row.kind}>
            <span className={styles.fieldLabel}>{row.label}</span>
            <div
              className={styles.segmented}
              role="radiogroup"
              aria-label={`${row.label} approval`}
            >
              {MODES.map(mode => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={agent.approval[row.kind] === mode}
                  className={agent.approval[row.kind] === mode ? styles.segmentActive : styles.segment}
                  disabled={busy}
                  onClick={() => onSave(`approval.${row.kind}`, mode)}
                >
                  {mode[0].toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>Execution</div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="agent-tool-mode">Tool-call mode</label>
          <select
            id="agent-tool-mode"
            className={styles.select}
            value={agent.toolMode}
            disabled={busy}
            onChange={event => onSave('tool_mode', event.target.value)}
          >
            <option value="auto">Auto</option>
            <option value="native">Native</option>
            <option value="control-block">Control block</option>
          </select>
        </div>
        <NumberSetting
          id="agent-max-iterations"
          label="Maximum iterations"
          value={iterations ?? String(agent.maxIterations)}
          changed={iterations !== undefined && iterations !== String(agent.maxIterations)}
          busy={busy}
          onChange={setIterations}
          onSave={() => {
            onSave('max_iterations', iterations ?? String(agent.maxIterations));
            setIterations(undefined);
          }}
        />
        <NumberSetting
          id="agent-tool-output-limit"
          label="Tool output limit"
          value={outputLimit ?? String(agent.toolOutputLimit)}
          changed={outputLimit !== undefined && outputLimit !== String(agent.toolOutputLimit)}
          busy={busy}
          onChange={setOutputLimit}
          onSave={() => {
            onSave('tool_output_limit', outputLimit ?? String(agent.toolOutputLimit));
            setOutputLimit(undefined);
          }}
        />
      </section>
    </div>
  );
}

function NumberSetting({
  id,
  label,
  value,
  changed,
  busy,
  onChange,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  changed: boolean;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className={styles.fieldRow}>
      <label className={styles.fieldLabel} htmlFor={id}>{label}</label>
      <div className={styles.fieldEdit}>
        <input
          id={id}
          className={styles.input}
          type="number"
          min={1}
          step={1}
          value={value}
          onChange={event => onChange(event.target.value)}
        />
        {changed ? (
          <button className={styles.saveAction} type="button" disabled={busy || Number(value) < 1} onClick={onSave}>
            Save
          </button>
        ) : null}
      </div>
    </div>
  );
}
