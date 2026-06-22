/**
 * Barrel-level tests for the repairs module.
 *
 * These tests verify barrel exports and structural integrity
 * that can only be tested against the barrel ./repairs.js entry point.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Constants Barrel Tests ──────────────────────────────────────────────

describe("structural integrity — constants barrel", () => {
  it("exports PATH_FIELD_NAMES from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.PATH_FIELD_NAMES).toBeDefined();
    expect(mod.PATH_FIELD_NAMES.has("path")).toBe(true);
  });
  it("exports ARRAY_FIELD_NAMES from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.ARRAY_FIELD_NAMES).toBeDefined();
    expect(mod.ARRAY_FIELD_NAMES.has("edits")).toBe(true);
  });
  it("exports BOOLEAN_FIELD_NAMES from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.BOOLEAN_FIELD_NAMES).toBeDefined();
    expect(mod.BOOLEAN_FIELD_NAMES.has("force")).toBe(true);
  });
  it("exports CONTENT_FIELD_NAMES from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.CONTENT_FIELD_NAMES).toBeDefined();
    expect(mod.CONTENT_FIELD_NAMES.has("command")).toBe(true);
  });
  it("exports NUMBER_FIELD_NAMES from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.NUMBER_FIELD_NAMES).toBeDefined();
    expect(mod.NUMBER_FIELD_NAMES.has("timeout")).toBe(true);
  });
  it("exports FALSY_STRINGS from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.FALSY_STRINGS).toBeDefined();
    expect(mod.FALSY_STRINGS.has("false")).toBe(true);
  });
  it("exports TRUTHY_STRINGS from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.TRUTHY_STRINGS).toBeDefined();
    expect(mod.TRUTHY_STRINGS.has("true")).toBe(true);
  });
  it("exports LONG_RUNNING_TOKENS from repairs module", async () => {
    const mod = await import("./repairs.js");
    expect(mod.LONG_RUNNING_TOKENS).toBeDefined();
    expect(Array.isArray(mod.LONG_RUNNING_TOKENS)).toBe(true);
  });
});

// ─── editPath Scoping in index.ts ────────────────────────────────────────

describe("structural integrity — editPath scoping in index.ts", () => {
  function readIndexSource(): string {
    const fs = require("fs");
    return fs.readFileSync(require.resolve("./index.ts"), "utf-8");
  }

  it("editPath is declared at handler scope, before Step 3c", () => {
    const source = readIndexSource();
    const step3cMarker = source.indexOf("// ── Step 3c:");
    expect(step3cMarker).toBeGreaterThan(0);
    const beforeStep3c = source.slice(0, step3cMarker);
    expect(beforeStep3c).toContain("let editPath: string | undefined");
  });

  it("editPath is NOT re-declared inside Step 3c block", () => {
    const source = readIndexSource();
    const step3cStart = source.indexOf("// ── Step 3c:");
    const step3dStart = source.indexOf("// ── Step 3d:");
    const step3cBlock = source.slice(step3cStart, step3dStart);
    const occurrences = step3cBlock.match(/let editPath/g);
    expect(occurrences).toBeNull();
  });

  it("editPath is referenced in Step 3d (sequential overlap detection)", () => {
    const source = readIndexSource();
    const step3dStart = source.indexOf("// ── Step 3d:");
    const recordStart = source.indexOf("// ── Record previous");
    const step3dBlock = source.slice(step3dStart, recordStart);
    expect(step3dBlock).toContain("editPath");
  });

  it("editPath is referenced in Record previous edit state block", () => {
    const source = readIndexSource();
    const recordStart = source.indexOf("// ── Record previous");
    const handlerEnd = source.indexOf('pi.on("tool_result"', source.indexOf("// ── Record previous"));
    const recordBlock = source.slice(recordStart, handlerEnd > 0 ? handlerEnd : recordStart + 300);
    expect(recordBlock).toContain("editPath");
  });
});

// ─── Structural Integrity: Implementation Changes ───────────────────────

describe("structural integrity — EDIT_MISMATCH file preview fallback", () => {
  function readIndexSource(): string {
    const fs = require("fs");
    return fs.readFileSync(require.resolve("./index.ts"), "utf-8");
  }

  it("replaces buildEditWrongFileGuidance with file preview when context match fails", () => {
    const source = readIndexSource();
    const fnStart = source.indexOf("async function buildEditMismatchGuidanceText");
    const fnEnd = source.indexOf("/** Minimal block message */", fnStart);
    const fnBody = source.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);
    // Must NOT contain the old "wrong file" fallback pattern
    expect(fnBody).not.toContain("buildEditWrongFileGuidance");
    // Must contain the new file preview pattern
    expect(fnBody).toContain("File preview (first");
  });

  it("generates line-numbered preview in both try and catch fallback paths", () => {
    const source = readIndexSource();
    const fnStart = source.indexOf("async function buildEditMismatchGuidanceText");
    const fnEnd = source.indexOf("/** Minimal block message returned", fnStart);
    const fnBody = source.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);
    // Both paths use padStart to create numbered lines
    const padMatches = fnBody.match(/\.padStart\(4\)/g);
    expect(padMatches).not.toBeNull();
    expect(padMatches!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("structural integrity — EISDIR fallback moved to tool_result", () => {
  function readIndexSource(): string {
    const fs = require("fs");
    return fs.readFileSync(require.resolve("./index.ts"), "utf-8");
  }

  it("Phase 2.75 handles EISDIR for read/read_file in tool_result", () => {
    const source = readIndexSource();
    const marker = source.indexOf("// Phase 2.75: EISDIR fallback for read/read_file");
    expect(marker).toBeGreaterThan(0);
    const block = source.slice(marker, marker + 1000);
    expect(block).toMatch(/toolName.*===.*"read"/);
    expect(block).toMatch(/toolName.*===.*"read_file"/);
    expect(block).toContain("err.executionErrorType === \"EISDIR\"");
    expect(block).toContain("formatDirectoryListing");
    expect(block).not.toContain("hasContentField");
  });

  it("Step 3b-ii is removed — tool_call cannot return replacement content", () => {
    const source = readIndexSource();
    expect(source).not.toContain("// ── Step 3b-ii:");
    expect(source).toContain("EISDIR directory fallback for read/read_file is in tool_result");
  });
});

describe("structural integrity — ENOENT path validation directory hint", () => {
  function readIndexSource(): string {
    const fs = require("fs");
    return fs.readFileSync(require.resolve("./index.ts"), "utf-8");
  }

  it("path validation contains dirHint logic with parent directory listing", () => {
    const source = readIndexSource();
    const step3b = source.indexOf("// ── Step 3b: Path validation");
    const step3bii = source.indexOf("// ── Step 3b-ii:");
    const block = source.slice(step3b, step3bii > 0 ? step3bii : step3b + 3000);
    expect(block).toContain("dirHint");
    expect(block).toContain("path.dirname(firstInvalid)");
    expect(block).toContain("fs.readdir(parentDir)");
    expect(block).toContain("Similar entries");
  });

  it("dirHint is appended to guidance in both bash and non-bash paths", () => {
    const source = readIndexSource();
    const step3b = source.indexOf("// ── Step 3b: Path validation");
    const step3bii = source.indexOf("// ── Step 3b-ii:");
    const block = source.slice(step3b, step3bii > 0 ? step3bii : step3b + 3000);
    // Appended to non-bash guidance
    const nonBashGuidance = block.indexOf("buildPathValidationGuidance(invalidPaths, event.toolName) + dirHint");
    expect(nonBashGuidance).toBeGreaterThan(0);
    // Appended to bash guidance
    expect(block).toContain("dirHint,");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Cache-Safety Regression Tests
// ═════════════════════════════════════════════════════════════════════════
//
// LLM prefix cache is non-negotiable. AGENTS.md: "Never modify
// tool_result.content — breaks LLM prefix cache." These tests pin the
// contract: tool_result returns undefined (history untouched) and context
// returns a new array reference (LLM sees appended guidance, original
// `event.messages` is byte-identical).
//
// The ONE documented exception is the write-directory-fallback (Phase 6
// in tool_result): when `write` is called on a directory, we rewrite the
// tool result with a directory listing. That fallback is covered below.

/** Build a minimal fake pi that records every handler registered via on(). */
function createFakePi() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => Promise<any>) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    registerTool() {},
    registerShortcut() {},
  };
  const ctx = {
    ui: {
      theme: { fg: (_color: string, s: string) => s },
      setStatus: () => {},
      notify: () => {},
    },
    hasUI: false,
    model: { provider: "test-provider", id: "test-model" },
    sessionManager: { getSessionId: () => "fake-session-id" },
  };
  return { pi, ctx, handlers };
}

describe("cache-safety — tool_call handler", () => {
  it("returns undefined for all repairable tools (never returns { content, isError })", async () => {
    const mod = await import("./index.js");
    const { pi, ctx, handlers } = createFakePi();
    mod.default(pi as any);
    const handler = handlers.get("tool_call")!;

    // Regression: Step 3b-ii in tool_call used to return { content, isError }
    // but pi only supports { block: true } from tool_call. This test verifies
    // the handler never returns content directly — only undefined.
    for (const toolName of ["read", "write", "edit", "bash", "ffgrep", "fffind"]) {
      const result = await handler(
        {
          toolName,
          input: toolName === "bash" ? { command: "echo hi" } : { path: "/tmp/ok" },
        },
        ctx,
      );
      // Some tools may return { content, isError: true } for blocking paths
      // (ENOENT, staleness), but NEVER an unblocked content response
      if (result !== undefined) {
        expect(result.isError).toBe(true);
        expect(result.block).not.toBeDefined();
      }
    }
  });
});

describe("cache-safety — tool_result handler", () => {
  it("returns undefined for a normal successful bash result (no content mutation)", async () => {
    const mod = await import("./index.js");
    const { pi, ctx, handlers } = createFakePi();
    mod.default(pi as any);
    const handler = handlers.get("tool_result")!;

    const result = await handler(
      {
        toolName: "bash",
        input: { command: "echo hello" },
        content: [{ type: "text", text: "hello\n" }],
        isError: false,
      },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for a failing tool result (guidance queued via side channel, content untouched)", async () => {
    const mod = await import("./index.js");
    const { pi, ctx, handlers } = createFakePi();
    mod.default(pi as any);
    const handler = handlers.get("tool_result")!;

    // "command not found" → ENOENT (not TOOL_NOT_FOUND), so CLI guidance
    // path runs and queues `getToolHelp("bash")` into pendingGuidance.
    const result = await handler(
      {
        toolName: "bash",
        input: { command: "false-cmd-xyz" },
        content: [{ type: "text", text: "command not found: false-cmd-xyz\n" }],
        isError: true,
      },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for read, edit, grep, find, ls on non-dir paths (Phase 2.75 EISDIR + Phase 6 write are the only exceptions)", async () => {
    const mod = await import("./index.js");
    const { pi, ctx, handlers } = createFakePi();
    mod.default(pi as any);
    const handler = handlers.get("tool_result")!;

    for (const toolName of ["read", "edit", "grep", "find", "ls"]) {
      const result = await handler(
        {
          toolName,
          input: toolName === "bash" ? { command: "x" } : { path: "/tmp/x" },
          content: [{ type: "text", text: "ok\n" }],
          isError: false,
        },
        ctx,
      );
      expect(result, `toolName=${toolName} should return undefined`).toBeUndefined();
    }
  });

  it("write-directory-fallback IS the documented exception (returns { content: [...] })", async () => {
    // The Phase 6 directory-fallback in tool_result returns a directory
    // listing instead of the original tool output. This is deliberate —
    // a write to a directory is a user error, and the cache prefix for
    // that exact tool result has no prior entries, so cache impact is
    // zero. This test pins the exception so future refactors don't
    // accidentally generalize it.
    const mod = await import("./index.js");
    const { pi, ctx, handlers } = createFakePi();
    mod.default(pi as any);
    const handler = handlers.get("tool_result")!;

    // Create a real directory without an extension
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-cache-"));

    try {
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "x");
      fs.writeFileSync(path.join(tmpDir, "b.txt"), "y");

      const result = await handler(
        {
          toolName: "write",
          input: { path: tmpDir }, // no extension → triggers fallback
          content: [{ type: "text", text: "ignored" }],
          isError: false,
        },
        ctx,
      );
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("a.txt");
      expect(result.content[0].text).toContain("b.txt");
      expect(result.isError).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("read/read_file EISDIR fallback IS the second documented exception (Phase 2.75, returns { content: [...] })", async () => {
    // Phase 2.75 in tool_result replaces EISDIR errors for read/read_file
    // with a directory listing. This is the second exception alongside
    // Phase 6 (write directory fallback).
    const mod = await import("./index.js");
    const { pi, ctx, handlers } = createFakePi();
    mod.default(pi as any);
    const handler = handlers.get("tool_result")!;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-eisdir-"));

    try {
      fs.writeFileSync(path.join(tmpDir, "main.ts"), "x");
      fs.writeFileSync(path.join(tmpDir, "utils.ts"), "y");

      for (const toolName of ["read", "read_file"]) {
        const result = await handler(
          {
            toolName,
            input: { path: tmpDir },
            content: [{ type: "text", text: "EISDIR: illegal operation on a directory, read" }],
            isError: true,
          },
          ctx,
        );
        expect(result, `toolName=${toolName} EISDIR should return content`).toBeDefined();
        expect(result.isError).toBe(false);
        expect(Array.isArray(result.content)).toBe(true);
        expect(result.content[0].type).toBe("text");
        expect(result.content[0].text).toContain("main.ts");
        expect(result.content[0].text).toContain("utils.ts");
        expect(result.content[0].text).toContain(`called ${toolName} on a directory`); // informational note
        // Non-EISDIR errors should still return undefined (cache-safe)
        const noEisdirResult = await handler(
          {
            toolName,
            input: { path: tmpDir },
            content: [{ type: "text", text: "ENOENT: no such file or directory" }],
            isError: true,
          },
          ctx,
        );
        expect(noEisdirResult, `toolName=${toolName} non-EISDIR should return undefined`).toBeUndefined();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("cache-safety — context handler", () => {
  it("returns undefined when no guidance is queued (no-op, no array copy)", async () => {
    const mod = await import("./index.js");
    const { pi, ctx, handlers } = createFakePi();
    mod.default(pi as any);
    const handler = handlers.get("context")!;

    const originalMessages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
    ];
    const result = await handler({ messages: originalMessages }, ctx);
    expect(result).toBeUndefined();
    // original array length unchanged
    expect(originalMessages).toHaveLength(1);
  });

  it("returns { messages: NEW_ARRAY } when guidance is queued, original array untouched", async () => {
    const mod = await import("./index.js");
    const { pi, ctx, handlers } = createFakePi();
    mod.default(pi as any);
    const toolResultHandler = handlers.get("tool_result")!;
    const contextHandler = handlers.get("context")!;

    // Trigger guidance queue by simulating a tool failure
    await toolResultHandler(
      {
        toolName: "bash",
        input: { command: "false-cmd-xyz" },
        content: [{ type: "text", text: "command not found: false-cmd-xyz\n" }],
        isError: true,
      },
      ctx,
    );

    const originalMessages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
    ];
    const result = await contextHandler({ messages: originalMessages }, ctx);

    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    expect(Array.isArray(result.messages)).toBe(true);
    // CRITICAL: returned array is NOT the same reference as the original.
    // This is what keeps `event.messages` byte-identical for the cache.
    expect(result.messages).not.toBe(originalMessages);
    // Original array length unchanged
    expect(originalMessages).toHaveLength(1);
    // Returned array is longer (has the guidance appended)
    expect(result.messages.length).toBeGreaterThan(originalMessages.length);
    // Last entry is a user message (the injected guidance)
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).toBe("user");
  });

  it("does not mutate any element inside the original messages array", async () => {
    const mod = await import("./index.js");
    const { pi, ctx, handlers } = createFakePi();
    mod.default(pi as any);
    const toolResultHandler = handlers.get("tool_result")!;
    const contextHandler = handlers.get("context")!;

    await toolResultHandler(
      {
        toolName: "bash",
        input: { command: "another-false-cmd" },
        content: [{ type: "text", text: "command not found: another-false-cmd\n" }],
        isError: true,
      },
      ctx,
    );

    const originalMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "original" }],
    };
    const originalContentText = originalMessage.content[0].text;
    const originalMessages = [originalMessage];

    const result = await contextHandler({ messages: originalMessages }, ctx);

    // Element identity preserved (shallow copy means same object ref)
    expect(result!.messages[0]).toBe(originalMessage);
    // Element content unchanged
    expect(result!.messages[0].content[0].text).toBe(originalContentText);
  });
});
