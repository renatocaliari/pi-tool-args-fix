/**
 * Repair functions for LLM tool call arguments.
 *
 * This module contains all the deterministic repair logic, extracted for testability.
 * Each function is pure (no side effects) and can be tested independently.
 *
 * Inspired by Ahmad Awais's tool-input repair layer for CommandCode:
 *   https://x.com/mrahmadawais/status/2050956678502420612
 *
 * Based on research from:
 * - canonize (stevekinney/canonize): aggressive type coercion for Zod schemas
 * - llm-tool-arg-coerce: Python schema-aware coercion
 * - MCP SDK #1361: type coercion for tool arguments
 */

import * as path from "node:path";

// Re-export constants from sub-module for backward compatibility
export { PATH_FIELD_NAMES, ARRAY_FIELD_NAMES, BOOLEAN_FIELD_NAMES,
  CONTENT_FIELD_NAMES, NUMBER_FIELD_NAMES, FALSY_STRINGS,
  TRUTHY_STRINGS, LONG_RUNNING_TOKENS
} from "./repairs/constants.js";

import { PATH_FIELD_NAMES, ARRAY_FIELD_NAMES, BOOLEAN_FIELD_NAMES,
  CONTENT_FIELD_NAMES, NUMBER_FIELD_NAMES, FALSY_STRINGS,
  TRUTHY_STRINGS, LONG_RUNNING_TOKENS
} from "./repairs/constants.js";
// ─── Path Repair ──────────────────────────────────────────────────────────

/**
 * Unwrap markdown auto-links from path values.
 *
 * Models trained on chat distributions sometimes emit paths as markdown links:
 *   `[notes.md](http://notes.md)` → `notes.md`
 *   `[file.ts](file://path/to/file.ts)` → `file.ts`
 *
 * Only unwraps the degenerate case where the link text equals the URL without
 * its protocol prefix. Real markdown like `[click here](https://x.com)` passes
 * through untouched.
 */
export function unwrapMarkdownLink(value: string): string {
  if (typeof value !== "string") return value;

  // Match [text](url) where text === url minus protocol
  const mdLink = /^\[([^\]]+)\]\(([^)]+)\)$/;
  const match = value.match(mdLink);
  if (!match) return value;

  const [, linkText, linkUrl] = match;

  // Unwrap only when link text equals URL without protocol
  const urlWithoutProtocol = linkUrl
    .replace(/^https?:\/\//, "")
    .replace(/^file:\/\//, "");
  if (linkText === urlWithoutProtocol) {
    return linkText;
  }

  // Also handle the simple case where link text IS the URL (no protocol in URL either)
  if (linkText === linkUrl) {
    return linkText;
  }

  return value;
}

/**
 * Clean a path value: unwrap markdown links, trim whitespace, normalize.
 */
export function cleanPathValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let cleaned = value.trim();
  cleaned = unwrapMarkdownLink(cleaned);
  // Resolve ~/ paths (common LLM mistake) using shared resolvePath
  if (cleaned.startsWith("~")) {
    cleaned = resolvePath(cleaned);
  }
  return cleaned;
}

// ─── Array Item Schema (Extra Property Stripping) ───────────────────────

/**
 * Allowed properties for array items by parent field name.
 * Common LLM mistake: duplicating parent-level params (e.g. `path`) inside
 * each array item, causing schema validation failures.
 *
 * Based on real-world failures observed in pi coding agent sessions:
 * - `edits: [{oldText, newText, path}]` → `edits: [{oldText, newText}]`
 * - `replacements: [{path, symbol, text, path}]` → `replacements: [{path, symbol, text}]`
 */
export const ARRAY_ITEM_SCHEMAS: Map<string, Set<string>> = new Map([
  ["edits", new Set(["oldText", "newText"])],
  ["replacements", new Set(["path", "symbol", "text"])],
  ["files", new Set(["path", "edits", "replacements"])],
  ["tasks", new Set(["agent", "task", "count", "output", "outputMode", "reads", "progress", "model", "skill", "cwd"])],
  ["steps", new Set(["agent", "task", "output", "outputMode", "reads", "progress", "model", "skill", "cwd"])],
  ["commands", new Set(["label", "command"])],
]);

/**
 * Strip extra properties from array items based on the field's schema.
 * Returns [repaired array, stripped property names[]].
 *
 * Example:
 *   input:  edits = [{oldText: "a", newText: "b", path: "/x"}]
 *   output: edits = [{oldText: "a", newText: "b"}], stripped = ["path"]
 */
