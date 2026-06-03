/**
 * Tests for timeout detection functions.
 */

import { describe, it, expect } from "vitest";
import { isLongRunningCommand, suggestAutoTimeout } from "../repairs/timeout.js";

describe("isLongRunningCommand", () => {
  it("detects build commands", () => {
    expect(isLongRunningCommand("npm run build")).toBe(true);
    expect(isLongRunningCommand("go build ./cmd/web/")).toBe(true);
  });
  it("detects test commands", () => {
    expect(isLongRunningCommand("npx vitest run")).toBe(true);
    expect(isLongRunningCommand("go test ./...")).toBe(true);
  });
  it("detects lint commands", () => {
    expect(isLongRunningCommand("golangci-lint run")).toBe(true);
    expect(isLongRunningCommand("npx eslint .")).toBe(true);
  });
  it("detects generate/compile/deploy", () => {
    expect(isLongRunningCommand("templ generate")).toBe(true);
    expect(isLongRunningCommand("go build")).toBe(true);
    expect(isLongRunningCommand("npm run deploy")).toBe(true);
  });
  it("rejects simple commands", () => {
    expect(isLongRunningCommand("ls -la")).toBe(false);
    expect(isLongRunningCommand("echo hello")).toBe(false);
    expect(isLongRunningCommand("cat file.ts")).toBe(false);
    expect(isLongRunningCommand("cd /tmp")).toBe(false);
  });
  it("catches 'test' substring anywhere", () => {
    expect(isLongRunningCommand("contest --help")).toBe(true);
    expect(isLongRunningCommand("testify")).toBe(true);
    expect(isLongRunningCommand("cat protest-notes.md")).toBe(true);
  });
  it("catches 'build' substring anywhere", () => {
    expect(isLongRunningCommand("building-info.sh")).toBe(true);
    expect(isLongRunningCommand("rebuild-db --quick")).toBe(true);
  });
  it("rejects empty strings", () => {
    expect(isLongRunningCommand("")).toBe(false);
    expect(isLongRunningCommand("   ")).toBe(false);
  });
  it("returns true when pipe appears with tee", () => {
    expect(isLongRunningCommand("make test 2>&1 | tee results.txt")).toBe(true);
  });
  it("does NOT detect pipes without tee", () => {
    expect(isLongRunningCommand("ls | head")).toBe(false);
    expect(isLongRunningCommand("cat data.txt | sort")).toBe(false);
  });
});

describe("suggestAutoTimeout", () => {
  it("suggests 300s for build/test with no timeout", () => {
    expect(suggestAutoTimeout("go test ./...", undefined)).toBe(300);
    expect(suggestAutoTimeout("npm run build", undefined)).toBe(300);
  });
  it("suggests 120s for generate/deploy with no timeout", () => {
    expect(suggestAutoTimeout("templ generate", undefined)).toBe(120);
    expect(suggestAutoTimeout("npm run deploy", undefined)).toBe(120);
  });
  it("suggests 600s for piped commands with known output tools", () => {
    expect(suggestAutoTimeout("cat huge-log.txt | head", undefined)).toBe(600);
    expect(suggestAutoTimeout("./benchmark.sh | tee log.txt", undefined)).toBe(600);
  });
  it("still suggests 600s for piped commands even when some timeout already set", () => {
    expect(suggestAutoTimeout("find / -name '*.config' | head", 30)).toBe(600);
  });
  it("does NOT inject pipe-timeout for commands without known pipe tools", () => {
    expect(suggestAutoTimeout("cmd1 | cmd2", undefined)).toBeUndefined();
    expect(suggestAutoTimeout("data | transform | output", undefined)).toBeUndefined();
  });
  it("suggests 120s when current timeout is too short for build", () => {
    expect(suggestAutoTimeout("go build ./cmd/", 10)).toBe(120);
  });
  it("returns undefined for simple commands", () => {
    expect(suggestAutoTimeout("ls -la", undefined)).toBeUndefined();
    expect(suggestAutoTimeout("echo hello", undefined)).toBeUndefined();
  });
  it("returns undefined when existing timeout is adequate", () => {
    expect(suggestAutoTimeout("go test ./...", 300)).toBeUndefined();
  });
});
