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

  // ─── Circuit Breaker Tests ────────────────────────────────────────

  it("isCircuitBreak returns false before 7 consecutive", () => {
    const tracker = new ConsecutiveFailureTracker();
    for (let i = 0; i < 6; i++) {
      tracker.recordFailure("bash", ["command"]);
    }
    expect(tracker.isCircuitBreak("bash")).toBe(false);
  });

  it("isCircuitBreak returns true at 7+ consecutive", () => {
    const tracker = new ConsecutiveFailureTracker();
    for (let i = 0; i < 7; i++) {
      tracker.recordFailure("bash", ["command"]);
    }
    expect(tracker.isCircuitBreak("bash")).toBe(true);
  });

  it("isCircuitBreak returns true at 10 consecutive", () => {
    const tracker = new ConsecutiveFailureTracker();
    for (let i = 0; i < 10; i++) {
      tracker.recordFailure("bash", ["command"]);
    }
    expect(tracker.isCircuitBreak("bash")).toBe(true);
  });

  it("getSeverity returns 'none' for 0-2 failures", () => {
    const tracker = new ConsecutiveFailureTracker();
    expect(tracker.getSeverity("bash")).toBe("none");
    tracker.recordFailure("bash", ["command"]);
    expect(tracker.getSeverity("bash")).toBe("none");
    tracker.recordFailure("bash", ["command"]);
    expect(tracker.getSeverity("bash")).toBe("none");
  });

  it("getSeverity returns 'minor' at 3", () => {
    const tracker = new ConsecutiveFailureTracker();
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure("bash", ["command"]);
    }
    expect(tracker.getSeverity("bash")).toBe("minor");
  });

  it("getSeverity returns 'major' at 5", () => {
    const tracker = new ConsecutiveFailureTracker();
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure("bash", ["command"]);
    }
    expect(tracker.getSeverity("bash")).toBe("major");
  });

  it("getSeverity returns 'critical' at 7", () => {
    const tracker = new ConsecutiveFailureTracker();
    for (let i = 0; i < 7; i++) {
      tracker.recordFailure("bash", ["command"]);
    }
    expect(tracker.getSeverity("bash")).toBe("critical");
  });

  it("getSeverity resets after success", () => {
    const tracker = new ConsecutiveFailureTracker();
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure("bash", ["command"]);
    }
    expect(tracker.getSeverity("bash")).toBe("major");
    tracker.recordSuccess("bash");
    expect(tracker.getSeverity("bash")).toBe("none");
  });
});
