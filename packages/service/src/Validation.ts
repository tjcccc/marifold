import { MarifoldError } from '@marifold/core';

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

export function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw MarifoldError.configInvalid(`${label} must be an array of strings.`);
  return value.map((item, index) => stringValue(item, `${label}[${index}]`));
}
