/**
 * Tests for guidance message builders.
 */

import { describe, it, expect } from "vitest";
import {
  buildPathValidationGuidance, buildStalenessGuidance, buildCircuitBreakMessage,
  buildEditLoopGuidance, buildEmptySearchGuidance, buildEditMismatchContext,
  buildEnhancedEditMismatchGuidance, extractFailedEditIndex, extractFailedEditPath,
  extractNonUniqueEditCount, findAllOldTextMatchLines, buildEditNonUniqueGuidance,
  buildEditWrongFileGuidance, buildSequentialEditGuidance, ordinalSuffix,
} from "../repairs/guidance.js";

describe("buildPathValidationGuidance", () => {
  it("includes all invalid paths", () => {
    const g = buildPathValidationGuidance(["/tmp/missing.ts", "/opt/gone.txt"], "read");
    expect(g).toContain("2 path(s) not found");
    expect(g).toContain("/tmp/missing.ts");
    expect(g).toContain("/opt/gone.txt");
  });
  it("handles single invalid path", () => {
    expect(buildPathValidationGuidance(["/tmp/missing.ts"], "read")).toContain("1 path(s) not found");
  });
  it("handles empty path list", () => {
    expect(buildPathValidationGuidance([], "read")).toContain("0 path(s) not found");
  });
  it("is tool-agnostic", () => {
    expect(buildPathValidationGuidance(["/x.ts"], "edit")).toBe(buildPathValidationGuidance(["/x.ts"], "read"));
  });
});

describe("buildStalenessGuidance", () => {
  it("includes the last read turn number", () => {
    expect(buildStalenessGuidance(42)).toContain("turn 42");
  });
  it("handles turn 0", () => {
    expect(buildStalenessGuidance(0)).toContain("turn 0");
  });
  it("mentions exact current text requirement", () => {
    expect(buildStalenessGuidance(5)).toContain("exact current text as oldText");
  });
});

describe("buildCircuitBreakMessage", () => {
  it("includes tool name and consecutive count", () => {
    const msg = buildCircuitBreakMessage("edit", 10, "oldText not found");
    expect(msg).toContain("edit");
    expect(msg).toContain("10 consecutive");
    expect(msg).toContain("CIRCUIT BREAKER");
  });
  it("truncates long error details to 200 chars", () => {
    const longError = "x".repeat(500);
    const msg = buildCircuitBreakMessage("bash", 7, longError);
    expect(msg).toContain("x".repeat(200));
    expect(msg).not.toContain("x".repeat(201));
  });
  it("suggests alternative strategies", () => {
    const msg = buildCircuitBreakMessage("edit", 7, "failed");
    expect(msg).toContain("write tool");
  });
  it("handles edge: 7 consecutive", () => {
    const msg = buildCircuitBreakMessage("bash", 7, "timeout");
    expect(msg).toContain("7 consecutive");
  });
});

describe("buildEditLoopGuidance", () => {
  it("returns whitespace tip for 3 failures", () => {
    expect(buildEditLoopGuidance(3)).toContain("whitespace");
  });
  it("returns write tool alternative for 5 failures", () => {
    expect(buildEditLoopGuidance(5)).toContain("write tool");
  });
  it("returns write tool alternative for 7+ failures", () => {
    expect(buildEditLoopGuidance(7)).toContain("write tool");
  });
  it("returns tip for 4 failures", () => {
    expect(buildEditLoopGuidance(4)).toContain("whitespace");
  });
});

describe("buildEmptySearchGuidance", () => {
  it("includes tool name and pattern", () => {
    const msg = buildEmptySearchGuidance("NavUnifiedDropdown", 3, "find");
    expect(msg).toContain("find");
    expect(msg).toContain("NavUnifiedDropdown");
  });
  it("suggests listing directory for persistent failures", () => {
    expect(buildEmptySearchGuidance("NavUnifiedDropdown", 5, "grep")).toContain("Change strategy");
  });
  it("suggests different tool at 5+ consecutive failures", () => {
    expect(buildEmptySearchGuidance("session", 5, "grep")).toContain("a different tool");
  });
  it("mentions common naming conventions", () => {
    expect(buildEmptySearchGuidance("NavUnifiedDropdown", 3, "find")).toContain("snake_case");
  });
  it("truncates long pattern to 80 chars", () => {
    const longPattern = "a".repeat(200);
    const msg = buildEmptySearchGuidance(longPattern, 3, "find");
    expect(msg).toContain("a".repeat(80));
  });
});

