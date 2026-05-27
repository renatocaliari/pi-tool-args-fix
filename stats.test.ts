/**
 * Unit tests for repair statistics module.
 *
 * Based on cali-product-testing-ai-code principles:
 * - TDD for critical business logic
 * - Test edge cases and formatting
 */

import { describe, it, expect } from "vitest";
import {
  parseRepairType,
  createStats,
  recordRepairs,
  formatStats,
} from "./stats.js";

// ─── parseRepairType Tests ─────────────────────────────────────────────

describe("parseRepairType", () => {
  it("parses 'parsed JSON' from detail string", () => {
    const detail = 'path.edits: parsed JSON string \'["a","b"]\' → array';
    expect(parseRepairType(detail)).toBe("parsed JSON");
  });

  it("parses 'wrapped bare' from detail string", () => {
    const detail = "path.commands: wrapped bare \"foo\" → array";
    expect(parseRepairType(detail)).toBe("wrapped bare");
  });

  it("parses 'wrapped object' from detail string", () => {
    const detail = "path.edits: wrapped object → single-element array";
    expect(parseRepairType(detail)).toBe("wrapped object");
  });

  it("parses 'unwrapped markdown' from detail string", () => {
    const detail = 'path.path: unwrapped markdown "[file.md](url)" → "file.md"';
    expect(parseRepairType(detail)).toBe("unwrapped markdown");
  });

  it("parses 'split string' from detail string", () => {
    const detail = 'path.tags: split string "admin, user" → array';
    expect(parseRepairType(detail)).toBe("split string");
  });

  it("parses 'coerced boolean' from detail string", () => {
    const detail = 'path.strict: coerced boolean "true" → true';
    expect(parseRepairType(detail)).toBe("coerced boolean");
  });

  it("parses 'coerced number' from detail string", () => {
    const detail = 'path.limit: coerced number "42" → 42';
    expect(parseRepairType(detail)).toBe("coerced number");
  });

  it("parses 'stripped null' from detail string", () => {
    const detail = "path.optional: stripped null";
    expect(parseRepairType(detail)).toBe("stripped null");
  });

  it("returns null for unrecognized repair type", () => {
    const detail = "path.field: something else";
    expect(parseRepairType(detail)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRepairType("")).toBeNull();
  });
});

// ─── createStats Tests ─────────────────────────────────────────────────

describe("createStats", () => {
  it("creates empty stats object", () => {
    const stats = createStats();
    expect(stats.totalRepairs).toBe(0);
    expect(stats.repairTypeStats.size).toBe(0);
  });
});

// ─── recordRepairs Tests ───────────────────────────────────────────────

describe("recordRepairs", () => {
  it("increments total repairs count", () => {
    const stats = createStats();
    recordRepairs(stats, ["path.field: parsed JSON string → array"]);
    expect(stats.totalRepairs).toBe(1);
  });

  it("tracks repair type counts", () => {
    const stats = createStats();
    recordRepairs(stats, [
      "path.a: parsed JSON string → array",
      "path.b: parsed JSON string → array",
    ]);
    expect(stats.repairTypeStats.get("parsed JSON")).toBe(2);
  });

  it("tracks multiple repair types", () => {
    const stats = createStats();
    recordRepairs(stats, [
      "path.a: parsed JSON string → array",
      "path.b: wrapped bare \"foo\" → array",
      "path.c: coerced boolean \"true\" → true",
    ]);
    expect(stats.repairTypeStats.get("parsed JSON")).toBe(1);
    expect(stats.repairTypeStats.get("wrapped bare")).toBe(1);
    expect(stats.repairTypeStats.get("coerced boolean")).toBe(1);
    expect(stats.totalRepairs).toBe(3);
  });

  it("increments total for each call", () => {
    const stats = createStats();
    recordRepairs(stats, ["path.a: parsed JSON string → array"]);
    recordRepairs(stats, ["path.b: wrapped bare \"foo\" → array"]);
    expect(stats.totalRepairs).toBe(2);
  });

  it("ignores unrecognized repair types", () => {
    const stats = createStats();
    recordRepairs(stats, ["path.field: something unknown"]);
    expect(stats.totalRepairs).toBe(0);
    expect(stats.repairTypeStats.size).toBe(0);
  });

  it("handles empty repair details", () => {
    const stats = createStats();
    recordRepairs(stats, []);
    expect(stats.totalRepairs).toBe(0);
    expect(stats.repairTypeStats.size).toBe(0);
  });
});

// ─── formatStats Tests ─────────────────────────────────────────────────

describe("formatStats", () => {
  it("returns message for zero repairs", () => {
    const stats = createStats();
    expect(formatStats(stats)).toBe("No repairs applied in this session.");
  });

  it("formats single repair type", () => {
    const stats = createStats();
    recordRepairs(stats, ["path.a: parsed JSON string → array"]);
    const output = formatStats(stats);

    expect(output).toContain("Repair Type");
    expect(output).toContain("Count");
    expect(output).toContain("parsed JSON");
    expect(output).toContain("1");
    expect(output).toContain("100%");
    expect(output).toContain("Total");
  });

  it("sorts by count descending", () => {
    const stats = createStats();
    recordRepairs(stats, [
      "path.a: parsed JSON string → array",
      "path.b: parsed JSON string → array",
      "path.c: parsed JSON string → array",
      "path.d: wrapped bare \"foo\" → array",
    ]);
    const output = formatStats(stats);
    const lines = output.split("\n");

    // Find lines with repair types (skip header and separator)
    const repairLines = lines.filter(
      (l) => l.includes("parsed JSON") || l.includes("wrapped bare")
    );

    // parsed JSON (3) should come before wrapped bare (1)
    expect(repairLines[0]).toContain("parsed JSON");
    expect(repairLines[1]).toContain("wrapped bare");
  });

  it("calculates percentages correctly", () => {
    const stats = createStats();
    recordRepairs(stats, [
      "path.a: parsed JSON string → array",
      "path.b: parsed JSON string → array",
      "path.c: wrapped bare \"foo\" → array",
    ]);
    const output = formatStats(stats);

    // parsed JSON: 2/3 = 67%
    expect(output).toContain("67%");
    // wrapped bare: 1/3 = 33%
    expect(output).toContain("33%");
  });

  it("aligns columns properly", () => {
    const stats = createStats();
    recordRepairs(stats, [
      "path.a: parsed JSON string → array",
      "path.b: wrapped bare \"foo\" → array",
    ]);
    const output = formatStats(stats);
    const lines = output.split("\n");

    // Check that columns are aligned (fixed width)
    expect(lines[0]).toBe("Repair Type   Count    %");
    expect(lines[1]).toBe("------------------------");
  });

  it("includes total line", () => {
    const stats = createStats();
    recordRepairs(stats, ["path.a: parsed JSON string → array"]);
    const output = formatStats(stats);

    expect(output).toContain("Total");
    expect(output).toContain("1");
  });
});
