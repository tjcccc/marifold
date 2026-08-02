// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeConnection,
  defaultConnectionStore,
  loadConnections,
  normalizeServerUrl,
  removeConnection,
  saveConnections,
  THIS_SERVER_ID,
  upsertAndActivateConnection,
} from '../../src/state/connection';

afterEach(() => localStorage.clear());

describe('connection storage', () => {
  it('defaults to the server that delivered the Web UI', () => {
    const store = loadConnections();
    expect(store).toEqual(defaultConnectionStore());
    expect(activeConnection(store)).toMatchObject({ id: THIS_SERVER_ID, name: 'This server' });
  });

  it('migrates the legacy URL and token into an active named server', () => {
    localStorage.setItem('marifold.connection', JSON.stringify({
      baseUrl: 'http://100.101.102.103:32140/',
      token: 'legacy-secret',
    }));

    const store = loadConnections();
    expect(store.servers).toHaveLength(2);
    expect(activeConnection(store)).toMatchObject({
      name: '100.101.102.103:32140',
      baseUrl: 'http://100.101.102.103:32140',
      token: 'legacy-secret',
    });
    expect(localStorage.getItem('marifold.connections.v1')).toBeTruthy();
  });

  it('persists, activates, and removes independent server entries', () => {
    const remote = {
      id: 'remote',
      name: 'Mac mini',
      baseUrl: 'http://100.101.102.103:32140',
      token: 'secret',
    };
    const connected = upsertAndActivateConnection(defaultConnectionStore(), remote);
    saveConnections(connected);
    expect(activeConnection(loadConnections())).toEqual(remote);

    const removed = removeConnection(connected, remote.id);
    expect(removed.activeId).toBe(THIS_SERVER_ID);
    expect(removed.servers).toEqual([{ id: THIS_SERVER_ID, name: 'This server' }]);
  });

  it('accepts only root HTTP(S) service URLs without embedded credentials', () => {
    expect(normalizeServerUrl(' https://mac-mini.example.ts.net/ ')).toBe('https://mac-mini.example.ts.net');
    expect(() => normalizeServerUrl('file:///tmp/marifold')).toThrow(/HTTP or HTTPS/);
    expect(() => normalizeServerUrl('http://user:secret@host:32140')).toThrow(/credentials/);
    expect(() => normalizeServerUrl('http://host:32140/v1')).toThrow(/server root/);
  });
});
