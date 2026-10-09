import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject } from 'react';
import { isInsideAny } from '@marifold/core';
import type { ApprovalDecision, ApprovalRequest, SudoResponse, ToolKind, UserInputHandler, UserInputSubmission } from '@marifold/core';
import type { AppAction, AppState, NoticeTone } from '../core/appState.js';
import type { TuiRuntime } from '../core/TuiRuntime.js';
import { trustTargetFolder, type ApprovalChoice } from './ApprovalModal.js';
import { errorText } from './appHelpers.js';

interface ApprovalOptions {
  runtime: TuiRuntime;
  dispatch: Dispatch<AppAction>;
  stateRef: MutableRefObject<AppState>;
  notify: (text: string, tone?: NoticeTone) => void;
}

/**
 * Approval and clarification prompts for agent runs, plus this session's
 * "Always" grants: allowed tool kinds and trusted folders the run's baked
 * config cannot see.
 */
export function useApprovals({ runtime, dispatch, stateRef, notify }: ApprovalOptions) {
  const approvalResolverRef = useRef<((decision: ApprovalDecision) => void) | null>(null);
  const userInputResolverRef = useRef<((submission: UserInputSubmission | undefined) => void) | null>(null);
  const sessionGrantsRef = useRef<Set<ToolKind>>(new Set());
  const sessionTrustedFoldersRef = useRef<Set<string>>(new Set());

  const approvalHandler = useCallback((request: ApprovalRequest): Promise<ApprovalDecision> => {
    // Auto-approve from this session's "Always" grants — the run's baked config
    // can't see them, so the App layer applies them: a kind grant for ordinary
    // calls, a trusted folder for escalated writes inside it.
    if (!request.escalated && sessionGrantsRef.current.has(request.kind)) {
      return Promise.resolve({ approved: true });
    }
    if (request.persistable !== false && request.escalated && request.escalatedPath
        && isInsideAny(request.escalatedPath, [...sessionTrustedFoldersRef.current])) {
      return Promise.resolve({ approved: true });
    }
    dispatch({ type: 'set_approval', request });
    return new Promise<ApprovalDecision>(resolve => {
      approvalResolverRef.current = resolve;
    });
  }, []);

  const resolveApproval = useCallback((choice: ApprovalChoice, sudoResponse?: SudoResponse) => {
    const request = stateRef.current.approval;
    const resolve = approvalResolverRef.current;
    approvalResolverRef.current = null;
    dispatch({ type: 'set_approval', request: undefined });
    if (!request || !resolve) { return; }
    if (choice === 'no') {
      resolve({ approved: false, reason: 'denied by user' });
      return;
    }
    if (choice === 'always' && request.persistable !== false) {
      const folder = trustTargetFolder(request);
      if (folder) { trustFolderForProfile(folder); }   // escalated write → trust the folder
      else { persistApprovalKind(request.kind); }       // ordinary call → allow this kind
    }
    resolve({ approved: true, ...(sudoResponse ? { sudoResponse } : {}) });
  }, []);

  // --- Clarification questions --------------------------------------------
  const userInputHandler = useCallback<UserInputHandler>(request => {
    dispatch({ type: 'set_user_input', request });
    return new Promise<UserInputSubmission | undefined>(resolve => {
      userInputResolverRef.current = resolve;
    });
  }, []);

  const resolveUserInput = useCallback((submission: UserInputSubmission | undefined) => {
    const resolve = userInputResolverRef.current;
    userInputResolverRef.current = null;
    dispatch({ type: 'set_user_input', request: undefined });
    resolve?.(submission);
  }, []);

  // "Always (allow <kind>)": persist to the active profile + grant for this session.
  const persistApprovalKind = useCallback(async (kind: ToolKind) => {
    const profile = stateRef.current.profile;
    sessionGrantsRef.current.add(kind);
    try {
      await runtime.setProfileAgentApproval(profile, kind, 'allow');
      notify(`Persisted approval: ${kind} = allow for ${profile}`, 'info');
    } catch (error) {
      notify(`Could not persist approval: ${errorText(error)}`, 'error');
    }
  }, [runtime, notify]);

  // "Always (trust <folder>)" / `/trust-folder`: persist to the active profile +
  // trust for this session (the running run can't re-read profile.toml).
  const trustFolderForProfile = useCallback(async (folder: string) => {
    const profile = stateRef.current.profile;
    try {
      const resolved = await runtime.addProfileTrustedFolder(profile, folder);
      sessionTrustedFoldersRef.current.add(resolved);
      notify(`Trusting ${resolved} for ${profile} (writes here won't ask).`, 'info');
    } catch (error) {
      notify(`Could not trust folder: ${errorText(error)}`, 'error');
    }
  }, [runtime, notify]);

  // Answer any open approval or question when the run is cancelled.
  const cancelPrompts = useCallback(() => {
    const resolve = approvalResolverRef.current;
    if (resolve) {
      approvalResolverRef.current = null;
      dispatch({ type: 'set_approval', request: undefined });
      resolve({ approved: false, reason: 'cancelled' });
    }
    if (userInputResolverRef.current) { resolveUserInput(undefined); }
  }, [resolveUserInput]);

  return {
    approvalHandler,
    resolveApproval,
    userInputHandler,
    resolveUserInput,
    trustFolderForProfile,
    cancelPrompts,
    sessionGrantsRef,
    sessionTrustedFoldersRef,
  };
}
