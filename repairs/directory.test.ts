/**
 * Tests for directory fallback and content extraction functions.
 */

import { describe, it, expect } from "vitest";
import { isEisdirError, extractTextContent, formatDirectoryListing } from "../repairs/directory.js";

describe("isEisdirError", () => {
  it("detects raw Node.js EISDIR error", () => {
    expect(isEisdirError("EISDIR: illegal operation on a directory, read")).toBe(true);
  });
  it("detects just the EISDIR code", () => {
    expect(isEisdirError("EISDIR")).toBe(true);
  });
  it("detects 'illegal operation on a directory' message", () => {
    expect(isEisdirError("illegal operation on a directory")).toBe(true);
  });
  it("detects 'is a directory' safe error", () => {
    expect(isEisdirError("/path/to/dir is a directory")).toBe(true);
  });
  it("detects mixed-case variations", () => {
    expect(isEisdirError("EisDir")).toBe(true);
    expect(isEisdirError("Illegal Operation on a Directory")).toBe(true);
  });
  it("does NOT false-positive on other errors", () => {
    expect(isEisdirError("ENOENT: no such file or directory")).toBe(false);
    expect(isEisdirError("EACCES: permission denied")).toBe(false);
    expect(isEisdirError("Command failed with exit code 1")).toBe(false);
    expect(isEisdirError("Connection refused")).toBe(false);
  });
});

describe("extractTextContent", () => {
  it("extracts text from tool result content array", () => {
    const content = [{ type: "text", text: "Hello, world!" }];
    expect(extractTextContent(content)).toBe("Hello, world!");
  });
  it("extracts text from multi-part content", () => {
    const content = [{ type: "image", url: "img.png" }, { type: "text", text: "Result text" }];
    expect(extractTextContent(content)).toBe("Result text");
  });
  it("returns null for non-array content", () => {
    expect(extractTextContent("string")).toBeNull();
    expect(extractTextContent({})).toBeNull();
    expect(extractTextContent(null)).toBeNull();
    expect(extractTextContent(undefined)).toBeNull();
  });
  it("returns null for empty array", () => {
    expect(extractTextContent([])).toBeNull();
  });
  it("returns null when no text part exists", () => {
    const content = [{ type: "image", url: "img.png" }];
    expect(extractTextContent(content)).toBeNull();
  });
  it("handles content with isError metadata", () => {
    const content = [{ type: "text", text: "EISDIR: illegal operation on a directory, read" }];
    expect(extractTextContent(content)).toBe("EISDIR: illegal operation on a directory, read");
  });
});

describe("formatDirectoryListing", () => {
  it("formats listing for read tool with multiple entries", () => {
    const result = formatDirectoryListing("/home/user/project/src", ["main.ts", "utils.ts", "components"], "read");
    expect(result.listingContent).toContain("Directory: /home/user/project/src");
    expect(result.listingContent).toContain("  main.ts");
    expect(result.listingContent).toContain("3 entries total.");
    expect(result.listingContent).toContain("The model called read on a directory.");
    expect(result.detail).toBe("src: directory fallback (3 entries listed)");
    expect(result.dirName).toBe("src");
  });
  it("formats listing for read_file tool with single entry", () => {
    const result = formatDirectoryListing("/home/user/project", ["main.ts"], "read_file");
    expect(result.listingContent).toContain("1 entry total.");
    expect(result.listingContent).toContain("The model called read_file on a directory.");
    expect(result.detail).toBe("project: directory fallback (1 entry listed)");
    expect(result.dirName).toBe("project");
  });
  it("handles empty directory", () => {
    const result = formatDirectoryListing("/empty/dir", [], "read");
    expect(result.listingContent).toContain("0 entries total.");
    expect(result.detail).toBe("dir: directory fallback (0 entries listed)");
  });
  it("uses singular 'entry' for count of 1", () => {
    const result = formatDirectoryListing("/x", ["a"], "read");
    expect(result.listingContent).toContain("1 entry total.");
  });
  it("uses plural 'entries' for non-1 count", () => {
    const result2 = formatDirectoryListing("/x", ["a", "b"], "read");
    expect(result2.listingContent).toContain("2 entries total.");
    const result0 = formatDirectoryListing("/x", [], "read");
    expect(result0.listingContent).toContain("0 entries total.");
  });
});
