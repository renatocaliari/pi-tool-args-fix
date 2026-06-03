/**
 * Tests for array utility repair functions.
 */

import { describe, it, expect } from "vitest";
import { tryParseJsonString, wrapAsArrayIfNeeded, wrapObjectAsArrayIfNeeded, applyRelationalDefaults, stripExtraPropertiesFromItems } from "../repairs/array-utils.js";

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
    expect(tryParseJsonString('"just a string"')).toBe('"just a string"');
    expect(tryParseJsonString("42")).toBe("42");
    expect(tryParseJsonString("true")).toBe("true");
  });
  it("passes through non-string values", () => {
    expect(tryParseJsonString(["a", "b"])).toEqual(["a", "b"]);
    expect(tryParseJsonString({ key: "value" })).toEqual({ key: "value" });
  });
});

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
    expect(wrapObjectAsArrayIfNeeded({ oldText: "a", newText: "b" })).toEqual([{ oldText: "a", newText: "b" }]);
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

describe("applyRelationalDefaults", () => {
  it("adds offset=1 when only limit is present", () => {
    expect(applyRelationalDefaults({ limit: 30 })).toEqual({ limit: 30, offset: 1 });
  });
  it("adds limit=2000 when only offset is present", () => {
    expect(applyRelationalDefaults({ offset: 10 })).toEqual({ offset: 10, limit: 2000 });
  });
  it("does NOT modify when both are present", () => {
    expect(applyRelationalDefaults({ limit: 30, offset: 1 })).toEqual({ limit: 30, offset: 1 });
  });
  it("does NOT modify when neither is present", () => {
    expect(applyRelationalDefaults({ path: "file.txt" })).toEqual({ path: "file.txt" });
  });
});

describe("stripExtraPropertiesFromItems", () => {
  it("strips path from edits[] items", () => {
    const input = [
      { oldText: "a", newText: "b", path: "/src/file.tsx" },
      { oldText: "c", newText: "d", path: "/api/utils.ts" },
    ];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "edits");
    expect(result).toEqual([{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }]);
    expect(stripped).toEqual(["path"]);
  });
  it("strips multiple extra properties", () => {
    const input = [{ oldText: "a", newText: "b", path: "/x", unused: 1, extra: true }];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "edits");
    expect(result).toEqual([{ oldText: "a", newText: "b" }]);
    expect(stripped).toEqual(["path", "unused", "extra"]);
  });
  it("preserves all allowed properties", () => {
    const input = [{ oldText: "a", newText: "b" }];
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
    const input = [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d", path: "/x" }];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "edits");
    expect(result).toEqual([{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }]);
    expect(stripped).toEqual(["path"]);
  });
  it("handles replacements[] items", () => {
    const input = [{ path: "/x", symbol: "HandleRequest", text: "func...", extra: true }];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "replacements");
    expect(result).toEqual([{ path: "/x", symbol: "HandleRequest", text: "func..." }]);
    expect(stripped).toEqual(["extra"]);
  });
  it("handles tasks[] items with extra props", () => {
    const input = [{ agent: "scout", task: "investigate", bogus: "yes" }];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "tasks");
    expect(result).toEqual([{ agent: "scout", task: "investigate" }]);
    expect(stripped).toEqual(["bogus"]);
  });
  it("handles commands[] items", () => {
    const input = [{ label: "test", command: "npm test", path: "/x", timeout: 30 }];
    const [result, stripped] = stripExtraPropertiesFromItems(input, "commands");
    expect(result).toEqual([{ label: "test", command: "npm test" }]);
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
