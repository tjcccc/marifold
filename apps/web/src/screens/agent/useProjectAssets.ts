import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import {
  addRunOutputToAssets,
  deleteProjectAsset,
  fetchProjectAssetContent,
  linkProjectAsset,
  listProjectAssets,
  listProjectAssetVersions,
  updateProjectAsset,
  uploadProjectAsset,
} from '../../api/projectAssets';
import { listRuns } from '../../api/runs';
import type { ListedProjectAsset, ProjectAssetUsage, ProjectAssetVersion } from '../../api/types';
import { fileToBase64 } from '../../lib/attachments';
import { sessionOutputs, uploadProblem, type SessionOutput } from '../../lib/projectAssets';

export interface AssetUpload {
  key: string;
  name: string;
  size: number;
}

export interface ProjectAssetsState {
  assets: ListedProjectAsset[];
  usage?: ProjectAssetUsage;
  loading: boolean;
  /** The last failed load or action, shown on the Assets card until dismissed. */
  problem?: string;
  dismissProblem: () => void;
  uploads: AssetUpload[];
  /** This session's run outputs; empty without a session. */
  outputs: SessionOutput[];
  /** Outputs being added, by `runId:artifactId`. */
  adding: ReadonlySet<string>;
  /** Downloads still loading, by `downloadKey`. */
  downloading: ReadonlySet<string>;
  upload: (files: File[], name?: string) => Promise<void>;
  addOutput: (output: SessionOutput) => Promise<void>;
  /** Resolves to the problem, or undefined once linked. */
  link: (input: { target: string; name?: string; description?: string }) => Promise<string | undefined>;
  update: (asset: ListedProjectAsset, patch: { name?: string; description?: string | null }) => Promise<string | undefined>;
  remove: (asset: ListedProjectAsset) => Promise<string | undefined>;
  versions: (asset: ListedProjectAsset) => Promise<ProjectAssetVersion[]>;
  download: (asset: ListedProjectAsset, version?: number) => Promise<void>;
}

export const outputKey = (output: SessionOutput) => `${output.runId}:${output.artifact.id}`;
export const downloadKey = (asset: ListedProjectAsset, version?: number) => `${asset.id}:${version ?? 'latest'}`;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A project's assets and a session's outputs. Reloads when the project or
 * session changes and when a reply finishes (it may have saved assets). */