export function stripExtraPropertiesFromItems(
  value: unknown,
  fieldName: string,
): [unknown, string[]] {
  if (!Array.isArray(value)) return [value, []];

  const allowed = ARRAY_ITEM_SCHEMAS.get(fieldName);
  if (!allowed) return [value, []];

  const strippedProps = new Set<string>();
  const repairedItems: unknown[] = [];
  let anyChanged = false;

  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      repairedItems.push(item);
      continue;
    }

    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj);
    const extraKeys = keys.filter((k) => !allowed.has(k));

    if (extraKeys.length === 0) {
      repairedItems.push(item);
      continue;
    }

    // Build cleaned object with only allowed keys
    const cleaned: Record<string, unknown> = {};
    for (const k of keys) {
      if (allowed.has(k)) {
        cleaned[k] = obj[k];
      } else {
        strippedProps.add(k);
      }
    }
    repairedItems.push(cleaned);
    anyChanged = true;
  }

  if (!anyChanged) return [value, []];
  return [repairedItems, Array.from(strippedProps)];
}

// ─── Array Repairs ────────────────────────────────────────────────────────

/**
 * Try to parse a string as JSON. If it parses to an array or object, return it.
 * This handles models that emit `"[\"a\",\"b\"]"` as a JSON string literal
 * instead of an actual array value.
 */
export function tryParseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return value;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) || (typeof parsed === "object" && parsed !== null)) {
      return parsed;
    }
    return value;
  } catch {
    return value;
  }
}

/**
 * Wrap a bare value as an array if the field expects an array.
 * Handles: "foo" → ["foo"], 42 → [42], true → [true]
 */
export function wrapAsArrayIfNeeded(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return value;
  return [value];
}

/**
 * Wrap a bare object as a single-element array.
 * Handles: {oldText, newText} → [{oldText, newText}]
 */
export function wrapObjectAsArrayIfNeeded(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) return [value];
  return value;
}

/**
 * Apply relational defaults for read/read_file tool calls.
 * Common LLM mistake: emitting only `limit` without `offset`, or vice versa.
 */
export function applyRelationalDefaults(args: Record<string, unknown>): Record<string, unknown> {
  // read_file tool: if limit is present but offset is missing, add offset=1
  if ("limit" in args && !("offset" in args)) {
    args.offset = 1;
  }

  // read_file tool: if offset is present but limit is missing, add limit=2000
  if ("offset" in args && !("limit" in args)) {
    args.limit = 2000;
  }

  return args;
}

// ─── Field Classification ────────────────────────────────────────────────

/** Returns true when the field name signals an array-like field. */
function isArrayLike(key: string, lower: string): boolean {
  return (
    ARRAY_FIELD_NAMES.has(key) ||
    lower.endsWith("_list") ||
    lower.endsWith("list") ||
    lower.endsWith("_names") ||
    lower.endsWith("names") ||
    lower.endsWith("_items") ||
    lower.endsWith("items") ||
    lower.endsWith("_array") ||
    lower.endsWith("array")
  );
}

function isBooleanField(key: string, lower: string): boolean {
  return (
    BOOLEAN_FIELD_NAMES.has(key) ||
    lower.startsWith("is_") ||
    lower.startsWith("has_") ||
    lower.startsWith("can_") ||
    lower.endsWith("_flag")
  );
}

/**
 * Check if a field name suggests it should be a number.
 * Named "looksLikeNumberField" to avoid conflict with the exported `isNumberField`.
 */
function looksLikeNumberField(key: string, lower: string): boolean {
  return (
    NUMBER_FIELD_NAMES.has(key) ||
    lower.startsWith("max") ||
    lower.startsWith("min") ||
    lower.endsWith("_count") ||
    lower.endsWith("_size") ||
    lower.endsWith("_index")
  );
}

/**
 * Classify a field and determine which repairs to apply.
 */
export function classifyField(
  key: string,
  value: unknown,
): string[] {
  const actions: string[] = [];
  const lower = key.toLowerCase();

  // Path fields: unwrap markdown links, normalize
  if (PATH_FIELD_NAMES.has(key)) {
    actions.push("clean-path");
  }

  // Content fields: never touch
  if (CONTENT_FIELD_NAMES.has(key)) {
    return [];
  }

  // String values that could be JSON
  if (typeof value === "string") {
    actions.push("parse-json");
  }

  // Array-like fields: wrap + split
  if (isArrayLike(key, lower)) {
    actions.push("wrap-array", "wrap-object-as-array", "split-string-to-array");
  }

  // Array fields with known item schemas: strip extra properties from items
  if (ARRAY_ITEM_SCHEMAS.has(key)) {
    actions.push("strip-extra-properties");
  }

  // Boolean fields that might receive string "true"/"false"/"yes"/"no"
  if (isBooleanField(key, lower)) {
    actions.push("coerce-boolean");
  }

  // Number fields that might receive string "42" instead of 42
  if (looksLikeNumberField(key, lower)) {
    actions.push("coerce-number");
  }

  return actions;
}

