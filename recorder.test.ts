/**
 * Unit tests for repair event recorder module.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type RepairEvent,
  getRepairLogDir,
  sessionLogPath,
  ensureDir,
  recordEvent,
  readSessionEvents,
  readAllEvents,
  pruneOldSessions,
  aggregateStats,
  computeBlindspots,
  extractRepairTypes,
  formatSessionStats,
  formatGlobalStats,
  formatBlindspots,
} from "./recorder.js";

const TEST_LOG_DIR = path.join(".pi", "repair-log-test");

// Helper: build a minimal RepairEvent
function makeEvent(overrides: Partial<RepairEvent> = {}): RepairEvent {
  return {
    ts: "2026-05-28T12:00:00.000Z",
    eventType: "tool_call",
    sessionId: "test-session",
    turnIndex: 1,
    toolName: "read",
    provider: "test-provider",
    model: "test-model",
    repairs: [],
    wasRepaired: false,
    executionFailed: false,
    executionErrorType: null,
    wasHandled: false,
    handleType: null,
    blindspotCategory: null,
    inputKeys: [],
    inputNullKeys: [],
    inputExtraProps: [],
    ...overrides,
  };
}

// ─── getRepairLogDir / sessionLogPath ──────────────────────────────

describe("paths", () => {
  it("getRepairLogDir returns correct path", () => {
    expect(getRepairLogDir()).toBe(path.join(".pi", "repair-log"));
  });

  it("sessionLogPath returns correct path", () => {
    expect(sessionLogPath("abc123")).toBe(
      path.join(".pi", "repair-log", "abc123.jsonl")
    );
  });
});

// ─── ensureDir / recordEvent / readSessionEvents / readAllEvents ──

describe("I/O", () => {
  const testDir = path.join(".pi", "repair-log-test");

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("ensureDir creates directory", () => {
    const tmpDir = path.join(".pi", "repair-log-ensure");
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    expect(fs.existsSync(tmpDir)).toBe(false);

    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    expect(fs.existsSync(tmpDir)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("recordEvent writes a JSON line", () => {
    const logPath = path.join(testDir, "test-session.jsonl");
    const event = makeEvent({ sessionId: "test-session" });

    const line = JSON.stringify(event) + "\n";
    fs.appendFileSync(logPath, line, "utf-8");

    const content = fs.readFileSync(logPath, "utf-8").trim();
    expect(content.split("\n").length).toBe(1);
    const parsed = JSON.parse(content);
    expect(parsed.sessionId).toBe("test-session");
  });

  it("recordEvent appends multiple events", () => {
    const logPath = path.join(testDir, "multi-session.jsonl");
    const e1 = makeEvent({ sessionId: "multi-session", turnIndex: 1 });
    const e2 = makeEvent({ sessionId: "multi-session", turnIndex: 2 });

    fs.appendFileSync(logPath, JSON.stringify(e1) + "\n", "utf-8");
    fs.appendFileSync(logPath, JSON.stringify(e2) + "\n", "utf-8");

    const content = fs.readFileSync(logPath, "utf-8").trim();
    expect(content.split("\n").length).toBe(2);
  });

  it("recordEvent does not throw on failure", () => {
    expect(() =>
      recordEvent(makeEvent({ sessionId: "unknown" }), testDir)
    ).not.toThrow();
  });

  it("readSessionEvents returns events most recent first", () => {
    const logPath = path.join(testDir, "rev-session.jsonl");
    const e1 = makeEvent({ sessionId: "rev-session", turnIndex: 1, ts: "2026-05-28T10:00:00.000Z" });
    const e2 = makeEvent({ sessionId: "rev-session", turnIndex: 2, ts: "2026-05-28T11:00:00.000Z" });

    fs.appendFileSync(logPath, JSON.stringify(e1) + "\n", "utf-8");
    fs.appendFileSync(logPath, JSON.stringify(e2) + "\n", "utf-8");

    const events = readSessionEvents("rev-session", testDir);
    expect(events.length).toBe(2);
    expect(events[0].turnIndex).toBe(2);
    expect(events[1].turnIndex).toBe(1);
  });

  it("readSessionEvents returns empty array for nonexistent session", () => {
    const events = readSessionEvents("nonexistent");
    expect(events).toEqual([]);
  });

  it("readAllEvents collects from all session files", () => {
    const e1 = makeEvent({ sessionId: "s1", turnIndex: 1 });
    const e2 = makeEvent({ sessionId: "s2", turnIndex: 1 });

    fs.appendFileSync(path.join(testDir, "s1.jsonl"), JSON.stringify(e1) + "\n", "utf-8");
    fs.appendFileSync(path.join(testDir, "s2.jsonl"), JSON.stringify(e2) + "\n", "utf-8");

    const all = readAllEvents(testDir);
    expect(all.length).toBe(2);
  });

  it("readAllEvents returns empty for nonexistent dir", () => {
    expect(readAllEvents("/tmp/nonexistent-dir-xyz")).toEqual([]);
  });

  it("pruneOldSessions removes oldest beyond limit", () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const sid = `prune-s${i}`;
      const e = makeEvent({ sessionId: sid });
      const fPath = path.join(testDir, `${sid}.jsonl`);
      fs.writeFileSync(fPath, JSON.stringify(e) + "\n", "utf-8");
      const mtime = new Date(now - (2 - i) * 1000);
      fs.utimesSync(fPath, mtime, mtime);
    }

    const removed = pruneOldSessions(2, testDir);
    expect(removed).toBe(1);

    const remaining = fs.readdirSync(testDir).filter((f) => f.endsWith(".jsonl"));
    expect(remaining).toEqual(["prune-s1.jsonl", "prune-s2.jsonl"]);
  });

  it("pruneOldSessions returns 0 when under limit", () => {
    const e = makeEvent({ sessionId: "single" });
    fs.writeFileSync(path.join(testDir, "single.jsonl"), JSON.stringify(e) + "\n", "utf-8");
    expect(pruneOldSessions(10, testDir)).toBe(0);
  });

  it("pruneOldSessions returns 0 for nonexistent dir", () => {
    expect(pruneOldSessions(10, "/tmp/nonexistent-dir-xyz")).toBe(0);
  });

  it("readSessionEvents skips malformed JSON lines gracefully", () => {
    const logPath = path.join(testDir, "corrupt-session.jsonl");
    const e1 = makeEvent({ sessionId: "corrupt-session", turnIndex: 1 });
    const e3 = makeEvent({ sessionId: "corrupt-session", turnIndex: 3 });

    fs.appendFileSync(logPath, JSON.stringify(e1) + "\n", "utf-8");
    fs.appendFileSync(logPath, "{invalid json}}\n", "utf-8");
    fs.appendFileSync(logPath, JSON.stringify(e3) + "\n", "utf-8");

    const events = readSessionEvents("corrupt-session", testDir);
    expect(events.length).toBe(2);
    expect(events[0].turnIndex).toBe(3);
    expect(events[1].turnIndex).toBe(1);
  });

  it("recordEvent with empty sessionId falls back to 'unknown'", () => {
    const unknownPath = path.join(testDir, "unknown.jsonl");

    recordEvent(makeEvent({ sessionId: "" }), testDir);

    const content = fs.readFileSync(unknownPath, "utf-8").trim();
    const lines = content.split("\n");
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.sessionId).toBe("unknown");
  });
});

// ─── aggregateStats ───────────────────────────────────────────────────

describe("aggregateStats", () => {
  it("aggregates basic counts from events", () => {
    const events = [
      makeEvent({ toolName: "read", wasRepaired: true }),
      makeEvent({ toolName: "edit", executionFailed: true, executionErrorType: "EISDIR" }),
      makeEvent({ toolName: "bash" }),
    ];

    const stats = aggregateStats(events);
    expect(stats.totalCalls).toBe(3);
    expect(stats.totalRepairs).toBe(1);
    expect(stats.totalErrors).toBe(1);
  });

  it("tracks byTool stats", () => {
    const events = [
      makeEvent({ toolName: "read", wasRepaired: true }),
      makeEvent({ toolName: "read", executionFailed: true, executionErrorType: "ENOENT" }),
      makeEvent({ toolName: "edit" }),
    ];

    const stats = aggregateStats(events);
    expect(stats.byTool["read"].calls).toBe(2);
    expect(stats.byTool["read"].repairs).toBe(1);
    expect(stats.byTool["read"].errors).toBe(1);
    expect(stats.byTool["edit"].calls).toBe(1);
    expect(stats.byTool["edit"].repairs).toBe(0);
    expect(stats.byTool["edit"].errors).toBe(0);
  });

  it("tracks byModel stats", () => {
    const events = [
      makeEvent({ provider: "provider-a", model: "model-a" }),
      makeEvent({ provider: "provider-a", model: "model-a" }),
      makeEvent({ provider: "provider-b", model: "model-b" }),
    ];

    const stats = aggregateStats(events);
    expect(stats.byModel["provider-a/model-a"]).toBe(2);
    expect(stats.byModel["provider-b/model-b"]).toBe(1);
  });

  it("tracks byRepairType from repair descriptions", () => {
    const events = [
      makeEvent({
        wasRepaired: true,
        repairs: ["input.edits: parsed JSON string → array"],
      }),
      makeEvent({
        wasRepaired: true,
        repairs: ["input.strict: coerced boolean \"true\" → true"],
      }),
      makeEvent({
        wasRepaired: true,
        repairs: ["input.edits: parsed JSON string → array"],
      }),
    ];

    const stats = aggregateStats(events);
    expect(stats.byRepairType["parsed JSON"]).toBe(2);
    expect(stats.byRepairType["coerced boolean"]).toBe(1);
  });

  it("tracks byErrorType", () => {
    const events = [
      makeEvent({ executionFailed: true, executionErrorType: "EISDIR" }),
      makeEvent({ executionFailed: true, executionErrorType: "EISDIR" }),
      makeEvent({ executionFailed: true, executionErrorType: "ENOENT" }),
    ];

    const stats = aggregateStats(events);
    expect(stats.byErrorType["EISDIR"]).toBe(2);
    expect(stats.byErrorType["ENOENT"]).toBe(1);
  });

  it("handles empty events array", () => {
    const stats = aggregateStats([]);
    expect(stats.totalCalls).toBe(0);
    expect(stats.totalRepairs).toBe(0);
    expect(stats.totalErrors).toBe(0);
    expect(Object.keys(stats.byTool)).toHaveLength(0);
  });
});

// ─── extractRepairTypes ───────────────────────────────────────────────

describe("extractRepairTypes", () => {
  it("extracts known repair types", () => {
    expect(
      extractRepairTypes([
        "input.edits: parsed JSON string → array",
        "input.path: unwrapped markdown path ...",
        "input.strict: coerced boolean \"true\" → true",
        "input.limit: coerced number \"42\" → 42",
        "input.nullField: stripped null (optional field omitted)",
      ])
    ).toEqual(["parsed JSON", "unwrapped markdown", "coerced boolean", "coerced number", "stripped null"]);
  });

  it("returns empty array for empty input", () => {
    expect(extractRepairTypes([])).toEqual([]);
  });

  it("skips unrecognized patterns", () => {
    expect(extractRepairTypes(["something unknown"])).toEqual([]);
  });
});

// ─── computeBlindspots ───────────────────────────────────────────────

describe("computeBlindspots", () => {
  it("groups failures by tool + category", () => {
    const events = [
      makeEvent({
        toolName: "read",
        executionFailed: true,
        blindspotCategory: "EISDIR",
      }),
      makeEvent({
        toolName: "read",
        executionFailed: true,
        blindspotCategory: "EISDIR",
      }),
      makeEvent({
        toolName: "web_search",
        executionFailed: true,
        blindspotCategory: "model_domain_list",
      }),
    ];

    const spots = computeBlindspots(events);
    expect(spots.length).toBe(2);

    const readSpot = spots.find((s) => s.toolName === "read")!;
    expect(readSpot.category).toBe("EISDIR");
    expect(readSpot.count).toBe(2);
  });

  it("skips events without blindspotCategory", () => {
    const events = [
      makeEvent({ executionFailed: true, blindspotCategory: null }),
      makeEvent({ executionFailed: false, blindspotCategory: null }),
    ];

    expect(computeBlindspots(events)).toEqual([]);
  });

  it("tracks models per blindspot", () => {
    const events = [
      makeEvent({
        toolName: "read",
        executionFailed: true,
        blindspotCategory: "EISDIR",
        provider: "provider-a",
        model: "model-a",
      }),
      makeEvent({
        toolName: "read",
        executionFailed: true,
        blindspotCategory: "EISDIR",
        provider: "provider-b",
        model: "model-b",
      }),
    ];

    const spots = computeBlindspots(events);
    expect(spots.length).toBe(1);
    expect(spots[0].models).toContain("provider-a/model-a");
    expect(spots[0].models).toContain("provider-b/model-b");
  });

  it("sorts by count descending", () => {
    const events = [
      makeEvent({ toolName: "a", executionFailed: true, blindspotCategory: "X" }),
      makeEvent({ toolName: "b", executionFailed: true, blindspotCategory: "Y" }),
      makeEvent({ toolName: "b", executionFailed: true, blindspotCategory: "Y" }),
    ];

    const spots = computeBlindspots(events);
    expect(spots.length).toBe(2);
    expect(spots[0].toolName).toBe("b");
    expect(spots[0].count).toBe(2);
    expect(spots[1].toolName).toBe("a");
    expect(spots[1].count).toBe(1);
  });
});

// ─── formatSessionStats ──────────────────────────────────────────────

describe("formatSessionStats", () => {
  it("shows empty message for no events", () => {
    const stats = aggregateStats([]);
    const out = formatSessionStats(stats);
    expect(out).toContain("No tool calls recorded");
  });

  it("includes summary metrics", () => {
    const events = [makeEvent({ toolName: "read", wasRepaired: true })];
    const stats = aggregateStats(events);
    const out = formatSessionStats(stats);
    expect(out).toContain("Tool calls:");
    expect(out).toContain("Repairs applied:");
    expect(out).toContain("read");
  });

  it("includes repair type table when repairs exist", () => {
    const events = [
      makeEvent({
        wasRepaired: true,
        repairs: ["input.edits: parsed JSON string → array"],
      }),
    ];
    const stats = aggregateStats(events);
    const out = formatSessionStats(stats);
    expect(out).toContain("Top Repairs:");
    expect(out).toContain("parsed JSON");
  });

  it("formatSessionStats shows 100.0% when all calls repaired", () => {
    const events = [makeEvent({ wasRepaired: true })];
    const stats = aggregateStats(events);
    const out = formatSessionStats(stats);
    expect(out).toContain("100.0%");
  });

  it("formatSessionStats shows 0.0% when no repairs", () => {
    const events = [makeEvent({ wasRepaired: false })];
    const stats = aggregateStats(events);
    const out = formatSessionStats(stats);
    expect(out).toContain("0.0%");
  });
});

// ─── formatGlobalStats ───────────────────────────────────────────────

describe("formatGlobalStats", () => {
  it("shows empty message for no events", () => {
    const stats = aggregateStats([]);
    const out = formatGlobalStats(stats, 0);
    expect(out).toContain("No tool calls recorded");
  });

  it("includes session count", () => {
    const stats = aggregateStats([makeEvent()]);
    const out = formatGlobalStats(stats, 5);
    expect(out).toContain("Sessions:");
    expect(out).toContain("5");
  });

  it("includes by-model section", () => {
    const events = [makeEvent({ provider: "provider-a", model: "model-a" })];
    const stats = aggregateStats(events);
    const out = formatGlobalStats(stats, 1);
    expect(out).toContain("By Model:");
    expect(out).toContain("provider-a/model-a");
  });

  it("includes by-error-type section when errors exist", () => {
    const events = [
      makeEvent({ executionFailed: true, executionErrorType: "EISDIR" }),
    ];
    const stats = aggregateStats(events);
    const out = formatGlobalStats(stats, 1);
    expect(out).toContain("Top Errors:");
    expect(out).toContain("EISDIR");
  });

  it("formatGlobalStats omits error section when no errors", () => {
    const events = [makeEvent()];
    const stats = aggregateStats(events);
    const out = formatGlobalStats(stats, 1);
    expect(out).not.toContain("Top Errors:");
  });
});

// ─── formatBlindspots ────────────────────────────────────────────────

describe("formatBlindspots", () => {
  it("returns all-clear message when no blindspots", () => {
    expect(formatBlindspots([])).toContain("No blindspots detected");
  });

  it("formats blindspot entries with suggestions", () => {
    const spots = [
      {
        category: "EISDIR",
        toolName: "read",
        count: 3,
        firstSeen: "2026-05-28T10:00:00Z",
        lastSeen: "2026-05-28T11:00:00Z",
        example: "input keys: [path]",
        models: ["provider-a/model-a"],
        suggestion: "Add directory-listing fallback.",
      },
    ];

    const out = formatBlindspots(spots);
    expect(out).toContain("EISDIR");
    expect(out).toContain("read");
    expect(out).toContain("3x");
    expect(out).toContain("Add directory-listing fallback");
    expect(out).toContain("provider-a/model-a");
  });

  it("lists total count at end", () => {
    const spots = [
      {
        category: "A",
        toolName: "t1",
        count: 1,
        firstSeen: "",
        lastSeen: "",
        example: "",
        models: [],
        suggestion: "",
      },
      {
        category: "B",
        toolName: "t2",
        count: 2,
        firstSeen: "",
        lastSeen: "",
        example: "",
        models: [],
        suggestion: "",
      },
    ];

    const out = formatBlindspots(spots);
    expect(out).toContain("Total: 2 blindspot(s)");
  });
});