describe("buildEditMismatchContext", () => {
  it("finds matching line prefix and returns context window", () => {
    const content = `line one\nline two\nfunction hello() {\n  console.log("world");\n}\nline five`;
    const result = buildEditMismatchContext(content, "function hello() {\n  console.log(\"bad\");");
    expect(result).not.toBeNull();
    expect(result!.matchLine).toBe(2);
    expect(result!.contextLines).toContain("function hello()");
  });
  it("returns null for empty oldText", () => {
    expect(buildEditMismatchContext("some\ncontent", "")).toBeNull();
  });
  it("returns null when no line prefix matches", () => {
    expect(buildEditMismatchContext("const a = 1;\nconst b = 2;", "function nonexistent() {")).toBeNull();
  });
  it("clamps context at top boundary", () => {
    const result = buildEditMismatchContext("first line\nsecond line\nthird line", "first line");
    expect(result).not.toBeNull();
    expect(result!.matchLine).toBe(0);
    expect(result!.contextLines).not.toContain("  0│");
  });
  it("clamps context at bottom boundary", () => {
    const result = buildEditMismatchContext("line a\nline b\nlast line", "last line");
    expect(result).not.toBeNull();
    expect(result!.contextLines).toContain("  3│");
  });
  it("marks only the exact matching line with arrow", () => {
    const result = buildEditMismatchContext("aaa\nbbb\nccc", "bbb");
    expect(result).not.toBeNull();
    expect((result!.contextLines.match(/ →/g) || []).length).toBe(1);
  });
  it("matches first 40 chars of oldText first line", () => {
    const content = "a".repeat(100) + "\nsomething else";
    const result = buildEditMismatchContext(content, "a".repeat(80));
    expect(result).not.toBeNull();
    expect(result!.matchLine).toBe(0);
  });
});

describe("buildEnhancedEditMismatchGuidance", () => {
  it("combines base guidance with file context", () => {
    const context = { contextLines: "  5│ function foo() {", matchLine: 4 };
    const result = buildEnhancedEditMismatchGuidance("read the file first", context);
    expect(result).toContain("read the file first");
    expect(result).toContain("does not match");
  });
  it("mentions the specific line number", () => {
    const context = { contextLines: "  10│ const x = 1;", matchLine: 9 };
    expect(buildEnhancedEditMismatchGuidance("base", context)).toContain("line 10");
  });
  it("wraps context in code block", () => {
    const context = { contextLines: "some code", matchLine: 0 };
    expect(buildEnhancedEditMismatchGuidance("base", context)).toContain("```");
  });
});

describe("extractFailedEditIndex", () => {
  it("extracts edits[0] index", () => {
    expect(extractFailedEditIndex("Could not find edits[0] in /path/to/file.ts")).toBe(0);
  });
  it("extracts edits[2] index", () => {
    expect(extractFailedEditIndex("Could not find edits[2] in setup.sh. The oldText must match exactly including all whitespace and newlines.")).toBe(2);
  });
  it("extracts edits[5] index", () => {
    expect(extractFailedEditIndex("Could not find edits[5] in /x/y.ts")).toBe(5);
  });
  it("returns undefined for non-array edit errors", () => {
    expect(extractFailedEditIndex("Could not find the exact text in /path/file.ts")).toBeUndefined();
  });
  it("returns undefined for null input", () => {
    expect(extractFailedEditIndex(null)).toBeUndefined();
  });
  it("extracts double-digit edit index", () => {
    expect(extractFailedEditIndex("Could not find edits[12] in /long/path.ts")).toBe(12);
  });
});

describe("extractFailedEditPath", () => {
  it("extracts path from edits error", () => {
    expect(extractFailedEditPath("Could not find edits[2] in setup.sh. The oldText")).toBe("setup.sh");
  });
  it("extracts path from single edit error", () => {
    expect(extractFailedEditPath("Could not find the exact text in /path/to/file.ts. The old text")).toBe("/path/to/file.ts");
  });
  it("handles paths with dots", () => {
    expect(extractFailedEditPath("Could not find edits[0] in /x/y.z.ts")).toBe("/x/y.z.ts");
  });
  it("returns undefined for null", () => {
    expect(extractFailedEditPath(null)).toBeUndefined();
  });
  it("returns undefined for empty string", () => {
    expect(extractFailedEditPath("")).toBeUndefined();
  });
});

describe("extractNonUniqueEditCount", () => {
  it("extracts non-unique occurrence count", () => {
    expect(extractNonUniqueEditCount("Found 4 occurrences of edits[3] in /path/to/file.md")).toBe(4);
  });
  it("extracts singular occurrence", () => {
    expect(extractNonUniqueEditCount("Found 1 occurrence of edits[0] in file.ts")).toBe(1);
  });
  it("returns undefined for no match", () => {
    expect(extractNonUniqueEditCount("Could not find edits[3] in file.ts")).toBeUndefined();
  });
  it("returns undefined for null", () => {
    expect(extractNonUniqueEditCount(null)).toBeUndefined();
  });
});