/**
 * Check if a value looks like a null-like string that should be omitted.
 * Common LLM mistake: emitting "null", "none", "n/a" as strings instead of
 * omitting the field entirely.
 */
export function isNullLikeString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim().toLowerCase();
  return (
    trimmed === "" ||
    trimmed === "null" ||
    trimmed === "none" ||
    trimmed === "n/a" ||
    trimmed === "na" ||
    trimmed === "undefined"
  );
}

/**
 * Try to split a comma/space-separated string into an array.
 * Common LLM mistake: emitting "foo, bar" instead of ["foo", "bar"].
 */
export function trySplitStringToArray(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (trimmed === "") return value;

  // Don't split JSON-like strings (already handled by parse-json)
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return value;

  // Don't split paths (contain / or \ )
  if (trimmed.includes("/") || trimmed.includes("\\")) return value;

  // Try comma split first (most common)
  if (trimmed.includes(",")) {
    const parts = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length > 1) return parts;
  }

  // Try space split (only for simple words, not paths or URLs)
  if (trimmed.includes(" ") && !trimmed.includes("http")) {
    const parts = trimmed
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length > 1) return parts;
  }

  return value;
}

// ─── Boolean Coercion ────────────────────────────────────────────────────

/**
 * Truthy/falsy string values for boolean coercion.
 * Based on research from canonize (stevekinney/canonize) and llm-tool-arg-coerce.
 * These cover the most common LLM outputs for boolean fields.
 */

/**
 * Coerce a string value to a boolean when the field suggests a boolean is expected.
 * Common LLM mistake: emitting "true"/"yes"/"1" as strings instead of booleans.
 *
 * Based on canonize's research: covers the full range of truthy/falsy strings
 * that LLMs and humans commonly use.
 */
export function coerceToBoolean(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const normalized = value.trim().toLowerCase();

  if (TRUTHY_STRINGS.has(normalized)) return true;
  if (FALSY_STRINGS.has(normalized)) return false;

  return value; // Unknown string — don't coerce, let it fail
}

// ─── Number Coercion ─────────────────────────────────────────────────────

/**
 * Try to coerce a string to a number when the field suggests a number is expected.
 * Common LLM mistake: emitting "42" as string instead of 42.
 *
 * Conservative approach (based on canonize + MCP SDK #1361):
 * - Only coerce if the string is clearly numeric (no trailing/leading junk)
 * - Handle integers and decimals
 * - Handle negative numbers
 * - Reject ambiguous strings like "abc" or "42abc"
 */
export function coerceToNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (trimmed === "") return value; // Empty string — don't coerce

  // Check if it's a valid number format
  // Matches: "42", "-42", "3.14", "-3.14", ".5", "-.5", "0.5"
  // Rejects: "42abc", "abc", "1,234", "42px"
  const numericPattern = /^-?\.?\d+(\.\d+)?$/;
  if (!numericPattern.test(trimmed)) {
    return value; // Not clearly numeric — don't coerce
  }

  const num = Number(trimmed);
  if (isNaN(num)) return value; // Shouldn't happen with pattern, but safety check

  return num;
}

// ─── Content Field Detection ─────────────────────────────────────────────

/**
 * Check if a field is a content field that should NEVER be repaired.
 */
export function isContentField(key: string): boolean {
  return CONTENT_FIELD_NAMES.has(key);
}

/**
 * Check if a field is a number field.
 */
export function isNumberField(key: string): boolean {
  return NUMBER_FIELD_NAMES.has(key);
}

// ─── Directory Fallback Helpers ──────────────────────────────────────────

const EISDIR_PATTERNS = [
  "eisdir",
  "illegal operation on a directory",
  "is a directory",
];

/**
 * Check if an error message is an EISDIR error from reading a directory.
 * Covers both raw Node.js error and safe/fallback messages.
 */
