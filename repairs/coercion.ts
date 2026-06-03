/**
 * Type coercion repair functions.
 *
 * Handles boolean string coercion ("true" → true, "yes" → true, etc.),
 * number string coercion ("42" → 42), null-like string detection,
 * and comma/space-separated string-to-array splitting.
 */

import { TRUTHY_STRINGS, FALSY_STRINGS } from "./constants.js";

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
