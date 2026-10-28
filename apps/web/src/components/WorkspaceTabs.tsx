import { SegmentedControl } from './SegmentedControl';

export type WorkspaceView = 'agent' | 'projects' | 'apps' | 'artifacts';

const WORKSPACE_VIEWS = [
  { id: 'agent', label: 'Agent' },
  { id: 'projects', label: 'Projects' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'apps', label: 'Apps' },
] as const;

export interface WorkspaceTabsProps {
  view: WorkspaceView;
  onChange: (view: WorkspaceView) => void;
}

/** The profile workspace switch. Settings intentionally lives in sidebar chrome. */
export function WorkspaceTabs({ view, onChange }: WorkspaceTabsProps) {
  return (
    <SegmentedControl
      options={WORKSPACE_VIEWS}
      value={view}
      onChange={onChange}
      aria-label="Workspace"
    />
  );
}
