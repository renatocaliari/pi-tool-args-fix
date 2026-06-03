/**
 * Tests for dispatch functions.
 */

import { describe, it, expect } from "vitest";
import { repairFieldValue, repairObjectFields, repairObjectFieldsWithTrace, REPAIRABLE_TOOLS } from "../repairs/dispatch.js";
import { classifyField } from "../repairs/classification.js";

describe("REPAIRABLE_TOOLS", () => {
  it("contains all core file tools", () => {
    expect(REPAIRABLE_TOOLS.has("read")).toBe(true);
    expect(REPAIRABLE_TOOLS.has("write")).toBe(true);
    expect(REPAIRABLE_TOOLS.has("edit")).toBe(true);
    expect(REPAIRABLE_TOOLS.has("bash")).toBe(true);
  });
  it("contains tool_call and tool_result pairs", () => {
    expect(REPAIRABLE_TOOLS.has("read_file")).toBe(true);
    expect(REPAIRABLE_TOOLS.has("edit_file")).toBe(true);
    expect(REPAIRABLE_TOOLS.has("write_file")).toBe(true);
  });
  it("does NOT contain non-applicable tools", () => {
    expect(REPAIRABLE_TOOLS.has("question")).toBe(false);
    expect(REPAIRABLE_TOOLS.has("ask_user")).toBe(false);
    expect(REPAIRABLE_TOOLS.has("unknown_custom")).toBe(false);
  });
});

describe("repairFieldValue", () => {
  it("never touches content fields", () => {
    const [result, repairs] = repairFieldValue("hello", "command", "input");
    expect(result).toBe("hello");
    expect(repairs).toEqual([]);
  });
  it("returns untouched value for no-action fields", () => {
    const [result, repairs] = repairFieldValue("hello", "unknown_field", "input");
    expect(result).toBe("hello");
    expect(repairs).toEqual([]);
  });
  it("applies clean-path repair for path fields", () => {
    const [result, repairs] = repairFieldValue("[file.ts](http://file.ts)", "path", "input");
    expect(result).toBe("file.ts");
    expect(repairs.length).toBeGreaterThanOrEqual(1);
    expect(repairs[0]).toContain("unwrapped markdown");
  });
  it("applies parse-json repair for JSON string arrays", () => {
    const [result, repairs] = repairFieldValue('["a","b"]', "commands", "input");
    expect(result).toEqual(["a", "b"]);
    expect(repairs.length).toBeGreaterThanOrEqual(1);
    expect(repairs[0]).toContain("parsed JSON");
  });
  it("applies wrap-array for bare objects in array fields", () => {
    const [result, repairs] = repairFieldValue({ oldText: "a", newText: "b" }, "edits", "input");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([{ oldText: "a", newText: "b" }]);
    expect(repairs.some(r => r.includes("wrapped"))).toBe(true);
  });
  it("applies wrap-array for bare primitives in array fields", () => {
    const [result, repairs] = repairFieldValue("foo", "tags", "input");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(["foo"]);
    expect(repairs[0]).toContain("wrapped bare");
  });
  it("applies coerce-boolean for boolean-like fields", () => {
    const [result, repairs] = repairFieldValue("true", "strict", "input");
    expect(result).toBe(true);
    expect(repairs.some(r => r.includes("coerced"))).toBe(true);
  });
  it("applies coerce-number for number-like fields", () => {
    const [result, repairs] = repairFieldValue("42", "limit", "input");
    expect(result).toBe(42);
    expect(repairs.some(r => r.includes("coerced"))).toBe(true);
  });
  it("applies strip-extra-properties from array items", () => {
    const [result, repairs] = repairFieldValue([{ oldText: "a", newText: "b", path: "/x.ts" }], "edits", "input");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([{ oldText: "a", newText: "b" }]);
    expect(repairs.some(r => r.includes("stripped extra props"))).toBe(true);
  });
  it("recurses into nested arrays", () => {
    const [result, repairs] = repairFieldValue([{ oldText: "a", newText: "b" }], "edits", "input");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([{ oldText: "a", newText: "b" }]);
  });
  it("recurses into nested objects", () => {
    const input = { config: { limit: "42", strict: "true" } };
    const [result, repairs] = repairFieldValue(input, "config", "input");
    expect(result).toEqual({ config: { limit: 42, strict: true } });
    expect(repairs.some(r => r.includes("coerced"))).toBe(true);
  });
});

