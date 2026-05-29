/**
 * Unit tests for tool error classifier (recorder/classifier.ts).
 */

import { describe, it, expect } from "vitest";
import {
  classifyErrorType,
  getSuggestion,
  getToolHelp,
  getErrorGuidance,
} from "./classifier.js";

// ─── classifyErrorType ────────────────────────────────────────────────

describe("classifyErrorType", () => {
  it("classifies EISDIR", () => {
    expect(classifyErrorType("Error: EISDIR: illegal operation on a directory")).toBe("EISDIR");
  });

  it("classifies ENOENT", () => {
    expect(classifyErrorType("ENOENT: no such file or directory")).toBe("ENOENT");
    expect(classifyErrorType("no such file: /foo/bar")).toBe("ENOENT");
    expect(classifyErrorType("not found: index.ts")).toBe("ENOENT");
  });

  it("classifies EACCES", () => {
    expect(classifyErrorType("EACCES: permission denied")).toBe("EACCES");
    expect(classifyErrorType("permission denied: /etc/shadow")).toBe("EACCES");
    expect(classifyErrorType("EPERM: operation not permitted")).toBe("EACCES");
  });

  it("classifies timeout", () => {
    expect(classifyErrorType("timeout: operation timed out")).toBe("timeout");
    expect(classifyErrorType("timed out after 30s")).toBe("timeout");
  });

  it("classifies rate_limit", () => {
    expect(classifyErrorType("429 Too Many Requests")).toBe("rate_limit");
    expect(classifyErrorType("rate limit exceeded")).toBe("rate_limit");
  });

  it("classifies bad_request", () => {
    expect(classifyErrorType("400 Bad Request")).toBe("bad_request");
    expect(classifyErrorType("bad request: invalid params")).toBe("bad_request");
  });

  it("classifies HTTP error codes", () => {
    expect(classifyErrorType("Error 500: internal server error")).toBe("HTTP_500");
    expect(classifyErrorType("503 Service Unavailable")).toBe("HTTP_503");
    expect(classifyErrorType("403 Forbidden")).toBe("HTTP_403");
  });

  it("ignores 304 Not Modified (3xx)", () => {
    expect(classifyErrorType("304 Not Modified")).toBeNull();
  });

  it("returns null for null/empty input", () => {
    expect(classifyErrorType(null)).toBeNull();
    expect(classifyErrorType("")).toBeNull();
  });

  it("returns null for unrecognized errors", () => {
    expect(classifyErrorType("something completely different")).toBeNull();
    expect(classifyErrorType("\nCommand exited with code 1")).toBeNull();
  });

  it("returns EDIT_MISMATCH for edit text mismatch errors", () => {
    expect(classifyErrorType("Could not find the exact text")).toBe("EDIT_MISMATCH");
    expect(classifyErrorType("oldText does not match")).toBe("EDIT_MISMATCH");
    // edits[0]/edits[1] batch errors — model tried to edit non-existent text
    expect(classifyErrorType("Could not find edits[0] in /path/to/file.ts. The oldText must match exactly including all whitespace and newlines.")).toBe("EDIT_MISMATCH");
    expect(classifyErrorType("Could not find edits[1] in /path/to/file.ts. The oldText must match exactly including all whitespace and newlines.")).toBe("EDIT_MISMATCH");
  });

  it("picks the first matching category when multiple match", () => {
    expect(classifyErrorType("EISDIR: no such file or directory")).toBe("EISDIR");
  });

  it("classifies SCHEMA_VALIDATION for validation failures", () => {
    expect(classifyErrorType("Validation failed for tool \"ask_user_question\":\n  - questions.1.header: must not have more than 16 characters")).toBe("SCHEMA_VALIDATION");
    expect(classifyErrorType("must not have more than 100 items")).toBe("SCHEMA_VALIDATION");
    expect(classifyErrorType("must be one of: [\"read\", \"write\"]")).toBe("SCHEMA_VALIDATION");
    expect(classifyErrorType("must match pattern \"^[a-z]+$\"")).toBe("SCHEMA_VALIDATION");
  });

  it("does not classify non-schema errors as SCHEMA_VALIDATION", () => {
    expect(classifyErrorType("no such file: package.json")).not.toBe("SCHEMA_VALIDATION");
    expect(classifyErrorType("timeout: operation timed out")).not.toBe("SCHEMA_VALIDATION");
    // "must match" in edit errors should NOT trigger SCHEMA_VALIDATION
    expect(classifyErrorType("Could not find edits[0] in /path/file.ts. The oldText must match exactly including all whitespace and newlines.")).not.toBe("SCHEMA_VALIDATION");
    expect(classifyErrorType("Could not find the exact text in /path/file.ts. The old text must match exactly including all whitespace and newlines.")).not.toBe("SCHEMA_VALIDATION");
  });
});

// ─── getSuggestion ──────────────────────────────────────────────────

describe("getSuggestion", () => {
  it("returns predefined suggestion for known categories", () => {
    const suggestion = getSuggestion("EISDIR", "read");
    expect(suggestion).toContain("directory-listing");
  });

  it("returns fallback for unknown categories", () => {
    const suggestion = getSuggestion("UNKNOWN", "test");
    expect(suggestion).toContain("Investigate");
    expect(suggestion).toContain("test");
    expect(suggestion).toContain("UNKNOWN");
  });
});

// ─── getToolHelp ─────────────────────────────────────────────────────

describe("getToolHelp", () => {
  it("returns bash guidance", () => {
    const help = getToolHelp("bash");
    expect(help).toContain("bash");
    expect(help).toContain("Exit code");
    expect(help).toContain("--help");
  });

  it("returns grep guidance with exit code semantics", () => {
    const help = getToolHelp("grep");
    expect(help).toContain("grep");
    expect(help).toContain("Exit code 0");
    expect(help).toContain("Exit code 1");
    expect(help).toContain("Exit code 2");
  });

  it("returns find guidance", () => {
    const help = getToolHelp("find");
    expect(help).toContain("find");
    expect(help).toContain("Exit code 0");
    expect(help).toContain("Exit code 1");
  });

  it("returns ls guidance", () => {
    const help = getToolHelp("ls");
    expect(help).toContain("ls");
    expect(help).toContain("Exit code 0");
    expect(help).toContain("Exit code 1");
  });

  it("returns edit guidance about re-reading the file", () => {
    const help = getToolHelp("edit");
    expect(help).toContain("edit");
    expect(help).toContain("oldText");
    expect(help).toContain("read");
  });

  it("returns read guidance about file existence", () => {
    const help = getToolHelp("read");
    expect(help).toContain("read");
    expect(help).toContain("does not exist");
  });

  it("returns write guidance about permissions", () => {
    const help = getToolHelp("write");
    expect(help).toContain("write");
    expect(help).toContain("Permission denied");
  });

  it("returns generic guidance for unknown tools", () => {
    const help = getToolHelp("rsync");
    expect(help).toContain("Consider checking");
  });

  describe("getErrorGuidance", () => {
    it("returns SCHEMA_VALIDATION guidance with actionable advice", () => {
      const g = getErrorGuidance("SCHEMA_VALIDATION");
      expect(g).toContain("permanent error");
      expect(g).toContain("Required field missing");
      expect(g).toContain("enum value");
      expect(g).toContain("argument");
    });

    it("returns null for unknown categories", () => {
      expect(getErrorGuidance("ENOENT")).toBeNull();
      expect(getErrorGuidance("EACCES")).toBeNull();
      expect(getErrorGuidance("nonsense_category")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(getErrorGuidance("")).toBeNull();
    });
  });
});
