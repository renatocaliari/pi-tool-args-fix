/**
 * Tests for content hash cache.
 */

import { describe, it, expect } from "vitest";
import { ContentHashCache, simpleHash } from "../repairs/cache.js";

describe("simpleHash", () => {
  it("returns consistent hash for same input", () => {
    expect(simpleHash("hello")).toBe(simpleHash("hello"));
  });
  it("returns different hash for different input", () => {
    expect(simpleHash("hello")).not.toBe(simpleHash("world"));
  });
  it("handles empty string without crashing", () => {
    expect(() => simpleHash("")).not.toThrow();
    expect(simpleHash("")).toBe(simpleHash(""));
    expect(simpleHash("").length).toBeGreaterThan(0);
  });
  it("handles multiline content", () => {
    expect(simpleHash("line1\nline2\nline3")).toBe(simpleHash("line1\nline2\nline3"));
  });
});

describe("ContentHashCache", () => {
  it("detects unchanged content as fresh", () => {
    const cache = new ContentHashCache();
    cache.setHash("/path/to/file.ts", "const x = 1;");
    expect(cache.isStale("/path/to/file.ts", "const x = 1;")).toBe(false);
  });
  it("detects changed content as stale", () => {
    const cache = new ContentHashCache();
    cache.setHash("/path/to/file.ts", "const x = 1;");
    expect(cache.isStale("/path/to/file.ts", "const x = 2;")).toBe(true);
  });
  it("returns false for never-read files", () => {
    const cache = new ContentHashCache();
    expect(cache.isStale("/path/to/unknown.ts", "content")).toBe(false);
  });
  it("records and retrieves last read turn", () => {
    const cache = new ContentHashCache();
    cache.recordRead("/path/to/file.ts", 42);
    expect(cache.getLastReadTurn("/path/to/file.ts")).toBe(42);
  });
  it("returns -1 for files that were never read", () => {
    const cache = new ContentHashCache();
    expect(cache.getLastReadTurn("/path/to/unknown.ts")).toBe(-1);
  });
  it("reset clears all state", () => {
    const cache = new ContentHashCache();
    cache.setHash("/path/a.ts", "content");
    cache.recordRead("/path/a.ts", 1);
    cache.reset();
    expect(cache.trackedFiles).toBe(0);
    expect(cache.getLastReadTurn("/path/a.ts")).toBe(-1);
  });
  it("tracks file count and does not count overwrites", () => {
    const cache = new ContentHashCache();
    expect(cache.trackedFiles).toBe(0);
    cache.setHash("/a.ts", "a");
    cache.setHash("/b.ts", "b");
    cache.setHash("/c.ts", "c");
    expect(cache.trackedFiles).toBe(3);
    cache.setHash("/a.ts", "a2");
    expect(cache.trackedFiles).toBe(3);
  });
  it("overwrites hash for same path", () => {
    const cache = new ContentHashCache();
    cache.setHash("/a.ts", "old");
    cache.setHash("/a.ts", "new");
    expect(cache.isStale("/a.ts", "new")).toBe(false);
    expect(cache.trackedFiles).toBe(1);
  });
});

describe("ContentHashCache.wasEverRead", () => {
  it("returns true for a file that was read", () => {
    const cache = new ContentHashCache();
    cache.recordRead("/path/to/file.ts", 10);
    expect(cache.wasEverRead("/path/to/file.ts")).toBe(true);
  });
  it("returns false for a file never read", () => {
    const cache = new ContentHashCache();
    expect(cache.wasEverRead("/path/to/unknown.ts")).toBe(false);
  });
  it("returns false after reset", () => {
    const cache = new ContentHashCache();
    cache.recordRead("/path/to/file.ts", 5);
    cache.reset();
    expect(cache.wasEverRead("/path/to/file.ts")).toBe(false);
  });
});