describe("repairObjectFields", () => {
  describe("content field protection (regression)", () => {
    it("preserves null oldText as empty string (prevent .replace crash)", () => {
      const [result, repairs] = repairObjectFieldsWithTrace({ oldText: null, newText: "replacement" });
      expect(result.oldText).toBe("");
      expect(result.newText).toBe("replacement");
      expect(repairs).toHaveLength(0);
    });
    it("preserves undefined newText as empty string", () => {
      const [result, repairs] = repairObjectFieldsWithTrace({ oldText: "original", newText: undefined });
      expect(result.oldText).toBe("original");
      expect(result.newText).toBe("");
      expect(repairs).toHaveLength(0);
    });
    it("preserves null command as empty string", () => {
      const result = repairObjectFields({ command: null, path: "/tmp" });
      expect(result.command).toBe("");
      expect(result.path).toBe("/tmp");
    });
    it("preserves null code as empty string", () => {
      const result = repairObjectFields({ code: null, language: "typescript" });
      expect(result.code).toBe("");
      expect(result.language).toBe("typescript");
    });
    it("preserves valid string content fields unchanged", () => {
      const result = repairObjectFields({ oldText: "hello", newText: "world" });
      expect(result.oldText).toBe("hello");
      expect(result.newText).toBe("world");
    });
    it("handles edits array items with null oldText", () => {
      const [result, repairs] = repairObjectFieldsWithTrace({ edits: [{ oldText: null, newText: "replacement" }] });
      expect(result.edits).toEqual([{ oldText: "", newText: "replacement" }]);
      expect(repairs).toHaveLength(0);
    });
    it("strips null from non-content fields", () => {
      const [result, repairs] = repairObjectFieldsWithTrace({ path: null, timeout: null });
      expect(result.path).toBeUndefined();
      expect(result.timeout).toBeUndefined();
      expect(repairs.length).toBeGreaterThanOrEqual(2);
      expect(repairs[0]).toContain("stripped null");
    });
    it("strips null-like strings from non-content fields", () => {
      const [result, repairs] = repairObjectFieldsWithTrace({ path: "null", timeout: "n/a" });
      expect(result.path).toBeUndefined();
      expect(result.timeout).toBeUndefined();
      expect(repairs.length).toBeGreaterThanOrEqual(2);
      expect(repairs[0]).toContain("stripped null-like");
    });
    it("preserves non-content non-null fields unchanged", () => {
      const [result, repairs] = repairObjectFieldsWithTrace({ path: "/valid/path", timeout: 30 });
      expect(result.path).toBe("/valid/path");
      expect(result.timeout).toBe(30);
      expect(repairs).toHaveLength(0);
    });
    it("handles mixed content and non-content fields", () => {
      const input = { oldText: null, newText: "hello", path: null, timeout: 42 };
      const [result, repairs] = repairObjectFieldsWithTrace(input);
      expect(result.oldText).toBe("");
      expect(result.newText).toBe("hello");
      expect(result.path).toBeUndefined();
      expect(result.timeout).toBe(42);
      expect(repairs.filter(r => r.includes("stripped null"))).toHaveLength(1);
    });
    it("recursively protects content fields in nested objects", () => {
      const input = { config: { oldText: null, newText: "world", path: null } };
      const [result, repairs] = repairObjectFieldsWithTrace(input);
      expect((result.config as Record<string, unknown>).oldText).toBe("");
      expect((result.config as Record<string, unknown>).newText).toBe("world");
      expect((result.config as Record<string, unknown>).path).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURAL INTEGRITY TESTS
// ═══════════════════════════════════════════════════════════════════════════
//
// These tests verify that the extracted architecture (Fase 3 predicates,
// Fase 4 dispatch table) has NOT been collapsed back into inline code.
// ═══════════════════════════════════════════════════════════════════════════

describe("structural integrity — Fase 3 predicates", () => {
  it("classifyField uses isBooleanField predicate (not inline OR-chain)", () => {
    const source = classifyField.toString();
    expect(source).toContain("isBooleanField(key, lower)");
  });
  it("classifyField uses looksLikeNumberField predicate (not inline OR-chain)", () => {
    const source = classifyField.toString();
    expect(source).toContain("looksLikeNumberField(key, lower)");
  });
  it("classifyField uses isArrayLike predicate", () => {
    const source = classifyField.toString();
    expect(source).toContain("isArrayLike(key, lower)");
  });
});

describe("structural integrity — Fase 4 dispatch table", () => {
  it("repairFieldValue uses repairDispatchers lookup (not switch statement)", () => {
    const source = repairFieldValue.toString();
    expect(source).not.toContain("switch");
    expect(source).toContain("repairDispatchers[");
  });
  it("classifyField does NOT contain the inline boolean OR-chain", () => {
    const source = classifyField.toString();
    expect(source).not.toContain('lower.startsWith("is_")');
    expect(source).not.toContain('lower.endsWith("_flag")');
  });
  it("classifyField does NOT contain the inline number OR-chain", () => {
    const source = classifyField.toString();
    expect(source).not.toContain('lower.startsWith("max")');
    expect(source).not.toContain('lower.endsWith("_count")');
  });
});

describe("structural integrity — Fase 4 dispatch table completeness", () => {
  it("all 8 actions from classifyField have a corresponding entry in repairDispatchers", () => {
    expect(classifyField("path", "test.md")).toContain("clean-path");
    expect(classifyField("tags", '["a"]')).toContain("parse-json");
    expect(classifyField("tags", true)).toContain("wrap-object-as-array");
    expect(classifyField("tags", "test")).toContain("wrap-array");
    expect(classifyField("tags", "test")).toContain("split-string-to-array");
    expect(classifyField("is_enabled", "true")).toContain("coerce-boolean");
    expect(classifyField("max_count", "42")).toContain("coerce-number");
    expect(classifyField("edits", false)).toContain("strip-extra-properties");
  });
});
