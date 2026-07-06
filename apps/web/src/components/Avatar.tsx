import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { fetchAvatarBlob } from '../api/profiles';
import styles from './Avatar.module.css';

export interface AvatarProps {
  client: ApiClient;
  name: string;
  /** ProfileSummary.avatar presence — skips the fetch when there is none. */
  hasAvatar: boolean;
  size?: number;
  /** Bump after an upload/delete to refetch despite unchanged props. */
  version?: number;
}

/** Profile avatar: the stored image (fetched with auth → blob URL, since
 * `<img src>` can't carry a bearer token) or a marigold initial circle. */
export function Avatar({ client, name, hasAvatar, size = 32, version = 0 }: AvatarProps) {
  const [url, setUrl] = useState<string | undefined>();

  useEffect(() => {
    if (!hasAvatar) {
      setUrl(undefined);
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    (async () => {
      try {
        const blob = await fetchAvatarBlob(client, name);
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        // Auth/transport problems degrade to the initial circle.
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, name, hasAvatar, version]);

  const dimension = { width: size, height: size };
  if (url) {
    return <img className={styles.image} style={dimension} src={url} alt={`${name} avatar`} />;
  }
  return (
    <span
      className={styles.initial}
      style={{ ...dimension, fontSize: Math.round(size * 0.44) }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
