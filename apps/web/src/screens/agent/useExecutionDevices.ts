import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { SkillHint } from '../../api/misc';
import type { WorkspaceDevice } from '../../api/types';

/** Online execution devices for the composer's `@` autocomplete, polled every
 * 10 s. Names that are ambiguous or unquotable are offered by id. */
export function useExecutionDevices(client: ApiClient): SkillHint[] {
  const [devices, setDevices] = useState<SkillHint[]>([]);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const result = await client.request<{ devices: WorkspaceDevice[] }>('GET', '/v1/execution-devices');
        if (stopped) { return; }
        setDevices(result.devices.filter(d => d.online && d.executor).map(d => {
          const duplicate = result.devices.filter(other => other.name.toLowerCase() === d.name.toLowerCase()).length > 1;
          const name = duplicate || /["\r\n]/.test(d.name) ? d.id : /\s/.test(d.name) ? `"${d.name}"` : d.name;
          return { name, usage: `@${name}`, description: `${d.name} · ${d.platform}${duplicate ? ` · ${d.id}` : ''}` };
        }));
      } catch { if (!stopped) { setDevices([]); } }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [client]);
  return devices;
}
