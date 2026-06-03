/**
 * Field classification — determines which repair strategies apply to each field.
 *
 * Pure pattern-matching functions that inspect field names and values
 * to classify fields into categories: path, array, boolean, number, content.
 */

import {
  PATH_FIELD_NAMES,
  ARRAY_FIELD_NAMES,
  BOOLEAN_FIELD_NAMES,
  CONTENT_FIELD_NAMES,
  NUMBER_FIELD_NAMES,
} from "./constants.js";
import { ARRAY_ITEM_SCHEMAS } from "./array-utils.js";

// ─── Internal Classification Predicates ────────────────────────────────

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

// ─── Exported Classification API ───────────────────────────────────────

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
