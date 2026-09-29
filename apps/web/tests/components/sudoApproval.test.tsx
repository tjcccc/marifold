// @vitest-environment jsdom
import React from 'react';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApprovalSheet } from '../../src/screens/agent/ApprovalSheet';
import { encryptSudoPassword } from '../../src/lib/sudoCredentials';
const require = createRequire(import.meta.url);
const { SudoCredentials } = require('../../../../packages/core/dist/agent/SudoCredentials');
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('requester-side sudo approval', () => {
  it('encrypts for the target before submitting and clears the password field', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const credentials = new SudoCredentials();
    const sudo = credentials.create('id -u');
    const answer = vi.fn();
    render(<ApprovalSheet request={{ id: 'approval', tool: 'sudo_exec', kind: 'shell', summary: 'id -u', input: { command: 'id -u' }, escalated: true, persistable: false, sudo }} onAnswer={answer} />);
    const input = screen.getByLabelText(`Password for ${sudo.account} on ${sudo.device}`) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('one-time-code');
    fireEvent.change(input, { target: { value: 'ui-secret-canary' } });
    fireEvent.click(screen.getByText('Authorize sudo once'));
    await waitFor(() => expect(answer).toHaveBeenCalledOnce());
    expect(input.value).toBe('');
    expect(JSON.stringify(answer.mock.calls)).not.toContain('ui-secret-canary');
    const bytes = credentials.consume('id -u', answer.mock.calls[0][1]);
    expect(bytes.toString()).toBe('ui-secret-canary');
    bytes.fill(0);
  });
  it('cancels without sending a credential and fails closed without browser crypto', async () => {
    const credentials = new SudoCredentials();
    const sudo = credentials.create('id -u');
    const answer = vi.fn();
    render(<ApprovalSheet request={{ id: 'approval', tool: 'sudo_exec', kind: 'shell', summary: 'id -u', input: {}, escalated: true, persistable: false, sudo }} onAnswer={answer} />);
    const input = screen.getByLabelText(`Password for ${sudo.account} on ${sudo.device}`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'cancel-secret' } });
    fireEvent.click(screen.getByText('Deny'));
    expect(answer).toHaveBeenCalledWith('deny');
    expect(input.value).toBe('');
    vi.stubGlobal('crypto', {});
    await expect(encryptSudoPassword(sudo, 'canary')).rejects.toThrow('HTTPS or localhost');
  });
});
