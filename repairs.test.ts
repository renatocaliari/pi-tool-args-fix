/**
 * Unit tests for repair functions.
 *
 * Based on cali-product-testing-ai-code principles:
 * - TDD for critical business logic (repair functions are critical)
 * - No mocks for simple functions (pure functions, no dependencies)
 * - Test edge cases and false positive prevention
 * - Mutation score target: 70% (critical paths)
 *
 * Each repair function is tested independently with:
 * - Happy path (normal cases)
 * - Edge cases (boundary conditions)
 * - False positive prevention (should NOT repair valid input)
 */

import { describe, it, expect } from "vitest";
import {
  unwrapMarkdownLink,
  cleanPathValue,
  tryParseJsonString,
  wrapAsArrayIfNeeded,
  wrapObjectAsArrayIfNeeded,
  applyRelationalDefaults,
  classifyField,
  isNullLikeString,
  trySplitStringToArray,
  coerceToBoolean,
  coerceToNumber,
  isContentField,
  isNumberField,
} from "./repairs.js";

// ─── Path Repair Tests ──────────────────────────────────────────────────

describe("unwrapMarkdownLink", () => {
  it("unwraps markdown link where text equals URL without protocol", () => {
    expect(unwrapMarkdownLink("[notes.md](http://notes.md)")).toBe("notes.md");
    expect(unwrapMarkdownLink("[file.ts](https://file.ts)")).toBe("file.ts");
    expect(unwrapMarkdownLink("[data.json](file://data.json)")).toBe("data.json");
  });

  it("unwraps when link text equals URL exactly", () => {
    expect(unwrapMarkdownLink("[file.ts](file.ts)")).toBe("file.ts");
  });

  it("does NOT unwrap real markdown links", () => {
    expect(unwrapMarkdownLink("[click here](https://example.com)")).toBe(
      "[click here](https://example.com)"
    );
    expect(unwrapMarkdownLink("[docs](https://docs.example.com)")).toBe(
      "[docs](https://docs.example.com)"
    );
  });

  it("passes through non-string values", () => {
    expect(unwrapMarkdownLink(42 as any)).toBe(42);
    expect(unwrapMarkdownLink(null as any)).toBe(null);
  });

  it("passes through plain strings", () => {
    expect(unwrapMarkdownLink("notes.md")).toBe("notes.md");
    expect(unwrapMarkdownLink("/path/to/file")).toBe("/path/to/file");
  });
});

describe("cleanPathValue", () => {
  it("trims whitespace", () => {
    expect(cleanPathValue("  notes.md  ")).toBe("notes.md");
  });

  it("unwraps markdown links", () => {
    expect(cleanPathValue("[notes.md](http://notes.md)")).toBe("notes.md");
  });

  it("resolves ~/ paths", () => {
    const result = cleanPathValue("~/Documents/notes.md");
    expect(result).toContain("Documents/notes.md");
    expect(result).not.toContain("~");
  });

  it("returns undefined for non-strings", () => {
    expect(cleanPathValue(42)).toBeUndefined();
    expect(cleanPathValue(null)).toBeUndefined();
  });
});

// ─── JSON Parse Tests ───────────────────────────────────────────────────