describe("findAllOldTextMatchLines", () => {
  it("finds all matching lines by prefix", () => {
    const content = `const a = 1;\nconst b = 2;\nfunction foo() {}\nconst c = 3;\nfunction foo() { return 42; }`;
    const result = findAllOldTextMatchLines(content, "function foo() {\n");
    expect(result).not.toBeNull();
    expect(result!.lineNumbers).toEqual([2, 4]);
  });
  it("finds single match", () => {
    const result = findAllOldTextMatchLines("line a\nline b\nunique content", "unique");
    expect(result).not.toBeNull();
    expect(result!.lineNumbers).toEqual([2]);
  });
  it("returns null for no match", () => {
    expect(findAllOldTextMatchLines("aaa\nbbb\nccc", "nonexistent")).toBeNull();
  });
  it("returns null for empty oldText", () => {
    expect(findAllOldTextMatchLines("some\ncontent", "")).toBeNull();
  });
});

describe("buildEditNonUniqueGuidance", () => {
  it("generates guidance with all matching locations", () => {
    const content = `header\nfunction foo() {\n  return 1;\n}\n\nfunction foo() {\n  return 2;\n}`;
    const result = buildEditNonUniqueGuidance(content, "function foo() {\n", 2);
    expect(result).not.toBeNull();
    expect(result).toContain("matched 2 time(s)");
    expect(result).toContain("add more context");
  });
  it("returns null when no line matches", () => {
    expect(buildEditNonUniqueGuidance("aaa\nbbb\nccc", "nonexistent", 3)).toBeNull();
  });
  it("includes unique fix advice", () => {
    const result = buildEditNonUniqueGuidance("line a\nduplicate\nline b", "duplicate", 1);
    expect(result).not.toBeNull();
    expect(result).toContain("line BEFORE and AFTER");
  });
});

describe("buildEditWrongFileGuidance", () => {
  it("mentions the wrong file possibility", () => {
    const result = buildEditWrongFileGuidance("/path/to/SKILL.md");
    expect(result).toContain("DIFFERENT file");
  });
  it("includes error path when path differs from input path", () => {
    const result = buildEditWrongFileGuidance("/path/to/SKILL.md", "/other/AGENTS.md");
    expect(result).toContain("These differ");
  });
  it("does not mention path mismatch when paths are the same", () => {
    const result = buildEditWrongFileGuidance("/path/to/file.md", "/path/to/file.md");
    expect(result).not.toContain("These differ");
  });
});

describe("ordinalSuffix", () => {
  it("formats 1 as 1st", () => { expect(ordinalSuffix(1)).toBe("1st"); });
  it("formats 2 as 2nd", () => { expect(ordinalSuffix(2)).toBe("2nd"); });
  it("formats 3 as 3rd", () => { expect(ordinalSuffix(3)).toBe("3rd"); });
  it("formats 4 as 4th", () => { expect(ordinalSuffix(4)).toBe("4th"); });
  it("formats 11 as 11th (teen exception)", () => { expect(ordinalSuffix(11)).toBe("11th"); });
  it("formats 12 as 12th", () => { expect(ordinalSuffix(12)).toBe("12th"); });
  it("formats 13 as 13th", () => { expect(ordinalSuffix(13)).toBe("13th"); });
  it("formats 21 as 21st", () => { expect(ordinalSuffix(21)).toBe("21st"); });
  it("formats 22 as 22nd", () => { expect(ordinalSuffix(22)).toBe("22nd"); });
  it("formats 23 as 23rd", () => { expect(ordinalSuffix(23)).toBe("23rd"); });
  it("formats 100 as 100th", () => { expect(ordinalSuffix(100)).toBe("100th"); });
});

describe("buildSequentialEditGuidance", () => {
  it("builds a warning message for a first overlap", () => {
    const result = buildSequentialEditGuidance(
      "function writeVersion(filePath, version) {",
      "function writeVersion(filePath, version) {",
      "/path/to/version-sync.mjs", 1,
    );
    expect(result).toContain("editing the same region");
    expect(result).toContain("version-sync.mjs");
    expect(result).toContain("1st consecutive time");
    expect(result).toContain("re-read the file");
  });
  it("includes the previous and current first lines", () => {
    const result = buildSequentialEditGuidance("old version code here", "new version code here", "file.ts", 2);
    expect(result).toContain("old version code here");
    expect(result).toContain("new version code here");
    expect(result).toContain("2nd consecutive time");
  });
  it("includes the file path", () => {
    const result = buildSequentialEditGuidance("first line", "first line", "/Users/test/project/src/main.ts", 3);
    expect(result).toContain("/Users/test/project/src/main.ts");
    expect(result).toContain("3rd consecutive time");
  });
});
