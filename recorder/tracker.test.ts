/**
 * Unit tests for consecutive failure tracker (recorder/tracker.ts).
 */

import { describe, it, expect } from "vitest";
import { ConsecutiveFailureTracker } from "./tracker.js";

// ─── ConsecutiveFailureTracker ───────────────────────────────────────

describe("ConsecutiveFailureTracker", () => {
  it("starts at 1 for first failure", () => {
    const tracker = new ConsecutiveFailureTracker();
    const count = tracker.recordFailure("bash", ["command"]);
    expect(count).toBe(1);
  });

  it("increments on repeated failures with same arg keys", () => {
    const tracker = new ConsecutiveFailureTracker();
    expect(tracker.recordFailure("edit", ["edits", "path"])).toBe(1);
    expect(tracker.recordFailure("edit", ["edits", "path"])).toBe(2);
    expect(tracker.recordFailure("edit", ["edits", "path"])).toBe(3);
    expect(tracker.isInLoop("edit")).toBe(true);
  });

  it("resets count when arg keys change", () => {
    const tracker = new ConsecutiveFailureTracker();
    expect(tracker.recordFailure("bash", ["command"])).toBe(1);
    expect(tracker.recordFailure("bash", ["command"])).toBe(2);
    // Different arg keys → new attempt, reset to 1
    expect(tracker.recordFailure("bash", ["command", "timeout"])).toBe(1);
  });

  it("resets count on recordSuccess", () => {
    const tracker = new ConsecutiveFailureTracker();
    tracker.recordFailure("bash", ["command"]);
    tracker.recordFailure("bash", ["command"]);
    tracker.recordSuccess("bash");
    expect(tracker.isInLoop("bash")).toBe(false);
    expect(tracker.getCount("bash")).toBe(0);
  });

  it("tracks separate tools independently", () => {
    const tracker = new ConsecutiveFailureTracker();
    expect(tracker.recordFailure("bash", ["command"])).toBe(1);
    expect(tracker.recordFailure("edit", ["edits"])).toBe(1);
    expect(tracker.recordFailure("bash", ["command"])).toBe(2);
    expect(tracker.recordFailure("edit", ["edits"])).toBe(2);
  });

  it("isInLoop returns false before threshold", () => {
    const tracker = new ConsecutiveFailureTracker();
    tracker.recordFailure("bash", ["command"]);
    tracker.recordFailure("bash", ["command"]);
    expect(tracker.isInLoop("bash")).toBe(false);
  });

  it("isInLoop returns true at threshold (3)", () => {
    const tracker = new ConsecutiveFailureTracker();
    tracker.recordFailure("bash", ["command"]);
    tracker.recordFailure("bash", ["command"]);
    tracker.recordFailure("bash", ["command"]);
    expect(tracker.isInLoop("bash")).toBe(true);
  });

  it("reset clears all state", () => {
    const tracker = new ConsecutiveFailureTracker();
    tracker.recordFailure("bash", ["command"]);
    tracker.recordFailure("bash", ["command"]);
    tracker.recordFailure("bash", ["command"]);
    expect(tracker.isInLoop("bash")).toBe(true);
    tracker.reset();
    expect(tracker.isInLoop("bash")).toBe(false);
    expect(tracker.getCount("bash")).toBe(0);
  });
});
