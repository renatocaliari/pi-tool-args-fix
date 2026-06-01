/**
 * Unit tests for tool error classifier (recorder/classifier.ts).
 */

import { describe, it, expect } from "vitest";
import {
  classifyErrorType,
  getSuggestion,
  getToolHelp,
  getErrorGuidance,
  translateSchemaValidationError,
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

  it("classifies 'replacement produced identical content' as EDIT_MISMATCH", () => {
    expect(classifyErrorType("No changes made to /path/file.ts. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.")).toBe("EDIT_MISMATCH");
  });

  it("classifies 'no changes made to' as EDIT_MISMATCH", () => {
    expect(classifyErrorType("No changes made to /path/file.ts")).toBe("EDIT_MISMATCH");
  });

  it("classifies single-oldText non-unique errors as EDIT_MISMATCH", () => {
    expect(classifyErrorType("Found 40 occurrences of the text in /path/to/file.ts. The text must be unique. Please provide more context to make it unique.")).toBe("EDIT_MISMATCH");
  });

  it("returns TOOL_NOT_FOUND for 'Tool X not found'", () => {
    expect(classifyErrorType("Tool fffind not found")).toBe("TOOL_NOT_FOUND");
    expect(classifyErrorType("Tool agent_browser not found")).toBe("TOOL_NOT_FOUND");
    // Regular "not found" should still match ENOENT
    expect(classifyErrorType("no such file: package.json")).toBe("ENOENT");
  });

  it("returns EDIT_MISMATCH for edit text mismatch errors", () => {
    expect(classifyErrorType("Could not find the exact text")).toBe("EDIT_MISMATCH");
    expect(classifyErrorType("oldText does not match")).toBe("EDIT_MISMATCH");
    // edits[0]/edits[1] batch errors — model tried to edit non-existent text
    expect(classifyErrorType("Could not find edits[0] in /path/to/file.ts. The oldText must match exactly including all whitespace and newlines.")).toBe("EDIT_MISMATCH");
    expect(classifyErrorType("Could not find edits[1] in /path/to/file.ts. The oldText must match exactly including all whitespace and newlines.")).toBe("EDIT_MISMATCH");
    // Non-unique edits — "Found N occurrences of edits[N]"
    expect(classifyErrorType("Found 4 occurrences of edits[3] in /path/to/file.md. Each oldText must be unique.")).toBe("EDIT_MISMATCH");
    expect(classifyErrorType("Found 2 occurrences of edits[0] in /path/to/file.ts. Please provide more context to make it unique.")).toBe("EDIT_MISMATCH");
    expect(classifyErrorType("edits[0] and edits[1] overlap in /path/to/file.md. Merge them into one edit or target disjoint regions.")).toBe("EDIT_MISMATCH");
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
    expect(help).toContain("Generic guidance");
    expect(help).toContain("Possible causes");
    expect(help).toContain("To debug");
    expect(help).toContain("--help");
    expect(help).toContain("\"--help\"");
    expect(help).toContain("Do NOT keep retrying");
  });

  describe("getErrorGuidance", () => {
    it("returns SCHEMA_VALIDATION guidance with actionable advice", () => {
      const g = getErrorGuidance("SCHEMA_VALIDATION");
      expect(g).toContain("required field is missing");
      expect(g).toContain("Invalid enum value");
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

// ─── translateSchemaValidationError ────────────────────────────────────

describe("translateSchemaValidationError", () => {
  it("translates edits[N] missing fields error", () => {
    const err = "edits.0.oldText: must have required properties oldText, newText";
    expect(translateSchemaValidationError(err)).toBe(
      'edits[0] is missing required fields: must have required properties oldText, newText',
    );
  });

  it("translates missing required root path argument", () => {
    const err = "path: must have required properties path";
    const result = translateSchemaValidationError(err);
    expect(result).toBe('Missing required argument: "path" (must have required properties path)');
  });

  it("translates missing required edits argument", () => {
    const err = "edits: must have required properties edits";
    const result = translateSchemaValidationError(err);
    expect(result).toBe('Missing required argument: "edits" (must have required properties edits)');
  });

  it("translates overlap error into actionable instruction", () => {
    const err = "edits[0] and edits[1] overlap in /path/to/file.md. Merge them into one edit or target disjoint regions.";
    expect(translateSchemaValidationError(err)).toBe(
      "edits[0] and edits[1] target overlapping regions in /path/to/file.md. Merge them into one edit or make each edits[i].oldText target a unique, non-overlapping part of the file.",
    );
  });

  it("returns null for non-schema errors", () => {
    expect(translateSchemaValidationError("EISDIR: illegal operation on a directory, read")).toBeNull();
    expect(translateSchemaValidationError("ENOENT: no such file or directory")).toBeNull();
  });

  it("returns null for null/empty input", () => {
    expect(translateSchemaValidationError(null)).toBeNull();
    expect(translateSchemaValidationError("")).toBeNull();
  });
});
});
