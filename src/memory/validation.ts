import type { MemoryScope } from "./types.js";

export function requireRecord(value: unknown, label = "input"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireString(value, label);
}

export function boundedNumber(
  value: unknown,
  label: string,
  fallback: number,
  minimum = 0,
  maximum = 1
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function positiveInteger(value: unknown, label: string, fallback: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

export function parseScope(value: unknown, fallback?: MemoryScope): MemoryScope {
  if (value === undefined && fallback) return fallback;
  const record = requireRecord(value, "scope");
  const kind = requireString(record.kind, "scope.kind");
  if (!new Set(["global", "repository", "worktree", "session"]).has(kind)) {
    throw new Error("scope.kind must be global, repository, worktree, or session");
  }
  return { kind: kind as MemoryScope["kind"], key: requireString(record.key, "scope.key") };
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

