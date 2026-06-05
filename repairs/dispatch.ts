/**
 * Dispatch layer — applies repair actions to field values.
 *
 * Contains the 8 dispatch handlers, the repair dispatchers lookup table,
 * and the main repair functions (repairFieldValue, repairObjectFields,
 * repairObjectFieldsWithTrace).
 */

import { cleanPathValue } from "./path-utils.js";
import {
  tryParseJsonString,
  wrapAsArrayIfNeeded,
  stripExtraPropertiesFromItems,
} from "./array-utils.js";
import {
  isNullLikeString,
  trySplitStringToArray,
  coerceToBoolean,
  coerceToNumber,
} from "./coercion.js";
import { classifyField, isContentField, isNumberField } from "./classification.js";

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
const repairDispatchers: Record<string, (value: unknown, key: string, parentKey: string) => [unknown, string | null]> = {
  "clean-path": dispatchCleanPath,
  "parse-json": dispatchParseJson,
  "wrap-object-as-array": dispatchWrapObjectAsArray,
  "wrap-array": dispatchWrapArray,
  "split-string-to-array": dispatchSplitStringToArray,
  "coerce-boolean": dispatchCoerceBoolean,
  "coerce-number": dispatchCoerceNumber,
  "strip-extra-properties": dispatchStripExtraProperties,
};

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
    const handler = repairDispatchers[action];
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

    // DRY NOTE: the strip rules above (null, null-like) MUST mirror the
    // matching classification in `summarizeRepairs` (handlers/utils.ts). If
    // you add a new strip rule here, add a corresponding `stripped` entry
    // there. Format can differ; the *set* of conditions must not.

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
