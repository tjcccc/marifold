import { stripTerminalControls } from '@marifold/core';

/** Strip terminal control sequences from every string in model, tool, or
 * remote data before printing it. See `stripTerminalControls`. */
export function inert<T>(value: T): T {
  if (typeof value === 'string') { return stripTerminalControls(value) as T; }
  if (Array.isArray(value)) { return value.map(inert) as T; }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inert(item)])) as T;
  }
  return value;
}
