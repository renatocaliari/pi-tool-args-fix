/**
 * Tests for getGuidancePriority — pure function, deterministic.
 * Each priority band is tested with representative guidance text.
 */

import { describe, it, expect } from "vitest";
import { getGuidancePriority } from "../repairs/guidance-priority.js";

describe("getGuidancePriority", () => {
  // Priority 0: Circuit breaker
  it("returns 0 for circuit breaker guidance", () => {
    expect(getGuidancePriority("🔴 CIRCUIT BREAKER: Tool \"bash\" has failed multiple consecutive times.")).toBe(0);
    expect(getGuidancePriority("🔴 CIRCUIT BREAKER: Tool \"edit\" has failed multiple consecutive times.")).toBe(0);
  });

  // Priority 1: Staleness
  it("returns 1 for staleness guidance", () => {
    expect(getGuidancePriority("⚠️ File content has changed since it was last read.")).toBe(1);
    expect(getGuidancePriority("⚠️ File content has changed since it was last read.\nDetails...")).toBe(1);
  });

  // Priority 2: Sequential overlap
  it("returns 2 for sequential edit overlap guidance", () => {
    expect(getGuidancePriority("⚠️ You are editing the same region of `index.ts` again without re-reading.")).toBe(2);
  });

  // Priority 3: EDIT_MISMATCH group
  it("returns 3 for wrong file guidance", () => {
    expect(getGuidancePriority("Note: The edit to \"/a.ts\" appears to target a DIFFERENT file.")).toBe(3);
  });

  it("returns 3 for non-unique oldText guidance", () => {
    expect(getGuidancePriority("Note: oldText matched 3 time(s) in the file.")).toBe(3);
  });

  it("returns 3 for edit loop guidance (major)", () => {
    expect(getGuidancePriority("⚠️ Repeated attempts to edit the same file with the same arguments have failed.")).toBe(3);
  });

  it("returns 3 for edit loop guidance (minor)", () => {
    expect(getGuidancePriority("💡 Tip: Multiple consecutive failures on this file.")).toBe(3);
  });

  // Priority 4: Path validation
  it("returns 4 for path validation guidance", () => {
    expect(getGuidancePriority("⚠️ Path validation: 2 path(s) not found.")).toBe(4);
    expect(getGuidancePriority("⚠️ Path validation: 1 path(s) referenced in the command were not found.")).toBe(4);
  });

  // Priority 5: Empty search loop
  it("returns 5 for empty search loop guidance", () => {
    expect(getGuidancePriority("⚠️  grep \"foobar\" returned no results.")).toBe(5);
    expect(getGuidancePriority("⚠️  ls \"nonexistent\" returned no results.")).toBe(5);
  });

  // Priority 6: Tool help
  it("returns 6 for tool help guidance (starts with 'The ')", () => {
    expect(getGuidancePriority("The bash tool runs shell commands.")).toBe(6);
    expect(getGuidancePriority("The edit tool replaces exact text in a file.")).toBe(6);
    expect(getGuidancePriority("The grep tool searches for patterns in files.")).toBe(6);
    expect(getGuidancePriority("The \"read\" tool was not found by the runtime.")).toBe(6);
  });

  // Priority 7: Generic
  it("returns 7 for generic guidance", () => {
    expect(getGuidancePriority("🔧 bash: repaired array")).toBe(7);
    expect(getGuidancePriority("📊 analysis data")).toBe(7);
    expect(getGuidancePriority("")).toBe(7);
  });

  // Edge cases
  it("handles empty string", () => {
    expect(getGuidancePriority("")).toBe(7);
  });

  it("handles very long strings", () => {
    const long = "The ".repeat(1000);
    expect(getGuidancePriority(long)).toBe(6);
  });

  it("matches circuit breaker before other patterns", () => {
    // Circuit breaker contains "circuit breaker" not other priority keywords
    const text = "🔴 CIRCUIT BREAKER: Tool \"bash\" has failed. The tool rejected the arguments.";
    expect(getGuidancePriority(text)).toBe(0);
  });

  it("matches staleness before path validation when both keywords present", () => {
    const text = "⚠️ File content has changed. ⚠️ Path validation also triggered.";
    expect(getGuidancePriority(text)).toBe(1);
  });
});
