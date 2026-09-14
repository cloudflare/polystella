import { PluginRouteError, RESERVED_COLLECTION_SLUGS, RESERVED_FIELD_SLUGS } from "emdash";

import type { CustomizationMode } from "../../contracts.js";
import { isCustomizationMode } from "../../settings.js";

const MAX_LOCALE_LENGTH = 64;
const EMDASH_LOCALE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;
const EMDASH_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

export function requireMethod(request: Request, expected: string): void {
  if (request.method !== expected) throw new PluginRouteError("METHOD_NOT_ALLOWED", `${expected} required`, 405);
}

export function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw PluginRouteError.badRequest(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw PluginRouteError.badRequest(`${label} must be a non-empty string`);
  return value;
}

export function readText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw PluginRouteError.badRequest(`${label} must be a string`);
  if (value.length > maxLength) throw PluginRouteError.badRequest(`${label} cannot exceed ${maxLength} characters`);
  return value;
}

export function readLocale(value: unknown, label: string): string {
  const locale = readString(value, label);
  if (locale.length > MAX_LOCALE_LENGTH || !EMDASH_LOCALE_PATTERN.test(locale)) {
    throw PluginRouteError.badRequest(`${label} must be a valid EmDash locale`);
  }
  return locale;
}

export function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw PluginRouteError.badRequest(`${label} must be a boolean`);
  return value;
}

export function readCustomizationMode(value: unknown, label: string): CustomizationMode {
  if (!isCustomizationMode(value)) throw PluginRouteError.badRequest(`${label} must be default, append, or replace`);
  return value;
}

export function readStringArray(value: unknown, label: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw PluginRouteError.badRequest(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string array`);
  }
  return value.map((item, index) => readString(item, `${label}[${index}]`));
}

export function readNullableStringRecord(value: unknown, label: string): Record<string, string | null> {
  const record = readRecord(value, label);
  const output: Record<string, string | null> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string" && item !== null) throw PluginRouteError.badRequest(`${label}.${key} must be a string or null`);
    Object.defineProperty(output, key, { configurable: true, enumerable: true, value: item, writable: true });
  }
  return output;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

export function isAllowedCollectionSlug(value: string): boolean {
  return value.length <= 63 && EMDASH_SLUG_PATTERN.test(value) && !RESERVED_COLLECTION_SLUGS.some((reserved) => reserved === value);
}

export function isAllowedFieldSlug(value: string): boolean {
  return value.length <= 63 && EMDASH_SLUG_PATTERN.test(value) && !RESERVED_FIELD_SLUGS.some((reserved) => reserved === value);
}

export function readStoredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw PluginRouteError.internal(`${label} is invalid`);
  return value as Record<string, unknown>;
}

export function readStoredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw PluginRouteError.internal(`${label} is invalid`);
  return value;
}
