/**
 * Tests for `summarizeRepairs` — the cache-key discriminator for repair notices.
 *
 * The function powers the one-shot dedup key for `🔧 tool: <summary>` notices
 * pushed to the LLM. Same summary = same key = one injection per session.
 * Stability and correctness of this function directly affect LLM prefix cache
 * hit rate: a too-eager key (collides on summary-irrelevant features like
 * byte length) suppresses valuable guidance; a too-loose key (collides
 * rarely) wastes cache budget on duplicate notices.
 */

import { describe, it, expect } from "vitest";
import { summarizeRepairs } from "./utils.js";

describe("summarizeRepairs — stripped key detection", () => {
  it("emits 'stripped null' when a null field is removed", () => {
    const result = summarizeRepairs(
      { command: "echo hi", extra: null },
      { command: "echo hi" },
    );
    expect(result).toContain("extra: stripped null");
  });

  it("emits 'stripped' for non-null removed fields", () => {
    const result = summarizeRepairs(
      { command: "echo", path: "/tmp" },
      { command: "echo" },
    );
    expect(result).toContain("path: stripped");
  });

  it("emits one entry per stripped key (multiple nulls)", () => {
    const result = summarizeRepairs(
      { command: "echo", a: null, b: null, c: null },
      { command: "echo" },
    );
    expect(result).toContain("a: stripped null");
    expect(result).toContain("b: stripped null");
    expect(result).toContain("c: stripped null");
  });

  it("does NOT emit stripped entries for keys that survived unchanged", () => {
    const result = summarizeRepairs(
      { command: "echo", path: "/tmp" },
      { command: "echo", path: "/tmp" },
    );
    expect(result).toEqual([]);
  });
});

describe("summarizeRepairs — added/changed key detection", () => {
  it("emits 'added' for keys injected by repair (e.g., auto-timeout)", () => {
    const result = summarizeRepairs(
      { command: "npm install" },
      { command: "npm install", timeout: 120000 },
    );
    expect(result).toContain("timeout: added");
  });

  it("emits 'coerced boolean' for boolean string→bool conversion", () => {
    const result = summarizeRepairs(
      { dryRun: "true" },
      { dryRun: true },
    );
    expect(result.some((s) => s.includes("coerced boolean"))).toBe(true);
  });

  it("emits 'wrapped bare' for plain string→array (no JSON-like content)", () => {
    const result = summarizeRepairs(
      { files: "src/index.ts" },
      { files: ["src/index.ts"] },
    );
    expect(result).toContain("files: wrapped bare → array");
  });

  it("emits 'parsed JSON string' when source string looks like JSON", () => {
    const result = summarizeRepairs(
      { files: '["a","b"]' },
      { files: ["a", "b"] },
    );
    expect(result).toContain("files: parsed JSON string → array");
  });

  it("emits 'parsed JSON string' for object-like source strings", () => {
    const result = summarizeRepairs(
      { data: '{"k":1}' },
      { data: [{ k: 1 }] },
    );
    expect(result).toContain("data: parsed JSON string → array");
  });

  it("emits 'parsed JSON string' for quoted source strings", () => {
    const result = summarizeRepairs(
      { data: '"hello"' },
      { data: ["hello"] },
    );
    expect(result).toContain("data: parsed JSON string → array");
  });

  it("ignores leading/trailing whitespace when sniffing JSON-likeness", () => {
    const result = summarizeRepairs(
      { files: '  ["a"]  ' },
      { files: ["a"] },
    );
    expect(result).toContain("files: parsed JSON string → array");
  });
});

describe("summarizeRepairs — cache-key stability", () => {
  it("same logical repair produces same summary (cache dedup works)", () => {
    const a = summarizeRepairs(
      { command: "echo", extra: null },
      { command: "echo" },
    );
    const b = summarizeRepairs(
      { command: "ls", extra: null },
      { command: "ls" },
    );
    // Different original, same field stripped → same summary
    expect(a).toEqual(b);
  });

  it("different fields stripped produce different summaries (no false dedup)", () => {
    const a = summarizeRepairs(
      { command: "echo", extra: null },
      { command: "echo" },
    );
    const b = summarizeRepairs(
      { command: "echo", other: null },
      { command: "echo" },
    );
    // Different field name → different summary (cache key differs)
    expect(a).not.toEqual(b);
  });

  it("input byte length does not affect summary (old bug regression guard)", () => {
    // Pre-fix: key was based on originalJson.length. Two repairs with same
    // length but different field names would falsely dedupe. Post-fix: key
    // is summary-based, so the LLM gets the correct guidance for each.
    const short1 = summarizeRepairs(
      { a: 1, x: null },
      { a: 1 },
    );
    const short2 = summarizeRepairs(
      { a: 1, y: null },
      { a: 1 },
    );
    expect(short1).not.toEqual(short2);
  });
});

describe("summarizeRepairs — prefix passthrough for nested objects", () => {
  it("uses prefix in emitted keys when recursing", () => {
    const result = summarizeRepairs(
      { meta: { tag: "x", extra: null } },
      { meta: { tag: "x" } },
      "",
    );
    expect(result).toContain("meta.extra: stripped null");
  });
});
