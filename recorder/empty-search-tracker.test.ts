/**
 * Unit tests for consecutive empty search tracker.
 */

import { describe, it, expect } from "vitest";
import { ConsecutiveEmptySearchTracker } from "./empty-search-tracker.js";

// ─── ConsecutiveEmptySearchTracker ───────────────────────────────────

describe("ConsecutiveEmptySearchTracker", () => {
  it("starts at 1 for first empty result", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    const count = tracker.recordEmpty("NavUnifiedDropdown");
    expect(count).toBe(1);
  });

  it("increments on repeated empty results with same pattern", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    expect(tracker.recordEmpty("NavUnifiedDropdown")).toBe(1);
    expect(tracker.recordEmpty("NavUnifiedDropdown")).toBe(2);
    expect(tracker.recordEmpty("NavUnifiedDropdown")).toBe(3);
    expect(tracker.isInEmptyLoop("NavUnifiedDropdown")).toBe(true);
  });

  it("increments across related pattern variants", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    expect(tracker.recordEmpty("NavUnifiedDropdown")).toBe(1);
    // Different but related pattern (case/underscore variants) → count continues
    expect(tracker.recordEmpty("nav_unified_dropdow")).toBe(2);
    expect(tracker.recordEmpty("NavUnifiedDropdow")).toBe(3);
    expect(tracker.isInEmptyLoop("NavUnifiedDropdown")).toBe(true);
  });

  it("treats similar patterns as same concept (4-char fragment overlap)", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    expect(tracker.recordEmpty("NavUnifiedDropdown")).toBe(1);
    // "nav_unified_dropdown.templ" contains "navu" → related
    expect(tracker.recordEmpty("nav_unified_dropdow")).toBe(2);
    expect(tracker.recordEmpty("NavUnifiedDropdow")).toBe(3);
    expect(tracker.isInEmptyLoop("NavUnifiedDropdown")).toBe(true);
  });

  it("resets count when pattern concept changes", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    expect(tracker.recordEmpty("NavUnifiedDropdown")).toBe(1);
    expect(tracker.recordEmpty("NavUnifiedDropdown")).toBe(2);
    // Completely different concept → reset
    expect(tracker.recordEmpty("session")).toBe(1);
  });

  it("resets all counts on recordFound", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    tracker.recordEmpty("NavUnifiedDropdown");
    tracker.recordEmpty("NavUnifiedDropdown");
    tracker.recordFound();
    expect(tracker.isInEmptyLoop("NavUnifiedDropdown")).toBe(false);
    expect(tracker.getCount("NavUnifiedDropdown")).toBe(0);
  });

  it("recordFound resets all state regardless of tool", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    tracker.recordEmpty("NavUnifiedDropdown");
    tracker.recordEmpty("nav_unified_drop");
    tracker.recordFound();
    expect(tracker.isInEmptyLoop("NavUnifiedDropdown")).toBe(false);
    expect(tracker.getCount("NavUnifiedDropdown")).toBe(0);
  });

  it("returns false for isInEmptyLoop before threshold", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    expect(tracker.isInEmptyLoop("x")).toBe(false);
    tracker.recordEmpty("x");
    tracker.recordEmpty("x");
    expect(tracker.isInEmptyLoop("x")).toBe(false);
    tracker.recordEmpty("x");
    expect(tracker.isInEmptyLoop("x")).toBe(true);
  });

  it("handles empty/reset state", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    expect(tracker.isInEmptyLoop("any")).toBe(false);
    expect(tracker.getCount("any")).toBe(0);
  });

  it("ignores punctuation differences in fingerprints", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    expect(tracker.recordEmpty("**/NavUnifiedDropdown*")).toBe(1);
    // glob characters get collapsed, same concept
    expect(tracker.recordEmpty("NavUnifiedDropdown")).toBe(2);
  });

  it("full reset clears all state", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    tracker.recordEmpty("NavUnifiedDropdown");
    tracker.recordEmpty("nav_unified");
    tracker.recordEmpty("session");
    tracker.reset();
    expect(tracker.getCount("NavUnifiedDropdown")).toBe(0);
    expect(tracker.getCount("nav_unified")).toBe(0);
    expect(tracker.getCount("session")).toBe(0);
    expect(tracker.isInEmptyLoop("NavUnifiedDropdown")).toBe(false);
  });

  it("detects related patterns with minor spelling differences", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    expect(tracker.recordEmpty("NavUnifiedDropdown")).toBe(1);
    // "nav_unified_drop" shares "navu" fragment → related
    expect(tracker.recordEmpty("nav_unified_drop")).toBe(2);
  });

  it("detects related patterns via space-split token overlap", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    expect(tracker.recordEmpty("nav_button_foo")).toBe(1);
    // After punctuation collapse: "nav button foo" and "button nav" share "button" token
    expect(tracker.recordEmpty("button_nav")).toBe(2);
  });

  it("handles short patterns (under 4 chars)", () => {
    const tracker = new ConsecutiveEmptySearchTracker();
    expect(tracker.recordEmpty("ab")).toBe(1);
    // "ab" != "cd" and neither has 4-char windows → not related
    expect(tracker.recordEmpty("cd")).toBe(1);
  });
});