export function isEisdirError(text: string): boolean {
  const lower = text.toLowerCase();
  return EISDIR_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Extract text content from a tool result content array.
 */
export function extractTextContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text") {
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

/**
 * Format a directory listing result for the EISDIR fallback.
 * Pure function — no I/O, no ExtensionAPI dependency.
 *
 * @param resolvedPath - Absolute path to the directory
 * @param entries - Directory entry names
 * @param toolName - Tool name ("read" or "read_file") for contextual message
 * @returns Formatted listing content, detail string for logs, and directory name
 */
export function formatDirectoryListing(
  resolvedPath: string,
  entries: string[],
  toolName: string,
): { listingContent: string; detail: string; dirName: string } {
  const listing = entries.map((e) => `  ${e}`).join("\n");
  const dirName = path.basename(resolvedPath);

  const listingContent = [
    `📁 Directory: ${resolvedPath}`,
    "",
    "Contents:",
    listing,
    "",
    `${entries.length} entr${entries.length === 1 ? "y" : "ies"} total.`,
    "",
    `ℹ️ The model called ${toolName} on a directory. Use bash ls or ${toolName} with a specific file path inside this directory.`,
  ].join("\n");

  const detail = `${dirName}: directory fallback (${entries.length} entr${entries.length === 1 ? "y" : "ies"} listed)`;

  return { listingContent, detail, dirName };
}

// ─── Path Validation Middleware ─────────────────────────────────────────────

/**
 * Check if a bash command looks like a long-running operation
 * that might need a larger timeout.
 */
export function isLongRunningCommand(command: string): boolean {
  return LONG_RUNNING_TOKENS.some((re) => re.test(command));
}

/**
 * Suggest an appropriate timeout_seconds for a bash command.
 * Returns undefined if no change suggested.
 *
 * Rules:
 * - If no timeout provided and command is long-running → suggest 300 (5 min)
 * - If timeout < 30 and command is long-running → suggest 120 (2 min)
 * - If command has pipes (known bug with timeout enforcement) → suggest 600 (10 min)
 * - Otherwise → keep as-is
 */
export function suggestAutoTimeout(
  command: string,
  currentTimeout?: number,
): number | undefined {
  const hasPipes = /\|\s*(tee|cat|grep|sort|uniq|wc|head|tail)/.test(command);
  const isLong = isLongRunningCommand(command);

  if (!isLong && !hasPipes) return undefined;

  // Pipe commands: known timeout enforcement bug in Claude Code and OpenCode
  if (hasPipes) {
    if (currentTimeout === undefined || currentTimeout < 600) {
      return 600;
    }
    return undefined;
  }

  // Long-running command with no timeout
  if (currentTimeout === undefined) {
    return isLong && /\b(test|build|lint|compile)\b/i.test(command) ? 300 : 120;
  }

  // Long-running command with too-short timeout
  if (isLong && currentTimeout < 30) {
    return 120;
  }

  return undefined;
}

/**
 * Extract file/directory path-like string values from tool arguments.
 *
 * Returns all string values from known path fields, plus string values
 * from command fields that look like file paths.
 */
export function extractPathsFromArgs(
  args: Record<string, unknown>,
): string[] {
  const paths: string[] = [];

  // Direct path fields
  for (const key of Object.keys(args)) {
    if (PATH_FIELD_NAMES.has(key) && typeof args[key] === "string") {
      paths.push(args[key] as string);
    }
  }

  // Array fields that may contain paths (files, targets, etc.)
  if (Array.isArray(args.files)) {
    for (const file of args.files) {
      if (typeof file === "string") paths.push(file);
      else if (typeof file === "object" && file !== null) {
        const f = file as Record<string, unknown>;
        if (typeof f.path === "string") paths.push(f.path);
      }
    }
  }

  // Bash commands — extract paths/globs (anything that looks like a file reference)
  if (typeof args.command === "string") {
    const cmd = args.command as string;
    // Match quoted file paths in commands
    const quotedPaths = cmd.match(/['\"]([^'\"]+\.\w+)['\"]/g);
    if (quotedPaths) {
      for (const qp of quotedPaths) {
        paths.push(qp.replace(/['\"]/g, ""));
      }
    }
  }

  return paths;
}

// ─── Path Resolution ─────────────────────────────────────────────────────────

/** Known tools we can repair. */
export const REPAIRABLE_TOOLS = new Set([
  "read", "write", "edit", "bash",
  "read_file", "edit_file", "write_file",
  "get_file_skeleton", "get_function", "replace_symbol",
  "find_symbol_references", "rename_symbol",
  "ffgrep", "fffind",
  "agent_browser", "web_search", "fetch_content",
  "code_search", "subagent",
  "ctx_execute", "ctx_execute_file",
  "ctx_fetch_and_index", "ctx_batch_execute",
  "ctx_index", "ctx_search",
  "run_experiment", "log_experiment",
  "grep", "find", "ls",
]);

/** Tools that should get pre-flight ENOENT path validation. */
export const ENOENT_TOOLS = new Set([
  "read", "read_file", "write", "write_file",
  "edit", "edit_file", "bash", "ffgrep", "fffind",
]);

/**
 * Resolve a user-provided path, handling tilde expansion.
 * Pure function — no I/O.
 */
export function resolvePath(filePath: string, homeDir?: string): string {
  if (filePath.startsWith("~")) {
    const home = homeDir || "/home/user";
    return home + filePath.slice(1);
  }
  return filePath;
}

/**
 * Checks if a raw string looks like a URL or flag (not a file path).
 * Pure function — no I/O.
 */
export function isUrlOrFlag(value: string): boolean {
  return value.startsWith("http") || value.startsWith("-");
}

/**
 * Build path validation guidance for tool error message.
 * Pure function — no I/O.
 */
export function buildPathValidationGuidance(
  invalidPaths: string[],
  toolName: string,
): string {
  const pathList = invalidPaths.map(p => `  - ${p}`).join("\n");
  return [
    `⚠️ Path validation: ${invalidPaths.length} path(s) not found.`,
    pathList,
    "",
    "Possible fixes:",
    "  • Check the file path spelling",
    "  • The file may be in a different directory",
    "  • You may need to create the file first (use write tool)",
    "  • Use fffind or ls to discover the correct path",
  ].join("\n");
}

/**
 * Build staleness guidance for edit tool when content hash has changed.
 * Pure function — no I/O.
 */
export function buildStalenessGuidance(lastReadTurn: number): string {
  return [
    `⚠️ File content has changed since it was last read (turn ${lastReadTurn}).`,
    "The edit may overwrite newer content or the oldText no longer matches.",
    "Please re-read the file first with the read tool to get current content,",
    "then apply the edit with the exact current text as oldText.",
  ].join("\n");
}

/**
 * Build circuit break message for the LLM (7+ consecutive failures).
 * Pure function — no I/O.
 */
export function buildCircuitBreakMessage(
  toolName: string,
  consecutiveCount: number,
  errorDetails: string,
): string {
  return [
    `🔴 CIRCUIT BREAKER: Tool "${toolName}" has failed ${consecutiveCount} consecutive times.`,
    "The current approach is not working and further retries will not help.",
    "Please switch to a completely different strategy:",
    "  • If editing: use the write tool to create a new version of the file",
    "  • If reading: verify the path exists (use ls or fffind)",
    "  • If running a command: simplify the command or check syntax",
    "  • Move on to a different task entirely",
    "",
    `Error details: ${errorDetails.slice(0, 200)}`,
  ].join("\n");
}

/**
 * Build edit_file loop guidance (3+ or 5+ consecutive failures).
 * Pure function — no I/O.
 */
export function buildEditLoopGuidance(consecutiveCount: number): string {
  if (consecutiveCount >= 5) {
    return [
      `⚠️ This is attempt #${consecutiveCount} to edit the same file with the same arguments.`,
      "The edit is clearly not matching the current file content.",
      "Consider an alternative approach:",
      "  • Read the file first with the read tool, then re-apply the edit with exact text",
      "  • Use the write tool to write the entire file content (if you know the full content)",
      "  • Create a new file instead of modifying an existing one",
    ].join("\n");
  }
  return [
    `💡 Tip: ${consecutiveCount} consecutive failures on this file. `,
    "The oldText may have whitespace differences (tabs vs spaces, trailing spaces). ",
    "Read the file and check indentation carefully.",
  ].join("\n");
}

/**
 * Content hash cache for staleness detection.
 *
 * Records content hashes when files are read, so we can detect when
 * the model tries to edit a file whose content has changed since it
 * was last read.
 *
 * Pure state container — no I/O.
 */
export class ContentHashCache {
  /** path → content hash (using simple string hash) */
  private hashes = new Map<string, string>();
  /** path → turn index when last read */
  private readTurns = new Map<string, number>();

  /** Check if a file has ever been read in this session. */
  wasEverRead(filePath: string): boolean {
    return this.readTurns.has(filePath);
  }

  /** Set the current hash for a file path. */
  setHash(filePath: string, content: string): void {
    this.hashes.set(filePath, simpleHash(content));
  }

  /** Record that a file was read at a given turn. */
  recordRead(filePath: string, turn: number): void {
    this.readTurns.set(filePath, turn);
  }

  /**
   * Check if a file's content has changed since it was last recorded.
   * @returns true if the file has been modified after the last recorded read
   */
  isStale(filePath: string, currentContent: string): boolean {
    const recordedHash = this.hashes.get(filePath);
    if (recordedHash === undefined) return false; // never read, never stale
    return recordedHash !== simpleHash(currentContent);
  }

  /** Get the turn when the file was last read (or -1). */
  getLastReadTurn(filePath: string): number {
    return this.readTurns.get(filePath) ?? -1;
  }

  /** Clear all cached data. */
  reset(): void {
    this.hashes.clear();
    this.readTurns.clear();
  }

  /** Track the current files in the cache (for diagnostics). */
  get trackedFiles(): number {
    return this.hashes.size;
  }
}

/** Simple string hash (djb2 variant). Fast, no deps. */
export function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(36);
}

// ─── Dispatch Handlers ────────────────────────────────────────────────────

/**
 * Unwrap markdown links in path values.
 */
function dispatchCleanPath(value: unknown, key: string, parentKey: string): [unknown, string | null] {
  const cleaned = cleanPathValue(value);
  if (cleaned !== undefined && cleaned !== value) {
    const msg = `${parentKey}.${key}: unwrapped markdown path "${String(value).slice(0, 40)}" → "${cleaned.slice(0, 40)}"`;
    return [cleaned, msg];
  }
  return [value, null];
}

/**
 * Parse JSON strings into structured values.
 */
function dispatchParseJson(value: unknown, key: string, parentKey: string): [unknown, string | null] {
  const parsed = tryParseJsonString(value);
  if (parsed !== value) {
    const preview = typeof value === "string" ? value.slice(0, 50) : String(value).slice(0, 50);
    const msg = `${parentKey}.${key}: parsed JSON string "${preview}" → structured value`;
    return [parsed, msg];
  }
  return [value, null];
}

/**
 * Wrap a bare object in a single-element array.
 */
function dispatchWrapObjectAsArray(value: unknown, key: string, parentKey: string): [unknown, string | null] {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const msg = `${parentKey}.${key}: wrapped object → single-element array`;
    return [[value], msg];
  }
  return [value, null];
}

/**
 * Wrap non-array values as single-element arrays.
 */
function dispatchWrapArray(value: unknown, key: string, parentKey: string): [unknown, string | null] {
  const wrapped = wrapAsArrayIfNeeded(value);
  if (wrapped !== value) {
    const msg = `${parentKey}.${key}: wrapped bare "${String(value).slice(0, 30)}" → array`;
    return [wrapped, msg];
  }
  return [value, null];
}

/**
 * Split comma/space-separated strings into arrays.
 */
function dispatchSplitStringToArray(value: unknown, key: string, parentKey: string): [unknown, string | null] {
  const split = trySplitStringToArray(value);
  if (split !== value && Array.isArray(split)) {
    const msg = `${parentKey}.${key}: split string "${String(value).slice(0, 40)}" → array`;
    return [split, msg];
  }
  return [value, null];
}

/**
 * Coerce string values to boolean.
 */
function dispatchCoerceBoolean(value: unknown, key: string, parentKey: string): [unknown, string | null] {
  const coerced = coerceToBoolean(value);
  if (coerced !== value) {
    const msg = `${parentKey}.${key}: coerced "${String(value).slice(0, 30)}" → ${coerced}`;
    return [coerced, msg];
  }
  return [value, null];
}

/**
 * Coerce string values to number.
 */
function dispatchCoerceNumber(value: unknown, key: string, parentKey: string): [unknown, string | null] {
  const coerced = coerceToNumber(value);
  if (coerced !== value) {
    const msg = `${parentKey}.${key}: coerced "${String(value).slice(0, 30)}" → ${coerced}`;
    return [coerced, msg];
  }
  return [value, null];
}

/**
 * Strip extra properties from array items based on known schemas.
 */
function dispatchStripExtraProperties(value: unknown, key: string, parentKey: string): [unknown, string | null] {
  const [cleaned, stripped] = stripExtraPropertiesFromItems(value, key);
  if (cleaned !== value) {
    const msg = `${parentKey}.${key}: stripped extra props [${stripped.join(", ")}] from array items`;
    return [cleaned, msg];
  }
  return [value, null];
}

/** Lookup table mapping action names to dispatch handlers. */
const repairDispatchers = {
  "clean-path": dispatchCleanPath,
  "parse-json": dispatchParseJson,
  "wrap-object-as-array": dispatchWrapObjectAsArray,
  "wrap-array": dispatchWrapArray,
  "split-string-to-array": dispatchSplitStringToArray,
  "coerce-boolean": dispatchCoerceBoolean,
  "coerce-number": dispatchCoerceNumber,
  "strip-extra-properties": dispatchStripExtraProperties,
} as const;

// ─── Object Field Repair ───────────────────────────────────────────────────


/**
 * Apply repairs to a single field value based on its key.
 * Pure function — no I/O, no side effects.
 * Returns [repaired value, any repair descriptions].
 */
export function repairFieldValue(
	value: unknown,
	key: string,
	parentKey: string,
): [unknown, string[]] {
	const repairs: string[] = [];

	// NEVER touch content fields
	if (isContentField(key)) {
		return [value, repairs];
	}

	// ── PHASE 1: Structural repairs FIRST (before recursing into nested objects/arrays) ──
	const actions = classifyField(key, value);

	for (const action of actions) {
		const handler = repairDispatchers[action as keyof typeof repairDispatchers];
		if (handler) {
			const [newValue, repairMsg] = handler(value, key, parentKey);
			if (repairMsg) {
				value = newValue;
				repairs.push(repairMsg);
			}
		}
	}

	// ── PHASE 2: Recurse into structured values after type changes ──
	if (Array.isArray(value)) {
		const repairedItems: unknown[] = [];
		let anyChanged = false;
		for (const item of value) {
			const [repaired, itemRepairs] = repairFieldValue(item, "[item]", key);
			repairedItems.push(repaired);
			if (itemRepairs.length > 0) anyChanged = true;
		}
		if (anyChanged) {
			repairs.push(`repaired ${parentKey}.${key} nested items`);
		}
		return [repairedItems, repairs];
	}

	if (typeof value === "object" && value !== null) {
		const [repairedObj, nestedRepairs] = repairObjectFieldsWithTrace(
			value as Record<string, unknown>,
			`${parentKey}.${key}`,
		);
		repairs.push(...nestedRepairs);
		return [repairedObj, repairs];
	}

	return [value, repairs];
}

/**
 * Apply repairs to all fields in an object, returning the repaired object.
 * Repairs are applied silently (no trace output).
 * For trace output, use repairObjectFieldsWithTrace.
 * Pure function — no I/O, no side effects.
 */
export function repairObjectFields(
	obj: Record<string, unknown>,
): Record<string, unknown> {
	const [result] = repairObjectFieldsWithTrace(obj);
	return result;
}

/**
 * Apply repairs to all fields in an object, returning [repaired, repairs[]].
 * Pure function — no I/O, no side effects.
 */
export function repairObjectFieldsWithTrace(
	obj: Record<string, unknown>,
	parentKey: string = "input",
): [Record<string, unknown>, string[]] {
	const result: Record<string, unknown> = {};
	const allRepairs: string[] = [];

	for (const [key, value] of Object.entries(obj)) {
		// NEVER strip null/undefined from content fields (oldText, newText, command, code, etc.)
		// Stripping content fields would cause crashes downstream (e.g. edit tool
		// calling normalizeToLF(undefined) → .replace() on undefined). Instead,
		// convert null/undefined to empty string so the tool's own validation
		// catches it with a helpful error message rather than a cryptic TypeError.
		if (isContentField(key)) {
			if (value == null) { // catches both null and undefined
				result[key] = "";
			} else {
				result[key] = value;
			}
			continue;
		}

		// Skip null values (strip nulls) — safe for non-content fields
		if (value === null) {
			allRepairs.push(`${parentKey}.${key}: stripped null (optional field omitted)`);
			continue;
		}

		// Skip null-like strings ("null", "none", "n/a", etc.) — safe for non-content fields
		if (isNullLikeString(value)) {
			allRepairs.push(`${parentKey}.${key}: stripped null-like string "${String(value).slice(0, 30)}" (optional field omitted)`);
			continue;
		}

		// Skip number fields (don't repair numbers)
		if (isNumberField(key) && typeof value === "number") {
			result[key] = value;
			continue;
		}

		const [repaired, repairs] = repairFieldValue(value, key, parentKey);
		result[key] = repaired;
		allRepairs.push(...repairs);
	}

	return [result, allRepairs];
}

/**
 * Extract the edit index from an EDIT_MISMATCH error text.
 * Returns undefined if the error is not about a specific edit index
 * (e.g., it's about "the exact text" for single-edits without an array).
 */
export function extractFailedEditIndex(errorText: string): number | undefined {
	if (!errorText) return undefined;
	const match = errorText.match(/edits\[(\d+)\]/);
	if (match) {
		return parseInt(match[1], 10);
	}
	return undefined;
}

/**
 * Extract the file path from an EDIT_MISMATCH error text.
 * Returns undefined if no path is found.
 */
export function extractFailedEditPath(errorText: string): string | undefined {
	if (!errorText) return undefined;
	// Match capture after "in ": greedy \S+ grabs all non-whitespace,
	// then we strip trailing dot if present (sentence separator, not part of path)
	const match = errorText.match(/in\s+(\S+)/);
	if (match) {
		let p = match[1];
		// Remove trailing quotes that appeared in truncated test strings
		if (p.endsWith('"')) p = p.slice(0, -1);
		// Remove trailing dot followed by space or end (sentence separator)
		if (p.endsWith('.')) p = p.slice(0, -1);
		return p;
	}
	return undefined;
}
export function buildEditMismatchContext(
	fileContent: string,
	oldText: string,
): { contextLines: string; matchLine: number } | null {
	const lines = fileContent.split("\n");
	const oldFirstLine = oldText.split("\n")[0].trim();
	if (!oldFirstLine) return null;

	const prefix = oldFirstLine.slice(0, 40);
	const matchLine = lines.findIndex(l => l.trim().startsWith(prefix));
	if (matchLine === -1) return null;

	const start = Math.max(0, matchLine - 2);
	const end = Math.min(lines.length, matchLine + 4);
	const contextLines = lines.slice(start, end).map((l, i) => {
		const lineNum = start + i + 1;
		const marker = start + i === matchLine ? " →" : "  ";
		return `${marker} ${String(lineNum).padStart(4)}│ ${l}`;
	}).join("\n");

	return { contextLines, matchLine };
}

/**
 * Build the full enhanced EDIT_MISMATCH guidance string by combining
 * base guidance with file context from buildEditMismatchContext.
 */
export function buildEnhancedEditMismatchGuidance(
	baseGuidance: string,
	context: { contextLines: string; matchLine: number },
): string {
	return [
		baseGuidance,
		"",
		`📄 File context around the closest match to oldText:`,
		"```",
		context.contextLines,
		"```",
		`Note: line ${context.matchLine + 1} starts similarly to your oldText, but the exact`,
		`text does not match. Read the file to see the full content before editing.`,
	].join("\n");
}

/**
 * Extract the non-unique occurrence count from an edit error message.
 * Matches patterns like "Found 4 occurrences of edits[3] in ..."
 */
export function extractNonUniqueEditCount(errorMessage: string | null): number | undefined {
  if (!errorMessage) return undefined;
  // Match both "Found 4 occurrences" and "Found 1 occurrence"
  const match = errorMessage.match(/Found (\d+) occurrences?/);
  return match ? parseInt(match[1], 10) : undefined;
}

interface OldTextMatch {
  lineNumbers: number[];
  prefix: string;
}

/**
 * Find all lines in a string that start with a given prefix.
 * Used when edit.oldText matches multiple locations.
 */
export function findAllOldTextMatchLines(
  content: string,
  oldText: string
): OldTextMatch | null {
  if (!oldText || !content) return null;
  // Use the first line of oldText as the prefix (trimmed)
  const prefix = oldText.split("\n")[0].trim();
  if (!prefix) return null;
  const lines = content.split("\n");
  const lineNumbers: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(prefix)) {
      lineNumbers.push(i);
    }
  }

  if (lineNumbers.length === 0) return null;
  return { lineNumbers, prefix };
}

/**
 * Build guidance for when an edit.oldText matches multiple locations.
 */
export function buildEditNonUniqueGuidance(
  content: string,
  oldText: string,
  matchCount: number
): string | null {
  const result = findAllOldTextMatchLines(content, oldText);
  if (!result) return null;

  const firstLine = oldText.split("\n")[0].trim();
  const lines = content.split("\n");
  const prefix = firstLine;

  return [
    `Note: oldText matched ${matchCount} time(s) in the file. Try to add more context surrounding your edit to make oldText unique.`,
    "",
    `Prefix: "${prefix}"`,
    "Matching locations:",
    ...result.lineNumbers.map((ln, i) => {
      const start = Math.max(0, ln - 1);
      const end = Math.min(lines.length, ln + 2);
      const snippet = lines.slice(start, end).join("\n");
      return `  ${i + 1}. → (line ${ln + 1}):\n${snippet}`;
    }),
    "",
    `Recommended: add more surrounding context to your oldText so it matches only one location.`,
    "",
    "Tips to make your oldText unique:",
    "  • Include the line BEFORE and AFTER your edit target",
    "  • Use more lines of context",
    "  • Include indentation exactly as it appears in the file",
  ].join("\n");
}

/**
 * Build guidance suggesting an edit might target the wrong file.
 * @param errorPath The path from the error message
 * @param inputPath Optional path the user specified in the input
 */
export function buildEditWrongFileGuidance(errorPath: string, inputPath?: string): string {
  const lines: string[] = [
    `Note: The edit to "${errorPath}" appears to target a DIFFERENT file.`,
    "Your oldText matches content in another file, not the one you specified.",
    "",
    "Possible causes:",
    "  1. You're editing the wrong file — re-read the file to verify",
    "  2. File content changed — re-read the file",
    "  3. Whitespace mismatch — check indentation and trailing spaces",
    "",
    "Possible fixes:",
    "  1. Change the path to point to the correct file",
    "  2. split into separate edit calls for each file",
  ];

  if (inputPath && inputPath !== errorPath) {
    lines.push(`  3. These differ: error path "${errorPath}" vs input path "${inputPath}" — verify you are editing the intended file`);
  }

  return lines.join("\n");
}
