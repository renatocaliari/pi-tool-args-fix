/**
 * Tests for path utility repair functions.
 */

import { describe, it, expect } from "vitest";
import { unwrapMarkdownLink, cleanPathValue, resolvePath, isUrlOrFlag, extractBashPaths, extractPathsFromArgs } from "../repairs/path-utils.js";
import { isContentField } from "../repairs/classification.js";

describe("unwrapMarkdownLink", () => {
  it("unwraps markdown link where text equals URL without protocol", () => {
    expect(unwrapMarkdownLink("[notes.md](http://notes.md)")).toBe("notes.md");
    expect(unwrapMarkdownLink("[file.ts](https://file.ts)")).toBe("file.ts");
    expect(unwrapMarkdownLink("[data.json](file://data.json)")).toBe("data.json");
  });
  it("unwraps when link text equals URL exactly", () => {
    expect(unwrapMarkdownLink("[file.ts](file.ts)")).toBe("file.ts");
  });
  it("does NOT unwrap real markdown links", () => {
    expect(unwrapMarkdownLink("[click here](https://example.com)")).toBe("[click here](https://example.com)");
    expect(unwrapMarkdownLink("[docs](https://docs.example.com)")).toBe("[docs](https://docs.example.com)");
  });
  it("passes through non-string values", () => {
    expect(unwrapMarkdownLink(42 as any)).toBe(42);
    expect(unwrapMarkdownLink(null as any)).toBe(null);
  });
  it("passes through plain strings", () => {
    expect(unwrapMarkdownLink("notes.md")).toBe("notes.md");
    expect(unwrapMarkdownLink("/path/to/file")).toBe("/path/to/file");
  });
});

describe("cleanPathValue", () => {
  it("trims whitespace", () => {
    expect(cleanPathValue("  notes.md  ")).toBe("notes.md");
  });
  it("unwraps markdown links", () => {
    expect(cleanPathValue("[notes.md](http://notes.md)")).toBe("notes.md");
  });
  it("resolves ~/ paths", () => {
    const result = cleanPathValue("~/Documents/notes.md");
    expect(result).toContain("Documents/notes.md");
    expect(result).not.toContain("~");
  });
  it("returns undefined for non-strings", () => {
    expect(cleanPathValue(42)).toBeUndefined();
    expect(cleanPathValue(null)).toBeUndefined();
  });
  it("resolves ~ paths without trailing slash", () => {
    const result = cleanPathValue("~/notes.md");
    expect(result).toContain("notes.md");
    expect(result).not.toContain("~~");
  });
});

describe("resolvePath", () => {
  it("resolves tilde to home directory", () => {
    expect(resolvePath("~/dev/file.ts", "/Users/cali")).toBe("/Users/cali/dev/file.ts");
  });
  it("passes absolute paths through unchanged", () => {
    expect(resolvePath("/etc/config.json", "/Users/cali")).toBe("/etc/config.json");
  });
  it("passes relative paths through unchanged", () => {
    expect(resolvePath("./src/file.ts", "/Users/cali")).toBe("./src/file.ts");
  });
  it("uses default home when not provided", () => {
    expect(resolvePath("~/file.ts")).toBe("/home/user/file.ts");
  });
  it("preserves tilde in non-leading position", () => {
    expect(resolvePath("/path/~user/file.ts", "/home/x")).toBe("/path/~user/file.ts");
  });
  it("handles tilde with no home set", () => {
    expect(resolvePath("~/")).toBe("/home/user/");
  });
  it("handles just tilde", () => {
    expect(resolvePath("~", "/Users/test")).toBe("/Users/test");
  });
});

describe("isUrlOrFlag", () => {
  it("detects http URLs", () => {
    expect(isUrlOrFlag("https://example.com/file")).toBe(true);
    expect(isUrlOrFlag("http://localhost:8080")).toBe(true);
  });
  it("detects flag arguments", () => {
    expect(isUrlOrFlag("-r")).toBe(true);
    expect(isUrlOrFlag("--verbose")).toBe(true);
  });
  it("returns false for normal file paths", () => {
    expect(isUrlOrFlag("/etc/hosts")).toBe(false);
    expect(isUrlOrFlag("./src/main.ts")).toBe(false);
    expect(isUrlOrFlag("../config.json")).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(isUrlOrFlag("")).toBe(false);
  });
});

