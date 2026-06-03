/**
 * Tests for coercion repair functions.
 */

import { describe, it, expect } from "vitest";
import { isNullLikeString, trySplitStringToArray, coerceToBoolean, coerceToNumber } from "../repairs/coercion.js";

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

describe("trySplitStringToArray", () => {
  it("splits comma-separated strings", () => {
    expect(trySplitStringToArray("foo, bar, baz")).toEqual(["foo", "bar", "baz"]);
  });
  it("splits space-separated strings", () => {
    expect(trySplitStringToArray("foo bar baz")).toEqual(["foo", "bar", "baz"]);
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
    expect(trySplitStringToArray("https://example.com")).toBe("https://example.com");
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
