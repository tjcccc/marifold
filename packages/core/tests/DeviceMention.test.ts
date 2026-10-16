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

it('routes inline device mentions and rejects conflicting targets', async () => {
  const result = await fixture().resolve({ objective: 'Close the @STJC-M1P-2.local wechat' }, {});
  expect(result.execution?.executionDeviceId).toBe('guest');
  await expect(fixture().resolve({ objective: 'Close on @guest and @Home' }, {})).rejects.toThrow('one @device');
  await expect(fixture().resolve({ objective: 'Close on @missing' }, {})).rejects.toThrow('unknown');
  expect((await fixture().resolve({ objective: 'Email me@example.com' }, {})).execution?.executionDeviceId).toBe('home');
});

describe('skill management routing', () => {
  const guestOrigin = { workspaceId: 'workspace', senderDeviceId: 'guest', hostDeviceId: 'home' };
  it('sends Automatic skill management from a guest to the host', async () => {
    for (const objective of [
      'install make-qwen-image-prompt skill from `jack-ai-lab/skills/` and set the vars file like others',
      '把 jack-ai-lab 里的 make-qwen-image-prompt 技能安装到 painter',
      '$skill-installer install ~/skills/translate',
    ]) {
      expect((await fixture().resolve({ objective }, {}, guestOrigin)).execution?.executionDeviceId).toBe('home');
    }
  });
  it('keeps skill use and explicit selections on the guest', async () => {
    expect((await fixture().resolve({ objective: 'use my translate skill on this file' }, {}, guestOrigin))
      .execution?.executionDeviceId).toBe('guest');
    expect((await fixture().resolve({ objective: 'install the translate skill' }, { executionDeviceId: 'guest' }, guestOrigin))
      .execution?.executionDeviceId).toBe('guest');
  });
  it('treats @device in skill management as the source and keeps the run on the host', async () => {
    const result = await fixture().resolve({ objective: "install the abc skill from @guest's ~/skills/abc" }, {}, guestOrigin);
    expect(result.execution?.executionDeviceId).toBe('home');
    expect(result.objective).toContain('@guest');
    expect((await fixture().resolve({ objective: '@guest restart tailscale' }, {}, guestOrigin)).execution?.executionDeviceId).toBe('guest');
    expect((await fixture().resolve({ objective: '从 @guest 的 ~/skills/abc 安装 abc 技能' }, {}, guestOrigin)).execution?.executionDeviceId).toBe('home');
    expect((await fixture().resolve({ objective: '@guest update the skills section of resume.docx' }, {}, guestOrigin)).execution?.executionDeviceId).toBe('guest');
    expect((await fixture().resolve({ objective: 'install the abc skill on @guest' }, {}, guestOrigin)).execution?.executionDeviceId).toBe('guest');
  });
});

describe('agent computer routing', () => {
  it('treats @device as the source of agent computer work, keeping the run on the host', async () => {
    const origin = { workspaceId: 'workspace', senderDeviceId: 'home', hostDeviceId: 'home' };
    const copy = await fixture().resolve({ objective: "Copy @STJC-M1P-2.local's ~/tempfiles/hello.md to your computer" }, {}, origin);
    expect(copy.execution?.executionDeviceId).toBe('home');
    expect((await fixture().resolve({ objective: "save hello to @guest's ~/tempfiles" }, {}, origin)).execution?.executionDeviceId).toBe('guest');
  });
});