describe("extractPathsFromArgs", () => {
  it("extracts from path fields", () => {
    const args = { path: "/tmp/file.ts", target: "/tmp/other.js" };
    const paths = extractPathsFromArgs(args);
    expect(paths).toContain("/tmp/file.ts");
    expect(paths).toContain("/tmp/other.js");
  });
  it("extracts from files array as objects", () => {
    const args = { files: [{ path: "/tmp/a.ts" }, { path: "/tmp/b.ts" }] };
    const paths = extractPathsFromArgs(args);
    expect(paths).toContain("/tmp/a.ts");
    expect(paths).toContain("/tmp/b.ts");
  });
  it("extracts from files array as strings", () => {
    const args = { files: ["/tmp/a.ts", "/tmp/b.ts"] };
    const paths = extractPathsFromArgs(args);
    expect(paths).toContain("/tmp/a.ts");
    expect(paths).toContain("/tmp/b.ts");
  });
  it("extracts quoted paths from bash commands", () => {
    const args = { command: "cat '/tmp/my file.ts'" };
    const paths = extractPathsFromArgs(args);
    expect(paths).toContain("/tmp/my file.ts");
  });
  it("handles null/undefined entries in files array gracefully", () => {
    const args = { files: [{ path: "/tmp/a.ts" }, null, undefined, { path: "/tmp/d.ts" }] };
    const paths = extractPathsFromArgs(args);
    expect(paths).toContain("/tmp/a.ts");
    expect(paths).toContain("/tmp/d.ts");
    expect(paths).toHaveLength(2);
  });
  it("handles files entries without path property", () => {
    const args = { files: [{ name: "config.json" }] };
    const paths = extractPathsFromArgs(args);
    expect(paths).toEqual([]);
  });
  it("returns empty array when no paths found", () => {
    const args = { command: "echo hello" };
    expect(extractPathsFromArgs(args)).toEqual([]);
  });
  it("handles empty args gracefully", () => {
    expect(extractPathsFromArgs({})).toEqual([]);
  });
  it("handles args with null values", () => {
    const args = { path: null, target: undefined };
    const paths = extractPathsFromArgs(args);
    expect(paths).toEqual([]);
  });
});

