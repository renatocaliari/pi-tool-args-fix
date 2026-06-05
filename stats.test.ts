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
  formatWouldHaveRepaired,
  formatFooterSummary,
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

  it("getStatusDisplay() shows off when disabled (with analytics note)", () => {
    const t = new RepairToggle(false);
    expect(t.getStatusDisplay()).toBe("🔧 repair: off (analytics + logs still on)");
  });

  it("getStatusDisplay() makes it clear analytics still flow when off", () => {
    const t = new RepairToggle(false);
    // CoC: when off, user must not think EVERYTHING is off. The status
    // explicitly tells them analytics + logs are still on, so they don't
    // expect /repair-cache-info to return empty.
    const display = t.getStatusDisplay();
    expect(display).toContain("off");
    expect(display).toContain("analytics");
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
    expect(t.getStatusDisplay()).toBe("🔧 repair: off (analytics + logs still on)");
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
  it("shows cache metrics with guidance items = 0", () => {
    const stats = createStats();
    stats.totalInputTokens = 100_000;
    stats.totalCacheRead = 60_000;
    const output = formatCacheInfo(stats);

    expect(output).toContain("📊 Cache Impact");
    expect(output).toContain("Total sent to API:");
    expect(output).toContain("100.0K");
    expect(output).toContain("Served from cache:");
    expect(output).toContain("60.0K");
    expect(output).toContain("60.0%");
    expect(output).toContain("Computed from zero:");
    expect(output).toContain("40.0K");
    expect(output).toContain("40.0%");
    expect(output).toContain("Items: 0");
  });

  it("shows guidance items and repair-log path when guidance > 0", () => {
    const stats = createStats();
    stats.guidanceInjections = 5;
    stats.totalInputTokens = 150_000;
    stats.totalCacheRead = 100_000;
    stats.totalCacheWrite = 20_000;
    stats.sessionId = "test-session-123";
    const output = formatCacheInfo(stats);

    expect(output).toContain("📊 Cache Impact");
    expect(output).toContain("Total sent to API:");
    expect(output).toContain("150.0K");
    expect(output).toContain("Served from cache:");
    expect(output).toContain("100.0K");
    expect(output).toContain("66.7%");
    expect(output).toContain("Computed from zero:");
    expect(output).toContain("50.0K");
    expect(output).toContain("Written to cache:");
    expect(output).toContain("20.0K");
    expect(output).toContain("Items: 5");
    expect(output).toContain("test-session-123");
    expect(output).toContain(".pi/repair-log/");
  });

  it("calculates correct percentage", () => {
    const stats = createStats();
    stats.totalInputTokens = 100_000;
    stats.totalCacheRead = 60_000;
    const output = formatCacheInfo(stats);

    // 60K / 100K = 60.0%
    expect(output).toContain("60.0%");
    // computed = 40K / 100K = 40.0%
    expect(output).toContain("40.0%");
  });

  it("shows provider-did-not-report note when cacheRead is 0", () => {
    const stats = createStats();
    stats.totalInputTokens = 50_000;
    stats.totalCacheRead = 0;
    const output = formatCacheInfo(stats);

    expect(output).toContain("provider did not report cache data");
    expect(output).toContain("0.0%");
  });

  it("shows cap-suppressed count", () => {
    const stats = createStats();
    stats.guidanceInjections = 10;
    stats.guidanceSuppressed = 3;
    stats.totalInputTokens = 100_000;
    const output = formatCacheInfo(stats);

    expect(output).toContain("Items: 10");
    expect(output).toContain("Suppressed by 2000-char cap: 3");
  });

  it("omits suppressed line when 0 (no noise)", () => {
    const stats = createStats();
    stats.totalInputTokens = 50_000;
    const output = formatCacheInfo(stats);

    expect(output).not.toContain("Suppressed by 2000-char cap");
  });

  // ─── formatWouldHaveRepaired Tests (G3 surface) ────────────────────────────
  describe("formatWouldHaveRepaired", () => {
    it("returns one-liner when nothing was skipped", () => {
      const stats = createStats();
      const output = formatWouldHaveRepaired(stats);
      expect(output).toContain("🔍 Would have repaired (if repair was ON): 0");
      expect(output).toContain("no skipped events");
    });

    it("shows breakdown by repair type with total", () => {
      const stats = createStats();
      stats.wouldHaveRepairedTotal = 47;
      stats.wouldHaveRepairedByType.set("stripped null", 23);
      stats.wouldHaveRepairedByType.set("wrapped bare → array", 12);
      stats.wouldHaveRepairedByType.set("coerced boolean", 8);
      stats.wouldHaveRepairedByType.set("directory fallback", 4);
      const output = formatWouldHaveRepaired(stats);
      expect(output).toContain("🔍 Would have repaired (if repair was ON):");
      expect(output).toContain("stripped null");
      expect(output).toContain("23");
      expect(output).toContain("wrapped bare");
      expect(output).toContain("12");
      expect(output).toContain("Total");
      expect(output).toContain("47");
    });

    it("sorts by count descending (most frequent first)", () => {
      const stats = createStats();
      stats.wouldHaveRepairedTotal = 10;
      stats.wouldHaveRepairedByType.set("rare type", 1);
      stats.wouldHaveRepairedByType.set("common type", 9);
      const output = formatWouldHaveRepaired(stats);
      const commonIdx = output.indexOf("common type");
      const rareIdx = output.indexOf("rare type");
      expect(commonIdx).toBeLessThan(rareIdx);
    });

    it("footer shows impact: X of Y tool calls (Z%) when totalToolCalls > 0", () => {
      const stats = createStats();
      stats.totalToolCalls = 23;
      stats.wouldHaveRepairedTotal = 12;
      stats.wouldHaveRepairedByType.set("stripped null", 12);
      const output = formatWouldHaveRepaired(stats);
      // 12 of 23 = 52%
      expect(output).toContain("Impact: 12 of 23 tool calls (52%) had arg issues while OFF");
    });

    it("footer omitted when totalToolCalls is 0 (no denominator)", () => {
      const stats = createStats();
      stats.wouldHaveRepairedTotal = 5;
      stats.wouldHaveRepairedByType.set("stripped null", 5);
      const output = formatWouldHaveRepaired(stats);
      expect(output).not.toContain("Impact:");
    });
  });

  describe("createStats — wouldHaveRepaired fields initialized", () => {
    it("initializes wouldHaveRepairedByType as empty Map and total to 0", () => {
      const stats = createStats();
      expect(stats.wouldHaveRepairedByType).toBeInstanceOf(Map);
      expect(stats.wouldHaveRepairedByType.size).toBe(0);
      expect(stats.wouldHaveRepairedTotal).toBe(0);
    });

    it("initializes totalToolCalls to 0", () => {
      const stats = createStats();
      expect(stats.totalToolCalls).toBe(0);
    });
  });

  it("shows zero stats when no cache data", () => {
    const stats = createStats();
    stats.guidanceInjections = 1;
    const output = formatCacheInfo(stats);

    expect(output).toContain("Total sent to API:");
    expect(output).toContain("Served from cache:");
    expect(output).toContain("Computed from zero:");
  });

  it("shows repair log path in output", () => {
    const stats = createStats();
    stats.sessionId = "test-abc";
    const output = formatCacheInfo(stats);

    expect(output).toContain(".pi/repair-log/");
    expect(output).toContain("test-abc");
  });

// ─── formatFooterSummary Tests ────────────────────────────────────────

describe("formatFooterSummary", () => {
  it("returns 'no activity' when stats are empty", () => {
    const stats = createStats();
    expect(formatFooterSummary(stats)).toBe("🔧 repair: on  —  no activity");
  });

  it("shows repairs count", () => {
    const stats = createStats();
    recordRepairs(stats, ["path.a: parsed JSON string → array"]);
    const output = formatFooterSummary(stats);
    expect(output).toContain("1 repairs");
    expect(output).not.toContain("guidance");
    expect(output).not.toContain("suppressed");
  });

  it("shows guidance count", () => {
    const stats = createStats();
    stats.guidanceInjections = 7;
    const output = formatFooterSummary(stats);
    expect(output).toContain("7 guidance");
    expect(output).not.toContain("repairs");
  });

  it("shows suppressed count", () => {
    const stats = createStats();
    stats.guidanceSuppressed = 3;
    const output = formatFooterSummary(stats);
    expect(output).toContain("3 suppressed");
  });

  it("shows all three stats together", () => {
    const stats = createStats();
    recordRepairs(stats, ["path.a: parsed JSON string → array"]);
    stats.guidanceInjections = 7;
    stats.guidanceSuppressed = 1;
    const output = formatFooterSummary(stats);
    expect(output).toContain("1 repairs");
    expect(output).toContain("7 guidance");
    expect(output).toContain("1 suppressed");
  });

  it("uses pipe separators", () => {
    const stats = createStats();
    recordRepairs(stats, ["path.a: parsed JSON string → array"]);
    stats.guidanceInjections = 3;
    const output = formatFooterSummary(stats);
    expect(output).toContain("|");
    expect(output).toMatch(/🔧 /);
  });
});
});
