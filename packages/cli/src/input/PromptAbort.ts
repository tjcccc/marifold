export class PromptAbortError extends Error {
  constructor(message = 'Aborted.') {
    super(message);
    this.name = 'PromptAbortError';
  }
}

export function isPromptAbortError(error: unknown): error is PromptAbortError {
  return error instanceof PromptAbortError;
}
