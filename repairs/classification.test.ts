/**
 * Tests for field classification repair functions.
 */

import { describe, it, expect } from "vitest";
import { classifyField, isContentField, isNumberField } from "../repairs/classification.js";

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
