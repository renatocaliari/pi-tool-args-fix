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
  it("suggests 60s for pipe-only commands (not long-running)", () => {
    expect(suggestAutoTimeout("cat huge-log.txt | head", undefined)).toBe(60);
    expect(suggestAutoTimeout("grep -r foo src/ | head -20", undefined)).toBe(60);
    expect(suggestAutoTimeout("find / -name '*.config' | head", undefined)).toBe(60);
  });
  it("suggests 60s for pipe-only commands with too-short timeout", () => {
    expect(suggestAutoTimeout("find / -name '*.config' | head", 30)).toBe(60);
    expect(suggestAutoTimeout("cat data.txt | sort", 10)).toBe(60);
  });
  it("falls through to normal timeout for long-running + pipe (test | tee)", () => {
    expect(suggestAutoTimeout("go test ./... | tee results.txt", undefined)).toBe(300);
    expect(suggestAutoTimeout("./benchmark.sh | tee log.txt", undefined)).toBe(120);
  });
  it("respects existing adequate timeout on long-running + pipe", () => {
    expect(suggestAutoTimeout("go test ./... | tee results.txt", 300)).toBeUndefined();
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