describe("attribute-based path validation logic", () => {
  it("validates paths for tools without content fields (e.g., read)", () => {
    const args = { path: "/tmp/missing.ts" };
    const paths = extractPathsFromArgs(args);
    const hasContent = Object.keys(args).some(k => isContentField(k));
    expect(paths.length).toBeGreaterThan(0);
    expect(hasContent).toBe(false);
  });
  it("skips validation for write tools that have content field", () => {
    const args = { path: "/tmp/new-file.ts", content: "hello world" };
    const paths = extractPathsFromArgs(args);
    const hasContent = Object.keys(args).some(k => isContentField(k));
    expect(paths.length).toBeGreaterThan(0);
    expect(hasContent).toBe(true);
  });
  it("validates paths for edit tool (edits array is not a content field, oldText is nested)", () => {
    const args = { path: "/tmp/missing.ts", edits: [{ oldText: "a", newText: "b" }] };
    const paths = extractPathsFromArgs(args);
    const hasContent = Object.keys(args).some(k => isContentField(k));
    expect(paths.length).toBeGreaterThan(0);
    expect(hasContent).toBe(false);
  });
  it("validates paths for edit with array of edits", () => {
    const args = { path: "/tmp/missing.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] };
    const paths = extractPathsFromArgs(args);
    const hasContent = Object.keys(args).some(k => isContentField(k));
    expect(paths.length).toBeGreaterThan(0);
    expect(hasContent).toBe(false);
  });
  it("covers unknown/extension tools with path but no content", () => {
    const args = { path: "/tmp/screenshot.png" };
    const paths = extractPathsFromArgs(args);
    const hasContent = Object.keys(args).some(k => isContentField(k));
    expect(paths.length).toBeGreaterThan(0);
    expect(hasContent).toBe(false);
  });
  it("covers unknown/extension tools with path AND content", () => {
    const args = { path: "/tmp/new.doc", text: "report content" };
    const paths = extractPathsFromArgs(args);
    const hasContent = Object.keys(args).some(k => isContentField(k));
    expect(paths.length).toBeGreaterThan(0);
    expect(hasContent).toBe(true);
  });
  it("returns empty paths for tools with no path fields (e.g., web_search)", () => {
    const args = { query: "hello world" };
    const paths = extractPathsFromArgs(args);
    const hasContent = Object.keys(args).some(k => isContentField(k));
    expect(paths.length).toBe(0);
    expect(hasContent).toBe(false);
  });
  it("skips validation for tools with paths and multiple content fields", () => {
    const args = { path: "/tmp/data.json", code: "const x = 1;", description: "test" };
    const paths = extractPathsFromArgs(args);
    const hasContent = Object.keys(args).some(k => isContentField(k));
    expect(paths.length).toBeGreaterThan(0);
    expect(hasContent).toBe(true);
  });
  it("bash tool: has command (content) so validation skips", () => {
    const args = { command: "cat /tmp/file.ts" };
    const paths = extractPathsFromArgs(args);
    const hasContent = Object.keys(args).some(k => isContentField(k));
    expect(hasContent).toBe(true);
  });
});

describe("extractBashPaths", () => {
  it("extracts cd targets when target contains path separator", () => {
    expect(extractBashPaths("cd src/components")).toContain("src/components");
    expect(extractBashPaths("cd ./subdir")).toContain("./subdir");
  });

  it("extracts paths starting with ./", () => {
    expect(extractBashPaths("./script.sh --help")).toContain("./script.sh");
    expect(extractBashPaths("go run ./cmd/web/")).toContain("./cmd/web/");
  });

  it("extracts paths with file extensions", () => {
    expect(extractBashPaths("cat file.ts")).toContain("file.ts");
    expect(extractBashPaths("cat config.json")).toContain("config.json");
    expect(extractBashPaths("go run main.go")).toContain("main.go");
    expect(extractBashPaths("source .env")).toContain(".env");
  });

  it("does NOT extract flags", () => {
    expect(extractBashPaths("ls -la")).toEqual([]);
    expect(extractBashPaths("cat --help")).toEqual([]);
  });

  it("does NOT extract env vars", () => {
    expect(extractBashPaths("echo $HOME")).toEqual([]);
    expect(extractBashPaths("cd $GOPATH/src")).toEqual([]);
  });

  it("does NOT extract URLs", () => {
    expect(extractBashPaths("curl https://example.com")).toEqual([]);
  });

  it("extracts multiple paths from complex commands", () => {
    const result = extractBashPaths("cat src/main.ts src/utils.ts && go build ./cmd/");
    expect(result).toContain("src/main.ts");
    expect(result).toContain("src/utils.ts");
    expect(result).toContain("./cmd/");
  });

  it("deduplicates paths", () => {
    const result = extractBashPaths("cat file.ts file.ts");
    expect(result.filter(p => p === "file.ts")).toHaveLength(1);
  });

  it("handles empty command", () => {
    expect(extractBashPaths("")).toEqual([]);
  });

  it("handles command with only flags", () => {
    expect(extractBashPaths("ls -la -R --all")).toEqual([]);
  });

  it("handles piped commands", () => {
    const result = extractBashPaths("cat data.json | jq .name");
    expect(result).toContain("data.json");
  });

  it("handles commands with single-quoted paths (already handled by extractPathsFromArgs)", () => {
    // extractBashPaths doesn't handle quotes — that's extractPathsFromArgs' job
    expect(extractBashPaths("cat '/path/with spaces.ts'")).toContain("'/path/with");
  });

  it("extracts paths with ./ prefix", () => {
    expect(extractBashPaths("./run.sh")).toContain("./run.sh");
    expect(extractBashPaths("../build/output.bin")).toContain("../build/output.bin");
  });

  it("handles paths with hyphens in name (not flags)", () => {
    const result = extractBashPaths("cat my-config.dev.json");
    expect(result).toContain("my-config.dev.json");
  });

  it("rejects tokens starting with minus that look like flags not paths", () => {
    const result = extractBashPaths("some-tool --output-dir ./build");
    expect(result).not.toContain("--output-dir");
    expect(result).toContain("./build");
  });
});
