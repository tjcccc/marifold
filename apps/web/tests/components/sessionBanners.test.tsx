// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionArchivedBanner } from '../../src/screens/agent/SessionBlockedBanner';

describe('SessionArchivedBanner', () => {
  it('explains the archived state and unarchives on request', async () => {
    const onUnarchive = vi.fn(async () => true);
    render(<SessionArchivedBanner onUnarchive={onUnarchive} />);
    expect(screen.getByRole('status').textContent).toContain('This session has been archived. Unarchive it to continue.');
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    expect(onUnarchive).toHaveBeenCalledOnce();
  });
});
