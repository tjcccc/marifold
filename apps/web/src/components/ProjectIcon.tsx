import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { fetchProjectIconBlob } from '../api/projects';
import styles from './ProjectIcon.module.css';

/** A project's icon image (fetched with auth like avatars), or a folder. */
export function ProjectIcon({ client, id, hasIcon, size = 32, version = 0 }: { client: ApiClient; id: string; hasIcon: boolean; size?: number; version?: number }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!hasIcon) {
      setUrl(undefined);
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    void fetchProjectIconBlob(client, id).then(blob => {
      if (cancelled || !blob) { return; }
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) { URL.revokeObjectURL(objectUrl); }
    };
  }, [client, id, hasIcon, version]);

  const dimension = { width: size, height: size };
  if (url) { return <img className={styles.image} style={dimension} src={url} alt="" />; }
  return (
    <span className={styles.folder} style={dimension} aria-hidden>
      <FolderGlyph size={Math.round(size * 0.56)} />
    </span>
  );
}

export function FolderGlyph({ size = 16, plus = false }: { size?: number; plus?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4l2 2h8.6A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
      {plus ? <path d="M12 11v5M9.5 13.5h5" /> : null}
    </svg>
  );
}
