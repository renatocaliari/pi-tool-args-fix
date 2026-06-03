/**
 * Array repair utility functions.
 *
 * Handles JSON string parsing, array wrapping, object-to-array wrapping,
 * relational default injection, and extra property stripping from array items.
 */

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

// ─── JSON Parsing & Array Wrapping ─────────────────────────────────────

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
