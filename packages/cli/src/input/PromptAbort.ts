export class PromptAbortError extends Error {
  constructor(message = 'Aborted.') {
    super(message);
    this.name = 'PromptAbortError';
  }
}

export function isPromptAbortError(error: unknown): error is PromptAbortError {
  return error instanceof PromptAbortError;
}

/** Raised when the user presses Esc to step back to the previous wizard step
 * (as opposed to PromptAbortError, which cancels the whole command). */
export class PromptBackError extends Error {
  constructor(message = 'Back.') {
    super(message);
    this.name = 'PromptBackError';
  }
}

export function isPromptBackError(error: unknown): error is PromptBackError {
  return error instanceof PromptBackError;
}
