/**
 * Unit tests for repair statistics module.
 *
 * Based on cali-product-testing-ai-code principles:
 * - TDD for critical business logic
 * - Test edge cases and formatting
 */

import { describe, it, expect } from "vitest";
import {
  RepairToggle,
  parseRepairType,
  createStats,
  recordRepairs,
  formatStats,
  formatCacheInfo,
} from "./stats.js";

// ─── RepairToggle Tests ────────────────────────────────────────────────

describe("RepairToggle", () => {
  it("starts enabled by default", () => {
    const t = new RepairToggle();
    expect(t.isEnabled()).toBe(true);
  });

  it("accepts custom initial state (disabled)", () => {
    const t = new RepairToggle(false);
    expect(t.isEnabled()).toBe(false);
  });

  it("accepts custom initial state (enabled)", () => {
    const t = new RepairToggle(true);
    expect(t.isEnabled()).toBe(true);
  });

  it("on() enables a disabled toggle", () => {
    const t = new RepairToggle(false);
    t.on();
    expect(t.isEnabled()).toBe(true);
  });

  it("on() is idempotent — calling twice keeps enabled", () => {
    const t = new RepairToggle(true);
    t.on();
    t.on();
    expect(t.isEnabled()).toBe(true);
  });

  it("off() disables an enabled toggle", () => {
    const t = new RepairToggle(true);
    t.off();
    expect(t.isEnabled()).toBe(false);
  });

  it("off() is idempotent — calling twice keeps disabled", () => {
    const t = new RepairToggle(false);
    t.off();
    t.off();
    expect(t.isEnabled()).toBe(false);
  });

  it("toggle() flips from enabled to disabled", () => {
    const t = new RepairToggle(true);
    expect(t.toggle()).toBe(false);
    expect(t.isEnabled()).toBe(false);
  });

  it("toggle() flips from disabled to enabled", () => {
    const t = new RepairToggle(false);
    expect(t.toggle()).toBe(true);
    expect(t.isEnabled()).toBe(true);
  });

  it("toggle() returns the new state", () => {
    const t = new RepairToggle(true);
    expect(t.toggle()).toBe(false);
    expect(t.toggle()).toBe(true);
    expect(t.toggle()).toBe(false);
  });

  it("getStatusDisplay() shows on when enabled", () => {
    const t = new RepairToggle(true);
    expect(t.getStatusDisplay()).toBe("🔧 repair: on");
  });

  it("getStatusDisplay() shows off when disabled", () => {
    const t = new RepairToggle(false);
    expect(t.getStatusDisplay()).toBe("🔧 repair: off");
  });

  it("getNotifyMessage() shows auto-repaired when on", () => {
    const t = new RepairToggle(true);
    expect(t.getNotifyMessage()).toBe(
      "🔧 repair: on — tool arguments will be auto-repaired"
    );
  });

  it("getNotifyMessage() shows pass-through when off", () => {
    const t = new RepairToggle(false);
    expect(t.getNotifyMessage()).toBe(
      "🔧 repair: off — tool arguments pass through unrepaired"
    );
  });

  it("full state cycle: on → off → on → off", () => {
    const t = new RepairToggle(true);
    expect(t.isEnabled()).toBe(true);
    t.off();
    expect(t.isEnabled()).toBe(false);
    t.on();
    expect(t.isEnabled()).toBe(true);
    t.off();
    expect(t.isEnabled()).toBe(false);
  });

  it("status display updates after toggle", () => {
    const t = new RepairToggle(true);
    expect(t.getStatusDisplay()).toBe("🔧 repair: on");
    t.toggle();
    expect(t.getStatusDisplay()).toBe("🔧 repair: off");
    t.toggle();
    expect(t.getStatusDisplay()).toBe("🔧 repair: on");
  });

  it("notify message updates after toggle", () => {
    const t = new RepairToggle(true);
    expect(t.getNotifyMessage()).toContain("will be auto-repaired");
    t.toggle();
    expect(t.getNotifyMessage()).toContain("pass through unrepaired");
  });
});

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

// ─── formatCacheInfo Tests ─────────────────────────────────────────────

describe("formatCacheInfo", () => {
  it("returns 'no guidance' message when guidanceInjections is 0", () => {
    const stats = createStats();
    const output = formatCacheInfo(stats);

    expect(output).toContain("No guidance injections this session");
    expect(output).toContain("Guidance items queued: 0");
  });

  it("shows full output when guidanceInjections > 0", () => {
    const stats = createStats();
    stats.guidanceInjections = 5;
    stats.totalCacheRead = 100_000;
    stats.totalCacheWrite = 20_000;
    stats.totalUncachedInput = 30_000;
    const output = formatCacheInfo(stats);

    expect(output).toContain("📊 Cache Impact");
    expect(output).toContain("Guidance items queued: 5");
    expect(output).toContain("LLM cache hit rate");
    expect(output).toContain("Cache reads:");
    expect(output).toContain("Cache writes:");
    expect(output).toContain("Uncached:");
    expect(output).toContain("Session cost so far:");
    expect(output).toContain("vs no cache:");
  });

  it("calculates correct hit rate", () => {
    const stats = createStats();
    stats.guidanceInjections = 1;
    stats.totalCacheRead = 60_000;
    stats.totalCacheWrite = 20_000;
    stats.totalUncachedInput = 20_000;
    const output = formatCacheInfo(stats);

    // totalInput = 100K, hit rate = 60%
    expect(output).toContain("60.0% hit rate");
  });

  it("shows zero stats when no cache data", () => {
    const stats = createStats();
    stats.guidanceInjections = 1;
    const output = formatCacheInfo(stats);

    expect(output).toContain("Total input:    0");
    expect(output).toContain("Session cost so far: $0.00");
    expect(output).toContain("saving $0.00");
  });

  it("contains the 4-rule pattern description", () => {
    const stats = createStats();
    const output = formatCacheInfo(stats);

    expect(output).toContain("4-rule pattern");
    expect(output).toContain("static cutoff + one-shot + byte-deterministic + stable position");
  });
});
