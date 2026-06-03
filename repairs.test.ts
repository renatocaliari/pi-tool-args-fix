/**
 * Barrel-level tests for the repairs module.
 *
 * These tests verify barrel exports and structural integrity
 * that can only be tested against the barrel ./repairs.js entry point.
 */

import { describe, it, expect } from "vitest";

// ─── Constants Barrel Tests ──────────────────────────────────────────────

describe("structural integrity — constants barrel", () => {
  it("exports PATH_FIELD_NAMES from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.PATH_FIELD_NAMES).toBeDefined();
    expect(mod.PATH_FIELD_NAMES.has("path")).toBe(true);
  });
  it("exports ARRAY_FIELD_NAMES from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.ARRAY_FIELD_NAMES).toBeDefined();
    expect(mod.ARRAY_FIELD_NAMES.has("edits")).toBe(true);
  });
  it("exports BOOLEAN_FIELD_NAMES from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.BOOLEAN_FIELD_NAMES).toBeDefined();
    expect(mod.BOOLEAN_FIELD_NAMES.has("force")).toBe(true);
  });
  it("exports CONTENT_FIELD_NAMES from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.CONTENT_FIELD_NAMES).toBeDefined();
    expect(mod.CONTENT_FIELD_NAMES.has("command")).toBe(true);
  });
  it("exports NUMBER_FIELD_NAMES from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.NUMBER_FIELD_NAMES).toBeDefined();
    expect(mod.NUMBER_FIELD_NAMES.has("timeout")).toBe(true);
  });
  it("exports FALSY_STRINGS from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.FALSY_STRINGS).toBeDefined();
    expect(mod.FALSY_STRINGS.has("false")).toBe(true);
  });
  it("exports TRUTHY_STRINGS from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.TRUTHY_STRINGS).toBeDefined();
    expect(mod.TRUTHY_STRINGS.has("true")).toBe(true);
  });
  it("exports LONG_RUNNING_TOKENS from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.LONG_RUNNING_TOKENS).toBeDefined();
    expect(Array.isArray(mod.LONG_RUNNING_TOKENS)).toBe(true);
  });
});

// ─── editPath Scoping in index.ts ────────────────────────────────────────

describe("structural integrity — editPath scoping in index.ts", () => {
  function readIndexSource(): string {
    const fs = require("fs");
    return fs.readFileSync(require.resolve("./index.ts"), "utf-8");
  }

  it("editPath is declared at handler scope, before Step 3c", () => {
    const source = readIndexSource();
    const step3cMarker = source.indexOf("// ── Step 3c:");
    expect(step3cMarker).toBeGreaterThan(0);
    const beforeStep3c = source.slice(0, step3cMarker);
    expect(beforeStep3c).toContain("let editPath: string | undefined");
  });

  it("editPath is NOT re-declared inside Step 3c block", () => {
    const source = readIndexSource();
    const step3cStart = source.indexOf("// ── Step 3c:");
    const step3dStart = source.indexOf("// ── Step 3d:");
    const step3cBlock = source.slice(step3cStart, step3dStart);
    const occurrences = step3cBlock.match(/let editPath/g);
    expect(occurrences).toBeNull();
  });

  it("editPath is referenced in Step 3d (sequential overlap detection)", () => {
    const source = readIndexSource();
    const step3dStart = source.indexOf("// ── Step 3d:");
    const recordStart = source.indexOf("// ── Record previous");
    const step3dBlock = source.slice(step3dStart, recordStart);
    expect(step3dBlock).toContain("editPath");
  });

  it("editPath is referenced in Record previous edit state block", () => {
    const source = readIndexSource();
    const recordStart = source.indexOf("// ── Record previous");
    const handlerEnd = source.indexOf('pi.on("tool_result"', source.indexOf("// ── Record previous"));
    const recordBlock = source.slice(recordStart, handlerEnd > 0 ? handlerEnd : recordStart + 300);
    expect(recordBlock).toContain("editPath");
  });
});
