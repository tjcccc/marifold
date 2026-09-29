import { describe, expect, it } from 'vitest';
import { WorkspaceRuns } from '../src/workspace/WorkspaceRuns';

const host = { id: 'home', name: 'Home', online: true, executor: true };
const guest = { id: 'guest', name: 'STJC-M1P-2.local', online: true, executor: true };
function fixture(devices = [host, guest]) {
  const connection = { id: 'workspace', role: 'host', deviceId: 'home', hostDeviceId: 'home' };
  return new WorkspaceRuns({} as never, {
    store: { list: () => [connection], get: () => connection },
    devices: () => devices,
  } as never);
}
describe('explicit device mentions', () => {
  it('routes a mention before the default selection and preserves user text', async () => {
    const objective = '@stjc-m1p-2.local run id -u';
    const result = await fixture().resolve({ objective }, { executionDeviceId: 'host' });
    expect(result.execution?.executionDeviceId).toBe('guest');
    expect(result.objective).toBe(objective);
    expect((await fixture().resolve({ objective: 'ordinary task' }, {})).execution?.executionDeviceId).toBe('home');
  });
  it('accepts quoted names and IDs for duplicate names', async () => {
    const runs = fixture([host, { ...guest, name: 'Office Mac' }]);
    expect((await runs.resolve({ objective: '@"Office Mac" run id' }, {})).execution?.executionDeviceId).toBe('guest');
    const duplicate = fixture([host, { ...guest, name: 'Home' }]);
    await expect(duplicate.resolve({ objective: '@Home run id' }, {})).rejects.toThrow('ambiguous');
    expect((await duplicate.resolve({ objective: '@guest run id' }, {})).execution?.executionDeviceId).toBe('guest');
  });
  it('fails closed for missing, unavailable and malformed targets', async () => {
    for (const objective of ['@missing run id', '@', '@guest', '@guest $skill', '@guest /stop']) {
      await expect(fixture().resolve({ objective }, {})).rejects.toThrow();
    }
    for (const device of [{ ...guest, online: false }, { ...guest, executor: false }]) {
      await expect(fixture([host, device]).resolve({ objective: '@guest run id' }, {})).rejects.toThrow('unavailable');
    }
  });
});