describe("tryParseJsonString", () => {
  it("parses JSON array strings", () => {
    expect(tryParseJsonString('["a","b","c"]')).toEqual(["a", "b", "c"]);
    expect(tryParseJsonString("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("parses JSON object strings", () => {
    expect(tryParseJsonString('{"key":"value"}')).toEqual({ key: "value" });
  });

  it("does NOT parse non-JSON strings", () => {
    expect(tryParseJsonString("hello world")).toBe("hello world");
    expect(tryParseJsonString("foo, bar")).toBe("foo, bar");
  });

  it("does NOT parse invalid JSON", () => {
    expect(tryParseJsonString("[invalid")).toBe("[invalid");
    expect(tryParseJsonString("{invalid}")).toBe("{invalid}");
  });

  it("does NOT parse JSON primitives", () => {
    // JSON primitives like "42" and "true" are valid JSON, but tryParseJsonString
    // only returns parsed values for arrays and objects (not primitives)
    expect(tryParseJsonString('"just a string"')).toBe('"just a string"');
    expect(tryParseJsonString("42")).toBe("42"); // String "42" is not parsed
    expect(tryParseJsonString("true")).toBe("true"); // String "true" is not parsed
  });

  it("passes through non-string values", () => {
    expect(tryParseJsonString(["a", "b"])).toEqual(["a", "b"]);
    expect(tryParseJsonString({ key: "value" })).toEqual({ key: "value" });
  });
});

// ─── Array Wrap Tests ───────────────────────────────────────────────────

describe("wrapAsArrayIfNeeded", () => {
  it("wraps bare strings", () => {
    expect(wrapAsArrayIfNeeded("foo")).toEqual(["foo"]);
  });

  it("wraps bare numbers", () => {
    expect(wrapAsArrayIfNeeded(42)).toEqual([42]);
  });

  it("wraps bare booleans", () => {
    expect(wrapAsArrayIfNeeded(true)).toEqual([true]);
  });

  it("does NOT wrap arrays", () => {
    expect(wrapAsArrayIfNeeded(["foo"])).toEqual(["foo"]);
  });

  it("does NOT wrap null/undefined", () => {
    expect(wrapAsArrayIfNeeded(null)).toBeNull();
    expect(wrapAsArrayIfNeeded(undefined)).toBeUndefined();
  });
});

describe("wrapObjectAsArrayIfNeeded", () => {
  it("wraps bare objects", () => {
    expect(wrapObjectAsArrayIfNeeded({ oldText: "a", newText: "b" })).toEqual([
      { oldText: "a", newText: "b" },
    ]);
  });

  it("does NOT wrap arrays", () => {
    const arr = [{ oldText: "a" }];
    expect(wrapObjectAsArrayIfNeeded(arr)).toBe(arr);
  });

  it("does NOT wrap primitives", () => {
    expect(wrapObjectAsArrayIfNeeded("foo")).toBe("foo");
    expect(wrapObjectAsArrayIfNeeded(42)).toBe(42);
  });
});

// ─── Relational Defaults Tests ──────────────────────────────────────────

describe("applyRelationalDefaults", () => {
  it("adds offset=1 when only limit is present", () => {
    const result = applyRelationalDefaults({ limit: 30 });
    expect(result).toEqual({ limit: 30, offset: 1 });
  });

  it("adds limit=2000 when only offset is present", () => {
    const result = applyRelationalDefaults({ offset: 10 });
    expect(result).toEqual({ offset: 10, limit: 2000 });
  });

  it("does NOT modify when both are present", () => {
    const result = applyRelationalDefaults({ limit: 30, offset: 1 });
    expect(result).toEqual({ limit: 30, offset: 1 });
  });

  it("does NOT modify when neither is present", () => {
    const result = applyRelationalDefaults({ path: "file.txt" });
    expect(result).toEqual({ path: "file.txt" });
  });
});

// ─── Field Classification Tests ─────────────────────────────────────────

describe("classifyField", () => {
  it("returns clean-path for path fields", () => {
    const actions = classifyField("path", "test.txt");
    expect(actions).toContain("clean-path");
  });

  it("returns empty array for content fields", () => {
    const actions = classifyField("code", "console.log('hello')");
    expect(actions).toEqual([]);
  });

  it("returns parse-json for string values", () => {
    const actions = classifyField("commands", '["ls", "pwd"]');
    expect(actions).toContain("parse-json");
  });

  it("returns wrap-array for array fields", () => {
    const actions = classifyField("edits", { oldText: "a", newText: "b" });
    expect(actions).toContain("wrap-array");
    expect(actions).toContain("wrap-object-as-array");
  });

  it("returns coerce-boolean for boolean fields", () => {
    const actions = classifyField("strict", "true");
    expect(actions).toContain("coerce-boolean");
  });

  it("returns coerce-number for number fields", () => {
    const actions = classifyField("limit", "42");
    expect(actions).toContain("coerce-number");
  });

  it("returns split-string-to-array for array fields with strings", () => {
    const actions = classifyField("tags", "admin, user");
    expect(actions).toContain("split-string-to-array");
  });

  it("detects boolean fields by prefix", () => {
    expect(classifyField("is_active", true)).toContain("coerce-boolean");
    expect(classifyField("has_permission", true)).toContain("coerce-boolean");
    expect(classifyField("can_edit", true)).toContain("coerce-boolean");
  });

  it("detects number fields by prefix/suffix", () => {
    expect(classifyField("max_tokens", 100)).toContain("coerce-number");
    expect(classifyField("min_count", 5)).toContain("coerce-number");
    expect(classifyField("retry_count", 3)).toContain("coerce-number");
  });
});

// ─── Null-Like String Tests ─────────────────────────────────────────────

describe("isNullLikeString", () => {
  it("detects null-like strings", () => {
    expect(isNullLikeString("null")).toBe(true);
    expect(isNullLikeString("NULL")).toBe(true);
    expect(isNullLikeString("Null")).toBe(true);
    expect(isNullLikeString("none")).toBe(true);
    expect(isNullLikeString("n/a")).toBe(true);
    expect(isNullLikeString("na")).toBe(true);
    expect(isNullLikeString("undefined")).toBe(true);
    expect(isNullLikeString("")).toBe(true);
    expect(isNullLikeString("  ")).toBe(true);
  });

  it("does NOT detect non-null-like strings", () => {
    expect(isNullLikeString("hello")).toBe(false);
    expect(isNullLikeString("0")).toBe(false);
    expect(isNullLikeString("false")).toBe(false);
    expect(isNullLikeString("undefined_value")).toBe(false);
  });

  it("passes through non-strings", () => {
    expect(isNullLikeString(null)).toBe(false);
    expect(isNullLikeString(42)).toBe(false);
    expect(isNullLikeString(undefined)).toBe(false);
  });
});

// ─── String Split Tests ─────────────────────────────────────────────────

describe("trySplitStringToArray", () => {
  it("splits comma-separated strings", () => {
    expect(trySplitStringToArray("foo, bar, baz")).toEqual([
      "foo",
      "bar",
      "baz",
    ]);
  });

  it("splits space-separated strings", () => {
    expect(trySplitStringToArray("foo bar baz")).toEqual([
      "foo",
      "bar",
      "baz",
    ]);
  });

  it("trims whitespace from parts", () => {
    expect(trySplitStringToArray("  foo ,  bar  ")).toEqual(["foo", "bar"]);
  });

  it("does NOT split JSON-like strings", () => {
    expect(trySplitStringToArray('["foo", "bar"]')).toBe('["foo", "bar"]');
    expect(trySplitStringToArray('{"foo": "bar"}')).toBe('{"foo": "bar"}');
  });

  it("does NOT split paths", () => {
    expect(trySplitStringToArray("/path/to/file")).toBe("/path/to/file");
    expect(trySplitStringToArray("C:\\Users\\file")).toBe("C:\\Users\\file");
  });

  it("does NOT split URLs", () => {
    expect(trySplitStringToArray("https://example.com")).toBe(
      "https://example.com"
    );
  });

  it("does NOT split single values", () => {
    expect(trySplitStringToArray("foo")).toBe("foo");
  });

  it("does NOT split empty strings", () => {
    expect(trySplitStringToArray("")).toBe("");
  });

  it("passes through non-strings", () => {
    expect(trySplitStringToArray(["foo", "bar"])).toEqual(["foo", "bar"]);
    expect(trySplitStringToArray(42)).toBe(42);
  });
});

// ─── Boolean Coercion Tests ─────────────────────────────────────────────

describe("coerceToBoolean", () => {
  it("coerces truthy strings", () => {
    expect(coerceToBoolean("true")).toBe(true);
    expect(coerceToBoolean("yes")).toBe(true);
    expect(coerceToBoolean("on")).toBe(true);
    expect(coerceToBoolean("y")).toBe(true);
    expect(coerceToBoolean("t")).toBe(true);
    expect(coerceToBoolean("enabled")).toBe(true);
    expect(coerceToBoolean("1")).toBe(true);
  });

  it("coerces falsy strings", () => {
    expect(coerceToBoolean("false")).toBe(false);
    expect(coerceToBoolean("no")).toBe(false);
    expect(coerceToBoolean("off")).toBe(false);
    expect(coerceToBoolean("n")).toBe(false);
    expect(coerceToBoolean("f")).toBe(false);
    expect(coerceToBoolean("disabled")).toBe(false);
    expect(coerceToBoolean("0")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(coerceToBoolean("TRUE")).toBe(true);
    expect(coerceToBoolean("Yes")).toBe(true);
    expect(coerceToBoolean("FALSE")).toBe(false);
    expect(coerceToBoolean("No")).toBe(false);
  });

  it("handles whitespace", () => {
    expect(coerceToBoolean("  true  ")).toBe(true);
    expect(coerceToBoolean("  false  ")).toBe(false);
  });

  it("does NOT coerce unknown strings", () => {
    expect(coerceToBoolean("maybe")).toBe("maybe");
    expect(coerceToBoolean("hello")).toBe("hello");
    expect(coerceToBoolean("2")).toBe("2");
  });

  it("passes through non-strings", () => {
    expect(coerceToBoolean(true)).toBe(true);
    expect(coerceToBoolean(false)).toBe(false);
    expect(coerceToBoolean(1)).toBe(1);
    expect(coerceToBoolean(0)).toBe(0);
  });
});

// ─── Number Coercion Tests ──────────────────────────────────────────────

describe("coerceToNumber", () => {
  it("coerces integer strings", () => {
    expect(coerceToNumber("42")).toBe(42);
    expect(coerceToNumber("-42")).toBe(-42);
    expect(coerceToNumber("0")).toBe(0);
  });

  it("coerces decimal strings", () => {
    expect(coerceToNumber("3.14")).toBe(3.14);
    expect(coerceToNumber("-3.14")).toBe(-3.14);
    expect(coerceToNumber(".5")).toBe(0.5);
  });

  it("does NOT coerce ambiguous strings", () => {
    expect(coerceToNumber("42abc")).toBe("42abc");
    expect(coerceToNumber("abc")).toBe("abc");
    expect(coerceToNumber("1,234")).toBe("1,234");
    expect(coerceToNumber("42px")).toBe("42px");
    expect(coerceToNumber("$100")).toBe("$100");
  });

  it("does NOT coerce empty strings", () => {
    expect(coerceToNumber("")).toBe("");
  });

  it("handles whitespace", () => {
    expect(coerceToNumber("  42  ")).toBe(42);
    expect(coerceToNumber("  -3.14  ")).toBe(-3.14);
  });

  it("passes through non-strings", () => {
    expect(coerceToNumber(42)).toBe(42);
    expect(coerceToNumber(3.14)).toBe(3.14);
    expect(coerceToNumber(null)).toBeNull();
  });
});

// ─── Content Field Detection Tests ──────────────────────────────────────

describe("isContentField", () => {
  it("detects content fields", () => {
    expect(isContentField("content")).toBe(true);
    expect(isContentField("text")).toBe(true);
    expect(isContentField("command")).toBe(true);
    expect(isContentField("code")).toBe(true);
    expect(isContentField("oldText")).toBe(true);
    expect(isContentField("newText")).toBe(true);
    expect(isContentField("message")).toBe(true);
    expect(isContentField("prompt")).toBe(true);
  });

  it("does NOT detect non-content fields", () => {
    expect(isContentField("path")).toBe(false);
    expect(isContentField("limit")).toBe(false);
    expect(isContentField("strict")).toBe(false);
    expect(isContentField("context")).toBe(false);
  });
});

// ─── Number Field Detection Tests ───────────────────────────────────────

describe("isNumberField", () => {
  it("detects number fields", () => {
    expect(isNumberField("offset")).toBe(true);
    expect(isNumberField("limit")).toBe(true);
    expect(isNumberField("timeout")).toBe(true);
    expect(isNumberField("maxTokens")).toBe(true);
    expect(isNumberField("port")).toBe(true);
  });

  it("does NOT detect non-number fields", () => {
    expect(isNumberField("path")).toBe(false);
    expect(isNumberField("content")).toBe(false);
    expect(isNumberField("strict")).toBe(false);
  });
});
