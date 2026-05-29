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
  isEisdirError,
  extractTextContent,
  formatDirectoryListing,
  stripExtraPropertiesFromItems,
  ARRAY_ITEM_SCHEMAS,
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

// ─── EISDIR Detection Tests ─────────────────────────────────────────

describe("isEisdirError", () => {
  it("detects raw Node.js EISDIR error", () => {
    expect(isEisdirError("EISDIR: illegal operation on a directory, read")).toBe(true);
  });

  it("detects just the EISDIR code", () => {
    expect(isEisdirError("EISDIR")).toBe(true);
  });

  it("detects 'illegal operation on a directory' message", () => {
    expect(isEisdirError("illegal operation on a directory")).toBe(true);
  });

  it("detects 'is a directory' safe error", () => {
    expect(isEisdirError("/path/to/dir is a directory")).toBe(true);
  });

  it("detects mixed-case variations", () => {
    expect(isEisdirError("EisDir")).toBe(true);
    expect(isEisdirError("Illegal Operation on a Directory")).toBe(true);
  });

  it("does NOT false-positive on other errors", () => {
    expect(isEisdirError("ENOENT: no such file or directory")).toBe(false);
    expect(isEisdirError("EACCES: permission denied")).toBe(false);
    expect(isEisdirError("Command failed with exit code 1")).toBe(false);
    expect(isEisdirError("Connection refused")).toBe(false);
  });
});

// ─── Extract Text Content Tests ──────────────────────────────────────

describe("extractTextContent", () => {
  it("extracts text from tool result content array", () => {
    const content = [{ type: "text", text: "Hello, world!" }];
    expect(extractTextContent(content)).toBe("Hello, world!");
  });

  it("extracts text from multi-part content", () => {
    const content = [
      { type: "image", url: "img.png" },
      { type: "text", text: "Result text" },
    ];
    expect(extractTextContent(content)).toBe("Result text");
  });

  it("returns null for non-array content", () => {
    expect(extractTextContent("string")).toBeNull();
    expect(extractTextContent({})).toBeNull();
    expect(extractTextContent(null)).toBeNull();
    expect(extractTextContent(undefined)).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(extractTextContent([])).toBeNull();
  });

  it("returns null when no text part exists", () => {
    const content = [{ type: "image", url: "img.png" }];
    expect(extractTextContent(content)).toBeNull();
  });

  it("handles content with isError metadata", () => {
    const content = [{ type: "text", text: "EISDIR: illegal operation on a directory, read" }];
    expect(extractTextContent(content)).toBe("EISDIR: illegal operation on a directory, read");
  });
});

// ─── Directory Listing Format Tests ────────────────────────────────────

describe("formatDirectoryListing", () => {
  it("formats listing for read tool with multiple entries", () => {
    const result = formatDirectoryListing(
      "/home/user/project/src",
      ["main.ts", "utils.ts", "components"],
      "read",
    );
    expect(result.listingContent).toContain("Directory: /home/user/project/src");
    expect(result.listingContent).toContain("Contents:");
    expect(result.listingContent).toContain("  main.ts");
    expect(result.listingContent).toContain("  utils.ts");
    expect(result.listingContent).toContain("  components");
    expect(result.listingContent).toContain("3 entries total.");
    expect(result.listingContent).toContain("The model called read on a directory.");
    expect(result.detail).toBe("src: directory fallback (3 entries listed)");
    expect(result.dirName).toBe("src");
  });

  it("formats listing for read_file tool with single entry", () => {
    const result = formatDirectoryListing(
      "/home/user/project",
      ["main.ts"],
      "read_file",
    );
    expect(result.listingContent).toContain("Directory: /home/user/project");
    expect(result.listingContent).toContain("1 entry total.");
    expect(result.listingContent).toContain("The model called read_file on a directory.");
    expect(result.detail).toBe("project: directory fallback (1 entry listed)");
    expect(result.dirName).toBe("project");
  });

  it("handles empty directory", () => {
    const result = formatDirectoryListing("/empty/dir", [], "read");
    expect(result.listingContent).toContain("0 entries total.");
    expect(result.detail).toBe("dir: directory fallback (0 entries listed)");
  });

  it("uses singular 'entry' for count of 1", () => {
    const result = formatDirectoryListing("/x", ["a"], "read");
    expect(result.listingContent).toContain("1 entry total.");
  });

  it("uses plural 'entries' for non-1 count", () => {
    const result1 = formatDirectoryListing("/x", ["a", "b"], "read");
    expect(result1.listingContent).toContain("2 entries total.");

    const result0 = formatDirectoryListing("/x", [], "read");
    expect(result0.listingContent).toContain("0 entries total.");
  });
});

