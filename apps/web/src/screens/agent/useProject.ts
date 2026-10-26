import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { MarifoldApiError } from '../../api/client';
import { getProject } from '../../api/projects';
import type { ProjectDetail } from '../../api/types';

export interface ProjectState {
  /** The selected project once loaded; undefined while loading or outside projects. */
  project?: ProjectDetail;
  /** The route names a project that does not exist (deleted, or a stale link). */
  missing: boolean;
  setProject: (project: ProjectDetail) => void;
  refresh: () => Promise<void>;
}

/** The project a Projects route selects, reloaded when the route changes. */
export function useProject(client: ApiClient, projectId: string | undefined): ProjectState {
  const [project, setProject] = useState<ProjectDetail>();
  const [missing, setMissing] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) { return; }
    try {
      setProject(await getProject(client, projectId));
      setMissing(false);
    } catch (error) {
      if (error instanceof MarifoldApiError && error.code === 'PROJECT_NOT_FOUND') { setMissing(true); }
      // Other failures keep what is shown; the next change or action retries.
    }
  }, [client, projectId]);

  useEffect(() => {
    setProject(undefined);
    setMissing(false);
    void refresh();
  }, [refresh]);

  return { project: project?.id === projectId ? project : undefined, missing, setProject, refresh };
}
