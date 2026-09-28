/**
 * Text helpers for the `session_digests` projection: one bounded row per
 * provider session that search, `session.get`, and context packs read instead
 * of the raw event log.
 */

import { redactSecrets } from "../util/redact.js";

/** Bump when digest folding changes; the store rebuilds digests on startup. */
export const DIGEST_PROJECTION_VERSION = 2;
export const DIGEST_FIELD_LENGTH = 2_000;
export const DIGEST_SEARCH_TEXT_LENGTH = 16_000;
const DIGEST_SEARCH_ENTRY_LENGTH = 1_000;

// Desktop clients prepend ambient UI state that is not part of the request.
const AMBIENT_BLOCK = /<in-app-browser-context\b[\s\S]*?<\/in-app-browser-context>/g;
const REQUEST_MARKER = "## My request:";

/** Scheduled automations (for example Codex heartbeats) are not human objectives. */
export function isAutomatedPrompt(prompt: string): boolean {
  const head = prompt.trimStart().slice(0, 500);
  return head.startsWith("<heartbeat>") || head.includes("<automation_id>");
}

/** Returns the human request with client-injected context removed. */
export function promptRequest(prompt: string): string {
  let text = prompt.replace(AMBIENT_BLOCK, " ");
  const marker = text.lastIndexOf(REQUEST_MARKER);
  if (marker >= 0) text = text.slice(marker + REQUEST_MARKER.length);
  return text.trim();
}

/** Whitespace-compacted, secret-redacted, and bounded. */
export function compactText(value: string, maximum: number): string {
  const compact = redactSecrets(value).replaceAll(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
}

/** Appends an entry and keeps only the newest `DIGEST_SEARCH_TEXT_LENGTH` characters. */
export function appendSearchText(current: string, entry: string): string {
  const addition = compactText(entry, DIGEST_SEARCH_ENTRY_LENGTH);
  if (!addition) return current;
  const combined = current ? `${current}\n${addition}` : addition;
  if (combined.length <= DIGEST_SEARCH_TEXT_LENGTH) return combined;
  const trimmed = combined.slice(combined.length - DIGEST_SEARCH_TEXT_LENGTH);
  const lineStart = trimmed.indexOf("\n");
  return lineStart >= 0 ? trimmed.slice(lineStart + 1) : trimmed;
}