// ─── Strip Extra Properties Tests

describe("stripExtraPropertiesFromItems", () => {
  it("strips path from edits[] items (real-world failure)", () => {
    const input = [
      { oldText: "label: 'Lucro Liquido',", newText: "label: 'Resultado Liquido',", path: "/src/file.tsx" },
      { oldText: "if (v === null)", newText: "if (v === null || !isFinite(v))", path: "/api/utils.ts" },
    ];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "edits");
    expect(result).toEqual([
      { oldText: "label: 'Lucro Liquido',", newText: "label: 'Resultado Liquido'," },
      { oldText: "if (v === null)", newText: "if (v === null || !isFinite(v))" },
    ]);
    expect(stripped).toEqual(["path"]);
  });

  it("strips multiple extra properties", () => {
    const input = [
      { oldText: "a", newText: "b", path: "/x", unused: 1, extra: true },
    ];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "edits");
    expect(result).toEqual([{ oldText: "a", newText: "b" }]);
    expect(stripped).toEqual(["path", "unused", "extra"]);
  });

  it("preserves all allowed properties", () => {
    const input = [
      { oldText: "a", newText: "b" },
    ];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "edits");
    expect(result).toEqual([{ oldText: "a", newText: "b" }]);
    expect(stripped).toEqual([]);
  });

  it("does NOT touch non-array values", () => {
    const input = { oldText: "a", newText: "b", path: "/x" };
    const [result, stripped] = stripExtraPropertiesFromItems(input, "edits");
    expect(result).toBe(input);
    expect(stripped).toEqual([]);
  });

  it("does NOT touch arrays with unknown field names", () => {
    const input = [{ foo: 1, bar: 2 }];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "unknown_field");
    expect(result).toBe(input);
    expect(stripped).toEqual([]);
  });

  it("handles empty arrays", () => {
    const [result, stripped] = stripExtraPropertiesFromItems([], "edits");
    expect(result).toEqual([]);
    expect(stripped).toEqual([]);
  });

  it("handles mixed: some items need repair, some don't", () => {
    const input = [
      { oldText: "a", newText: "b" },              // clean
      { oldText: "c", newText: "d", path: "/x" },  // has extra
    ];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "edits");
    expect(result).toEqual([
      { oldText: "a", newText: "b" },
      { oldText: "c", newText: "d" },
    ]);
    expect(stripped).toEqual(["path"]);
  });

  it("handles replacements[] items", () => {
    const input = [
      { path: "/x", symbol: "HandleRequest", text: "func...", extra: true },
    ];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "replacements");
    expect(result).toEqual([
      { path: "/x", symbol: "HandleRequest", text: "func..." },
    ]);
    expect(stripped).toEqual(["extra"]);
  });

  it("handles tasks[] items with extra props", () => {
    const input = [
      { agent: "scout", task: "investigate", bogus: "yes" },
    ];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "tasks");
    expect(result).toEqual([
      { agent: "scout", task: "investigate" },
    ]);
    expect(stripped).toEqual(["bogus"]);
  });

  it("handles commands[] items", () => {
    const input = [
      { label: "test", command: "npm test", path: "/x", timeout: 30 },
    ];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "commands");
    expect(result).toEqual([
      { label: "test", command: "npm test" },
    ]);
    expect(stripped).toEqual(["path", "timeout"]);
  });

  it("skips non-object items in array", () => {
    const input = ["string", 42, null, { oldText: "a", newText: "b", path: "/x" }];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "edits");
    expect(result).toEqual(["string", 42, null, { oldText: "a", newText: "b" }]);
    expect(stripped).toEqual(["path"]);
  });

  it("skips array items in array", () => {
    const input = [[1, 2], { oldText: "a", newText: "b" }];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "edits");
    expect(result).toEqual([[1, 2], { oldText: "a", newText: "b" }]);
    expect(stripped).toEqual([]);
  });
});
