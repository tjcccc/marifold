import { MarifoldError } from '@marifold/core';
import { JsonObject } from './Validation';

export function normalizeError(error: unknown, localRequest = false): { statusCode: number; error: JsonObject } {
  if (error instanceof MarifoldError) {
    return {
      statusCode: statusCodeForError(error),
      error: {
        code: error.code,
        message: error.message,
        ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
      },
    };
  }
  // Fastify request errors (malformed JSON, oversized or unsupported bodies)
  // carry their own client status.
  const statusCode = (error as { statusCode?: unknown } | undefined)?.statusCode;
  if (error instanceof Error && typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return { statusCode, error: { code: 'REQUEST_INVALID', message: error.message } };
  }
  // Node system errors name host paths; only a client on this device sees them.
  if (!localRequest && error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === 'string') {
    return { statusCode: 500, error: { code: 'INTERNAL_ERROR', message: 'A local file or system operation failed.' } };
  }
  if (error instanceof Error) {
    return {
      statusCode: 500,
      error: {
        code: 'INTERNAL_ERROR',
        message: error.message,
      },
    };
  }
  return {
    statusCode: 500,
    error: {
      code: 'INTERNAL_ERROR',
      message: String(error),
    },
  };
}

function statusCodeForError(error: MarifoldError): number {
  if (
    error.code === 'TASK_NOT_FOUND'
    || error.code === 'SCHEDULE_NOT_FOUND'
    || error.code === 'SKILL_NOT_FOUND'
    || error.code === 'APP_NOT_FOUND'
    || error.code === 'RUN_NOT_FOUND'
    || error.code === 'ARTIFACT_NOT_FOUND'
    || error.code === 'APPROVAL_NOT_FOUND'
    || error.code === 'USER_INPUT_NOT_FOUND'
  ) {
    return 404;
  }
  if (
    error.code === 'CONFIG_INVALID'
    || error.code === 'IMAGE_INVALID'
    || error.code === 'PROFILE_INVALID'
    || error.code === 'MEMORY_INVALID'
    || error.code === 'TASK_INVALID'
    || error.code === 'SCHEDULE_INVALID'
    || error.code === 'AGENT_TOOL_INVALID'
    || error.code === 'AGENT_RUN_INVALID'
    || error.code === 'SKILL_INVALID'
    || error.code === 'APP_INVALID'
  ) {
    return 400;
  }
  if (error.code === 'CONFIG_FILE_NOT_FOUND') { return 404; }
  if (error.code === 'UNAUTHORIZED') { return 401; }
  if (error.code === 'NETWORK_FORBIDDEN' || error.code === 'ORIGIN_FORBIDDEN') { return 403; }
  if (error.code === 'RUN_LIMIT_EXCEEDED') { return 429; }
  if (error.code === 'SESSION_BUSY' || error.code === 'WORKSPACE_CONFLICT') { return 409; }
  if (error.code === 'WORKSPACE_INVALID') { return 400; }
  if (error.code === 'WORKSPACE_OFFLINE') { return 503; }
  if (error.code === 'WORKSPACE_TIMEOUT') { return 504; }
  if (error.code === 'PROVIDER_ERROR') { return 502; }
  return 500;
}
