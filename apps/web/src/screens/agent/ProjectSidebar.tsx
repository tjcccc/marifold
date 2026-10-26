import { useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import { ProjectIcon } from '../../components/ProjectIcon';
import { formatRelativeTime } from '../../lib/format';
import { SidebarLoading } from './SidebarLoading';
import styles from './ProfileSidebar.module.css';

export interface ProjectSidebarContentProps {
  client: ApiClient;
  projects: ProjectSummary[];
  loading?: boolean;
  selected?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

/** The Projects view's first level: every project, by name. Choosing one
 * drills down to its sessions, like a profile. */
export function ProjectSidebarContent({ client, projects, loading = false, selected, onSelect, onCreate }: ProjectSidebarContentProps) {
  const [search, setSearch] = useState('');
  const shown = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return term ? projects.filter(project => project.name.toLocaleLowerCase().includes(term)) : projects;
  }, [projects, search]);

  return (
    <>
      <div className={styles.searchWrap}>
        <input
          className={styles.searchInput}
          type="search"
          placeholder="Search projects"
          aria-label="Search projects"
          autoComplete="off"
          value={search}
          onChange={event => setSearch(event.target.value)}
          onKeyDown={event => { if (event.key === 'Escape' && search) { setSearch(''); } }}
        />
      </div>
      <div className={styles.header}>
        <span>Projects</span>
        <button className={styles.newButton} onClick={onCreate} title="New project" aria-label="New project">+</button>
      </div>
      <div className={styles.list} aria-busy={loading}>
        {loading ? <SidebarLoading label="Loading projects…" /> : null}
        {!loading && shown.length === 0 ? (
          <div className={styles.empty} role="status">
            {projects.length === 0 ? 'No projects yet. A project gathers sessions, instructions, and the profiles working on them.' : 'No matching projects.'}
          </div>
        ) : null}
        {shown.map(project => (
          <div key={project.id} className={project.id === selected ? styles.rowSelected : styles.row}>
            <button className={styles.rowMain} onClick={() => onSelect(project.id)}>
              <ProjectIcon client={client} id={project.id} hasIcon={project.icon !== undefined} size={40} />
              <span className={styles.meta}>
                <span className={styles.nameLine}>
                  <span className={styles.name}>{project.name}</span>
                  <time className={styles.activityTime} dateTime={project.updatedAt} title={new Date(project.updatedAt).toLocaleString()}>
                    {formatRelativeTime(project.updatedAt)}
                  </time>
                </span>
                <span className={styles.sub}>
                  {`${project.sessionCount} ${project.sessionCount === 1 ? 'session' : 'sessions'} · ${project.members.length} ${project.members.length === 1 ? 'profile' : 'profiles'}`}
                </span>
              </span>
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
