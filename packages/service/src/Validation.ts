import { ImageInput, MarifoldError, MAX_RUN_INPUT_BYTES, RunFileInput } from '@marifold/core';

export type JsonObject = Record<string, unknown>;

export function objectBody(value: unknown): JsonObject {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as JsonObject;
  throw MarifoldError.configInvalid('Expected a JSON object request body.');
}

export function requiredString(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (!text.trim()) throw MarifoldError.configInvalid(`${label} cannot be empty.`);
  return text;
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw MarifoldError.configInvalid(`${label} must be a string.`);
  return value;
}

export function optionalStringField<Key extends string>(key: Key, value: unknown): Record<Key, string> | Record<string, never> {
  if (value === undefined) return {};
  return { [key]: stringValue(value, key) } as Record<Key, string>;
}

export function optionalBooleanField<Key extends string>(key: Key, value: unknown): Record<Key, boolean> | Record<string, never> {
  if (value === undefined) return {};
  if (typeof value !== 'boolean') throw MarifoldError.configInvalid(`${key} must be a boolean.`);
  return { [key]: value } as Record<Key, boolean>;
}

export function optionalPositiveIntegerField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw MarifoldError.configInvalid(`${key} must be a positive integer.`);
  }
  return { [key]: value } as Record<Key, number>;
}

export function optionalNonNegativeIntegerField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw MarifoldError.configInvalid(`${key} must be a non-negative integer.`);
  }
  return { [key]: value } as Record<Key, number>;
}

export function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw MarifoldError.configInvalid(`${label} must be an array of strings.`);
  return value.map((item, index) => stringValue(item, `${label}[${index}]`));
}

// App clients send images as base64 payloads ({data, mediaType}) or URLs;
// local file paths are not accepted over the service boundary.
export function optionalImagesField(value: unknown): { images: ImageInput[] } | Record<string, never> {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw MarifoldError.configInvalid('Expected images to be an array.');
  const images = value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw MarifoldError.configInvalid(`Expected images[${index}] to be an object.`);
    }
    const image = item as { data?: unknown; url?: unknown; mediaType?: unknown };
    const data = typeof image.data === 'string' && image.data ? image.data : undefined;
    const url = typeof image.url === 'string' && image.url ? image.url : undefined;
    if ((data === undefined) === (url === undefined)) {
      throw MarifoldError.configInvalid(`Expected images[${index}] to set exactly one of data or url.`);
    }
    return {
      ...(data !== undefined ? { data } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(typeof image.mediaType === 'string' && image.mediaType ? { mediaType: image.mediaType } : {}),
    };
  });
  return { images };
}

/** Binary run inputs are base64 JSON because the service remains a compact
 * loopback API. Core stages them into the run's read-only input directory. */
export function optionalRunFilesField(value: unknown): { files: RunFileInput[] } | Record<string, never> {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw MarifoldError.configInvalid('Expected files to be an array.');
  let total = 0;
  const files = value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw MarifoldError.configInvalid(`Expected files[${index}] to be an object.`);
    }
    const file = item as { name?: unknown; mediaType?: unknown; data?: unknown };
    const name = requiredString(file.name, `files[${index}].name`);
    const mediaType = requiredString(file.mediaType, `files[${index}].mediaType`);
    const data = requiredString(file.data, `files[${index}].data`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) {
      throw MarifoldError.configInvalid(`files[${index}].data must be base64.`);
    }
    const size = Buffer.from(data, 'base64').length;
    if (size === 0) throw MarifoldError.configInvalid(`files[${index}].data cannot be empty.`);
    total += size;
    if (total > MAX_RUN_INPUT_BYTES) {
      throw MarifoldError.configInvalid(`Run files exceed ${MAX_RUN_INPUT_BYTES / (1024 * 1024)} MiB.`);
    }
    return { name, mediaType, data };
  });
  return { files };
}
