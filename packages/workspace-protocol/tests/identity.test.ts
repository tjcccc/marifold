import { describe, it, expect } from 'vitest';
import {
  createIdentity,
  decryptMessage,
  encryptMessage,
  issueMembership,
  MESSAGE_TTL_MS,
  publicIdentity,
  randomId,
  validMembership,
} from '../src';

describe('workspace identity', () => {
  it('authenticates sender and recipient and binds the workspace', async () => {
    const host = await createIdentity();
    const guest = await createIdentity();
    const header = {
      version: 1 as const,
      workspaceId: 'workspace',
      sender: 'host',
      recipient: 'guest',
      id: randomId(),
      expiresAt: Date.now() + MESSAGE_TTL_MS,
    };
    const encrypted = await encryptMessage(host, publicIdentity(guest), header, { private: 'content' });
    expect(JSON.stringify(encrypted)).not.toContain('content');
    expect(
      await decryptMessage(guest, publicIdentity(host), encrypted, { workspaceId: 'workspace', recipient: 'guest' }),
    ).toEqual({ private: 'content' });
    await expect(
      decryptMessage(guest, publicIdentity(host), encrypted, { workspaceId: 'other', recipient: 'guest' }),
    ).rejects.toThrow();
    await expect(
      decryptMessage(
        guest,
        publicIdentity(host),
        { ...encrypted, ciphertext: encrypted.ciphertext.slice(4) },
        { workspaceId: 'workspace', recipient: 'guest' },
      ),
    ).rejects.toThrow();
    await expect(
      decryptMessage(host, publicIdentity(host), encrypted, { workspaceId: 'workspace', recipient: 'guest' }),
    ).rejects.toThrow();
  });
  it('requires the pinned host signature for membership', async () => {
    const host = await createIdentity();
    const guest = await createIdentity();
    const membership = issueMembership(host, {
      version: 1,
      workspaceId: 'w',
      deviceId: 'g',
      name: 'Guest',
      identity: publicIdentity(guest),
      host: publicIdentity(host),
      issuedAt: Date.now(),
    });
    expect(validMembership(membership, publicIdentity(host))).toBe(true);
    expect(validMembership(membership, publicIdentity(guest))).toBe(false);
    membership.membership.workspaceId = 'other';
    expect(validMembership(membership, publicIdentity(host))).toBe(false);
  });
});
