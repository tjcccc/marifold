import type { NewThreadItem, RunCardState, ThreadItem, ThreadState } from './threadTypes';

// Item-level thread updates shared by the reducer and the run event path.

export function markUserPersisted(state: ThreadState, itemId: string): ThreadState {
  const item = state.items.find(candidate => candidate.id === itemId);
  if (!item || item.kind !== 'user') { return state; }
  if (item.sessionUserTurnIndex !== undefined) {
    if (!item.replacing) { return state; }
    return {
      ...state,
      items: state.items.map(candidate => candidate.id === itemId
        ? { ...item, replacing: undefined }
        : candidate),
    };
  }
  const nextIndex = state.items.reduce(
    (highest, candidate) => candidate.kind === 'user' && candidate.sessionUserTurnIndex !== undefined
      ? Math.max(highest, candidate.sessionUserTurnIndex)
      : highest,
    -1,
  ) + 1;
  return {
    ...state,
    items: state.items.map(candidate => candidate.id === itemId
      ? { ...item, sessionUserTurnIndex: nextIndex }
      : candidate),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function append(state: ThreadState, item: NewThreadItem): ThreadState {
  const seq = state.seq + 1;
  return {
    ...state,
    seq,
    items: [...state.items, { ...item, id: `item_${seq}` } as ThreadItem],
  };
}

export function insert(state: ThreadState, index: number, item: NewThreadItem): ThreadState {
  const seq = state.seq + 1;
  return {
    ...state,
    seq,
    items: [
      ...state.items.slice(0, index),
      { ...item, id: `item_${seq}` } as ThreadItem,
      ...state.items.slice(index),
    ],
  };
}

export function insertRunCard(
  state: ThreadState,
  item: Extract<NewThreadItem, { kind: 'run' }>,
): ThreadState {
  const replacingIndex = state.items.findIndex(candidate => candidate.kind === 'user' && candidate.replacing);
  return replacingIndex === -1 ? append(state, item) : insert(state, replacingIndex + 1, item);
}

export function findRunItem(state: ThreadState, runId: string): Extract<ThreadItem, { kind: 'run' }> | undefined {
  return state.items.find(
    (item): item is Extract<ThreadItem, { kind: 'run' }> => item.kind === 'run' && item.run.runId === runId,
  );
}

export function updateRun(
  state: ThreadState,
  runId: string,
  update: (run: RunCardState) => RunCardState,
): ThreadState {
  return {
    ...state,
    items: state.items.map(item =>
      item.kind === 'run' && item.run.runId === runId ? { ...item, run: update(item.run) } : item,
    ),
  };
}

export function emptyCard(runId: string): RunCardState {
  return {
    runId,
    status: 'running',
    lastSeq: 0,
    startedAt: new Date().toISOString(),
    rows: [],
    artifacts: [],
    inputResponses: [],
    steering: [],
    denials: [],
    errors: [],
    collapsed: false,
  };
}
