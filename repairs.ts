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

// ─── Field Classification ────────────────────────────────────────────────

export const PATH_FIELD_NAMES = new Set([
  "path",
  "absolutePath",
  "filePath",
  "directory",
  "cwd",
  "target",
  "dir",
  "modulePath",
]);

export const ARRAY_FIELD_NAMES = new Set([
  "edits",
  "files",
  "replacements",
  "paths",
  "function_names",
  "functionNames",
  "symbols",
  "queries",
  "urls",
  "commands",
  "steps",
  "args",
  "values",
  "items",
  "extensions",
  "include",
  "exclude",
  "options",
  "headers",
  "tasks",
  "patterns",
  "names",
  "ids",
  "schemas",
  "messages",
  "prompts",
  "parameters",
  "responses",
  "tools",
  "skills",
  "tags",
  "categories",
  "roles",
  "permissions",
]);

export const BOOLEAN_FIELD_NAMES = new Set([
  "strict",
  "force",
  "dry_run",
  "dryRun",
  "verbose",
  "quiet",
  "silent",
  "debug",
  "enabled",
  "disabled",
  "optional",
  "required",
  "recursive",
  "followSymlinks",
  "follow_symlinks",
  "includeHidden",
  "include_hidden",
]);

export const CONTENT_FIELD_NAMES = new Set([
  "content",
  "text",
  "command",
  "oldText",
  "old_text",
  "newText",
  "new_text",
  "code",
  "source",
  "data",
  "body",
  "message",
  "description",
  "instructions",
  "prompt",
  "summary",
  "comment",
  "note",
]);

export const NUMBER_FIELD_NAMES = new Set([
  "offset",
  "limit",
  "timeout",
  "timeout_seconds",
  "concurrency",
  "maxTokens",
  "max_tokens",
  "maxResults",
  "max_results",
  "numResults",
  "num_results",
  "start_line",
  "end_line",
  "port",
  "ttl",
  "context",
  "maxDepth",
  "maxFiles",
  "retries",
  "interval",
]);

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
  // Resolve relative paths to absolute (common LLM mistake: ~/ paths)
  if (cleaned.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "/home/user";
    cleaned = path.join(home, cleaned.slice(2));
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
  if (
    BOOLEAN_FIELD_NAMES.has(key) ||
    lower.startsWith("is_") ||
    lower.startsWith("has_") ||
    lower.startsWith("can_") ||
    lower.endsWith("_flag")
  ) {
    actions.push("coerce-boolean");
  }

  // Number fields that might receive string "42" instead of 42
  if (
    NUMBER_FIELD_NAMES.has(key) ||
    lower.startsWith("max") ||
    lower.startsWith("min") ||
    lower.endsWith("_count") ||
    lower.endsWith("_size") ||
    lower.endsWith("_index")
  ) {
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
export const TRUTHY_STRINGS = new Set([
  "true",
  "yes",
  "on",
  "y",
  "t",
  "enabled",
  "1",
]);
export const FALSY_STRINGS = new Set([
  "false",
  "no",
  "off",
  "n",
  "f",
  "disabled",
  "0",
]);

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
		switch (action) {
			case "clean-path": {
				const cleaned = cleanPathValue(value);
				if (cleaned !== undefined && cleaned !== value) {
					if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
						repairs.push(`${parentKey}.${key}: unwrapped markdown path "${String(value).slice(0, 40)}" → "${cleaned.slice(0, 40)}"`);
					}
					value = cleaned;
				}
				break;
			}
			case "parse-json": {
				const parsed = tryParseJsonString(value);
				if (parsed !== value) {
					const preview =
						typeof value === "string" ? value.slice(0, 50) : String(value).slice(0, 50);
					repairs.push(`${parentKey}.${key}: parsed JSON string "${preview}" → structured value`);
					value = parsed;
				}
				break;
			}
			case "wrap-object-as-array": {
				if (typeof value === "object" && value !== null && !Array.isArray(value)) {
					repairs.push(`${parentKey}.${key}: wrapped object → single-element array`);
					value = [value];
				}
				break;
			}
			case "wrap-array": {
				const wrapped = wrapAsArrayIfNeeded(value);
				if (wrapped !== value) {
					repairs.push(`${parentKey}.${key}: wrapped bare "${String(value).slice(0, 30)}" → array`);
					value = wrapped;
				}
				break;
			}
			case "split-string-to-array": {
				const split = trySplitStringToArray(value);
				if (split !== value && Array.isArray(split)) {
					repairs.push(`${parentKey}.${key}: split string "${String(value).slice(0, 40)}" → array`);
					value = split;
				}
				break;
			}
			case "coerce-boolean": {
				const coerced = coerceToBoolean(value);
				if (coerced !== value) {
					repairs.push(`${parentKey}.${key}: coerced "${String(value).slice(0, 30)}" → ${coerced}`);
					value = coerced;
				}
				break;
			}
			case "coerce-number": {
				const coerced = coerceToNumber(value);
				if (coerced !== value) {
					repairs.push(`${parentKey}.${key}: coerced "${String(value).slice(0, 30)}" → ${coerced}`);
					value = coerced;
				}
				break;
			}
			case "strip-extra-properties": {
				const [cleaned, stripped] = stripExtraPropertiesFromItems(value, key);
				if (cleaned !== value) {
					repairs.push(`${parentKey}.${key}: stripped extra props [${stripped.join(", ")}] from array items`);
					value = cleaned;
				}
				break;
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