export function useProjectAssets(client: ApiClient, projectId: string, sessionId: string | undefined, responding: boolean, limitBytes?: number): ProjectAssetsState {
  const [assets, setAssets] = useState<ListedProjectAsset[]>([]);
  const [usage, setUsage] = useState<ProjectAssetUsage>();
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string>();
  const [uploads, setUploads] = useState<AssetUpload[]>([]);
  const [outputs, setOutputs] = useState<SessionOutput[]>([]);
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [downloading, setDownloading] = useState<ReadonlySet<string>>(new Set());
  // Responses for an earlier project or session are dropped.
  const current = useRef({ projectId, sessionId });
  current.current = { projectId, sessionId };

  const refreshAssets = useCallback(async () => {
    try {
      const list = await listProjectAssets(client, projectId);
      if (current.current.projectId !== projectId) { return; }
      setAssets(list.assets);
      setUsage(list.usage);
    } catch (error) {
      if (current.current.projectId === projectId) { setProblem(message(error)); }
    } finally {
      if (current.current.projectId === projectId) { setLoading(false); }
    }
  }, [client, projectId]);

  const refreshOutputs = useCallback(async () => {
    if (!sessionId) {
      setOutputs([]);
      return;
    }
    try {
      const runs = await listRuns(client, sessionId);
      if (current.current.sessionId === sessionId) { setOutputs(sessionOutputs(runs)); }
    } catch {
      // Outputs stay as they were; the thread still offers each download.
    }
  }, [client, sessionId]);

  useEffect(() => {
    setAssets([]);
    setUsage(undefined);
    setLoading(true);
    setProblem(undefined);
    void refreshAssets();
  }, [refreshAssets]);

  useEffect(() => {
    setOutputs([]);
    void refreshOutputs();
  }, [refreshOutputs]);

  const limitSeen = useRef(limitBytes);
  useEffect(() => {
    if (limitSeen.current === limitBytes) { return; }
    limitSeen.current = limitBytes;
    void refreshAssets();
  }, [limitBytes, refreshAssets]);

  const wasResponding = useRef(responding);
  useEffect(() => {
    if (wasResponding.current && !responding) {
      void refreshAssets();
      void refreshOutputs();
    }
    wasResponding.current = responding;
  }, [responding, refreshAssets, refreshOutputs]);

  const upload = useCallback(async (files: File[], name?: string) => {
    for (const file of files) {
      const refused = uploadProblem(file);
      if (refused) {
        setProblem(refused);
        continue;
      }
      const key = `${file.name}:${file.size}:${Math.random()}`;
      setUploads(list => [...list, { key, name: name ?? file.name, size: file.size }]);
      try {
        const data = await fileToBase64(file);
        await uploadProjectAsset(client, projectId, { name: name ?? file.name, data, mediaType: file.type || 'application/octet-stream' });
      } catch (error) {
        setProblem(message(error));
      } finally {
        setUploads(list => list.filter(item => item.key !== key));
      }
    }
    await refreshAssets();
  }, [client, projectId, refreshAssets]);

  const addOutput = useCallback(async (output: SessionOutput) => {
    const key = outputKey(output);
    setAdding(keys => new Set(keys).add(key));
    try {
      await addRunOutputToAssets(client, projectId, { runId: output.runId, artifactId: output.artifact.id });
      await refreshAssets();
    } catch (error) {
      setProblem(message(error));
    } finally {
      setAdding(keys => {
        const next = new Set(keys);
        next.delete(key);
        return next;
      });
    }
  }, [client, projectId, refreshAssets]);

  const link = useCallback(async (input: { target: string; name?: string; description?: string }) => {
    try {
      await linkProjectAsset(client, projectId, input);
      await refreshAssets();
      return undefined;
    } catch (error) {
      return message(error);
    }
  }, [client, projectId, refreshAssets]);

  const update = useCallback(async (asset: ListedProjectAsset, patch: { name?: string; description?: string | null }) => {
    try {
      await updateProjectAsset(client, projectId, asset.id, patch);
      await refreshAssets();
      return undefined;
    } catch (error) {
      return message(error);
    }
  }, [client, projectId, refreshAssets]);

  const remove = useCallback(async (asset: ListedProjectAsset) => {
    try {
      const list = await deleteProjectAsset(client, projectId, asset.id);
      setAssets(list.assets);
      setUsage(list.usage);
      return undefined;
    } catch (error) {
      return message(error);
    }
  }, [client, projectId]);

  const versions = useCallback(
    (asset: ListedProjectAsset) => listProjectAssetVersions(client, projectId, asset.id),
    [client, projectId],
  );

  // The content is fetched whole (it needs the API's authorization), then saved.
  const download = useCallback(async (asset: ListedProjectAsset, version?: number) => {
    const key = downloadKey(asset, version);
    setDownloading(keys => new Set(keys).add(key));
    try {
      const blob = await fetchProjectAssetContent(client, projectId, asset.id, version);
      if (!blob) {
        setProblem(`${asset.name} is no longer stored.`);
        void refreshAssets();
        return;
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = asset.name;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Give the browser a moment to start the download before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      setProblem(message(error));
    } finally {
      setDownloading(keys => {
        const next = new Set(keys);
        next.delete(key);
        return next;
      });
    }
  }, [client, projectId, refreshAssets]);

  return {
    assets,
    ...(usage ? { usage } : {}),
    loading,
    ...(problem ? { problem } : {}),
    dismissProblem: () => setProblem(undefined),
    uploads,
    outputs,
    adding,
    downloading,
    upload,
    addOutput,
    link,
    update,
    remove,
    versions,
    download,
  };
}
