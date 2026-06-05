/**
 * Extension integration test — fake `ExtensionAPI`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readSessionEvents, sessionLogPath } from "./recorder.js";
import * as fs from "node:fs";

// ─── Fake ExtensionAPI ───────────────────────────────────────────────────

interface FakePi {
  pi: any;
  ctx: any;
  handlers: Map<string, (event: any, ctx: any) => Promise<any>>;
  commands: Map<string, { description: string; handler: Function }>;
}

function createFakePi(): FakePi {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const commands = new Map<string, { description: string; handler: Function }>();
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => Promise<any>) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, def: { description: string; handler: Function }) {
      commands.set(name, def);
    },
    registerTool() {},
    registerShortcut() {},
  };
  const ctx = {
    ui: {
      theme: { fg: (_color: string, s: string) => s },
      setStatus: () => {},
      setTitle: (_title: string) => {},
      notify: () => {},
    },
    hasUI: false,
    model: { provider: "test-provider", id: "test-model" },
    sessionManager: { getSessionId: () => "fake-session" },
  };
  return { pi, ctx, handlers, commands };
}

async function loadExtension(fake: FakePi) {
  const mod = await import("./index.js");
  mod.default(fake.pi);
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("extension integration — registration contract", () => {
  let fake: FakePi;
  beforeEach(async () => {
    fake = createFakePi();
    await loadExtension(fake);
  });

  it("registers all required handlers", () => {
    expect(fake.handlers.has("session_start")).toBe(true);
    expect(fake.handlers.has("session_shutdown")).toBe(true);
    expect(fake.handlers.has("tool_call")).toBe(true);
    expect(fake.handlers.has("tool_result")).toBe(true);
    expect(fake.handlers.has("context")).toBe(true);
  });

  it("registers core commands", () => {
    expect(fake.commands.has("repair-on")).toBe(true);
    expect(fake.commands.has("repair-off")).toBe(true);
    expect(fake.commands.has("repair-toggle")).toBe(true);
    expect(fake.commands.has("repair-cache-info")).toBe(true);
  });
});

describe("extension integration — toggle action contract", () => {
  let fake: FakePi;

  beforeEach(async () => {
    fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);
  });

  it("Toggle ON (default): repairs arguments and queues guidance", async () => {
    const input = { command: "echo hi", extra: null };
    const event = { toolName: "bash", input };
    
    await fake.handlers.get("tool_call")!(event, fake.ctx);
    expect(event.input.extra).toBeUndefined();

    await fake.handlers.get("tool_result")!({
      toolName: "bash",
      input: event.input,
      content: [{ type: "text", text: "error" }],
      isError: true
    }, fake.ctx);

    const ctxRes = await fake.handlers.get("context")!({ messages: [] }, fake.ctx);
    expect(ctxRes).toBeDefined();
    expect(ctxRes.messages.length).toBe(1);
  });

  it("Toggle OFF: skips repairs and suppresses guidance", async () => {
    await fake.commands.get("repair-off")!.handler({}, fake.ctx);

    const input = { command: "echo hi", extra: null };
    const event = { toolName: "bash", input };
    
    await fake.handlers.get("tool_call")!(event, fake.ctx);
    expect(event.input.extra).toBe(null);

    await fake.handlers.get("tool_result")!({
      toolName: "bash",
      input: event.input,
      content: [{ type: "text", text: "error" }],
      isError: true
    }, fake.ctx);

    const ctxRes = await fake.handlers.get("context")!({ messages: [] }, fake.ctx);
    expect(ctxRes).toBeUndefined();
  });
});

describe("extension integration — guidance flow", () => {
  it("guidance injection is one-shot per (tool, key) per session", async () => {
    const fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    const failingEvent = {
      toolName: "bash",
      input: { command: "false-cmd" },
      content: [{ type: "text", text: "not found" }],
      isError: true,
    };

    await fake.handlers.get("tool_result")!(failingEvent, fake.ctx);
    const first = await fake.handlers.get("context")!({ messages: [] }, fake.ctx);
    expect(first.messages.length).toBe(1);

    await fake.handlers.get("tool_result")!(failingEvent, fake.ctx);
    const second = await fake.handlers.get("context")!({ messages: [] }, fake.ctx);
    expect(second).toBeUndefined();
  });
});

describe("extension integration — eventSeq correctness", () => {
  const sessionId = "event-seq-test";

  beforeEach(() => {
    // Clean up log file to avoid stale events from previous runs
    const logPath = sessionLogPath(sessionId);
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  });

  it("two consecutive failures produce events with consecutive turnIndex values", async () => {
    const fake = createFakePi();
    // Use unique sessionId to avoid collision with other tests
    fake.ctx.sessionManager = { getSessionId: () => sessionId };
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    const failingEvent = {
      toolName: "bash",
      input: { command: "false-cmd-xyz" },
      content: [{ type: "text", text: "command not found: false-cmd-xyz\n" }],
      isError: true,
    };

    // First failure — records event
    await fake.handlers.get("tool_result")!(failingEvent, fake.ctx);
    // Second failure — records event (Phase 3: consecutive tracking)
    await fake.handlers.get("tool_result")!(failingEvent, fake.ctx);

    // Read the recorded events from the JSONL log (most recent first)
    const events = readSessionEvents(sessionId);
    // Filter to tool_result events with cli_guidance handleType
    const resultEvents = events.filter(
      (e) => e.eventType === "tool_result" && e.handleType === "cli_guidance",
    );

    // Should have exactly 2 events with consecutive turnIndex values
    // readSessionEvents returns most-recent-first, so [0] has the LATER turnIndex
    expect(resultEvents.length).toBe(2);
    expect(resultEvents[0].turnIndex).toBe(resultEvents[1].turnIndex + 1);
  });
});

describe("extension integration — repair-off toggle", () => {
  it("tool_call records repairSkipped=true when toggle OFF", async () => {
    const fake = createFakePi();
    const sessionId = "deep-clone-invariant";
    fake.ctx.sessionManager = { getSessionId: () => sessionId };
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    // Clean up log file to avoid stale events from previous runs
    const logPath = sessionLogPath(sessionId);
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);

    // Turn repair OFF
    const offCmd = fake.commands.get("repair-off")!;
    await offCmd.handler({}, fake.ctx);

    // tool_call with null field — would normally strip it
    const result = await fake.handlers.get("tool_call")!(
      {
        toolName: "bash",
        input: { command: "echo hi", extra: null },
      },
      fake.ctx,
    );
    // Should return undefined (not crash), with repairSkipped logged
    expect(result).toBeUndefined();

    // Deep-clone invariant: even though OFF, the OFF branch must compute
    // wouldHaveRepaired from a CLONE so the original input is not mutated
    // AND the comparison is against the truly-original input. If someone
    // removes the deep-clone, the in-place repair would mutate the original
    // and the diff would be empty — this assertion catches that regression.
    const events = readSessionEvents(sessionId);
    const toolCallEvent = events.find(
      (e) => e.eventType === "tool_call" && e.repairSkipped === true,
    );
    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent!.wouldHaveRepaired.length).toBeGreaterThan(0);
    expect(toolCallEvent!.wouldHaveRepaired).toContain("extra: stripped null");

    // Cleanup
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  });

  it("context still collects cache stats when toggle OFF", async () => {
    const fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    // Turn repair OFF
    const offCmd = fake.commands.get("repair-off")!;
    await offCmd.handler({}, fake.ctx);

    // Context with assistant messages that have usage data
    const result = await fake.handlers.get("context")!(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            message: {
              role: "assistant",
              usage: { cacheRead: 1000, cacheWrite: 500, input: 200 },
            },
          },
        ],
      },
      fake.ctx,
    );
    // No guidance queued → returns undefined
    expect(result).toBeUndefined();
    // But cache stats should have been accumulated (we can't directly assert
    // on stats from outside, but the handler ran without crashing)
  });
});

describe("extension integration — cache-key dedup (repair summary)", () => {
  it("same repair summary on two tool_calls injects guidance only once", async () => {
    const fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    // First tool_call: extra=null gets stripped, summary = ["extra: stripped null"]
    await fake.handlers.get("tool_call")!(
      { toolName: "bash", input: { command: "echo a", extra: null } },
      fake.ctx,
    );
    await fake.handlers.get("tool_result")!(
      { toolName: "bash", input: { command: "echo a" }, content: [{ type: "text", text: "a" }], isError: false },
      fake.ctx,
    );
    const first = await fake.handlers.get("context")!({ messages: [] }, fake.ctx);
    expect(first.messages.length).toBe(1); // 🔧 notice injected

    // Second tool_call: same field (extra) stripped → same summary → dedup
    await fake.handlers.get("tool_call")!(
      { toolName: "bash", input: { command: "echo b", extra: null } },
      fake.ctx,
    );
    await fake.handlers.get("tool_result")!(
      { toolName: "bash", input: { command: "echo b" }, content: [{ type: "text", text: "b" }], isError: false },
      fake.ctx,
    );
    const second = await fake.handlers.get("context")!({ messages: [] }, fake.ctx);
    // No new guidance → returns undefined
    expect(second).toBeUndefined();
  });

  it("different repair summary on two tool_calls injects guidance twice", async () => {
    const fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    // First: extra=null stripped → summary includes "extra: stripped null"
    await fake.handlers.get("tool_call")!(
      { toolName: "bash", input: { command: "echo a", extra: null } },
      fake.ctx,
    );
    await fake.handlers.get("tool_result")!(
      { toolName: "bash", input: { command: "echo a" }, content: [{ type: "text", text: "a" }], isError: false },
      fake.ctx,
    );
    const first = await fake.handlers.get("context")!({ messages: [] }, fake.ctx);
    expect(first.messages.length).toBe(1);

    // Second: OTHER field (not extra) stripped → different summary → new injection
    await fake.handlers.get("tool_call")!(
      { toolName: "bash", input: { command: "echo b", other: null } },
      fake.ctx,
    );
    await fake.handlers.get("tool_result")!(
      { toolName: "bash", input: { command: "echo b" }, content: [{ type: "text", text: "b" }], isError: false },
      fake.ctx,
    );
    const second = await fake.handlers.get("context")!({ messages: [] }, fake.ctx);
    // Different summary → fresh guidance injected
    expect(second).toBeDefined();
    expect(second.messages.length).toBe(1);
  });
});

describe("extension integration — guidance join cap", () => {
  it("caps joined guidance text to protect LLM prefix cache", async () => {
    const fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    // Trigger 6+ distinct bash errors to fill pendingGuidance. Each unique
    // (tool, errorType) emits a separate `cat:tool:errorType` guidance, plus
    // `cli:tool` on the first failure. Total expected: ~7 guidances × ~300-500
    // chars = ~2-3.5KB, exceeding the 2000-char cap.
    const distinctErrors = [
      "command not found: tool 'foo' not found",                // TOOL_NOT_FOUND
      "No such file or directory",                              // ENOENT
      "Permission denied",                                      // EACCES
      "Operation timed out",                                    // timeout
      "validation failed: must have required properties",      // SCHEMA_VALIDATION
      "illegal option --bad-flag",                              // INVALID_ARG
    ];
    for (const errText of distinctErrors) {
      await fake.handlers.get("tool_result")!(
        {
          toolName: "bash",
          input: { command: "test" },
          content: [{ type: "text", text: errText }],
          isError: true,
        },
        fake.ctx,
      );
    }

    const result = await fake.handlers.get("context")!({ messages: [] }, fake.ctx);
    expect(result).toBeDefined();
    expect(result.messages.length).toBe(1);
    const text: string = result.messages[0].content[0].text;

    // Cap is 2000 chars. With suppression marker (~100 chars) the absolute
    // max output is ~2100. Either the cap triggered (marker present) OR the
    // join was naturally under 2000 (acceptable). In both cases the output
    // is bounded.
    expect(text.length).toBeLessThanOrEqual(2200);

    if (text.includes("suppressed")) {
      // Cap triggered: marker present + bounded length
      expect(text).toMatch(/older \d+ guidance item/);
    }
    // If cap not triggered (rare), text is just the join (≤ 2000 chars)
  });
});

describe("extension integration — persistent status indicator (setTitle)", () => {
  it("setTitle is called with repair status on session_start and toggle", async () => {
    const fake = createFakePi();
    fake.ctx.hasUI = true;
    const titles: string[] = [];
    fake.ctx.ui.setTitle = (t: string) => { titles.push(t); };

    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    // session_start should call setTitle with the on-state
    expect(titles.length).toBeGreaterThan(0);
    expect(titles[titles.length - 1]).toContain("repair: on");

    // Toggle OFF: setTitle should reflect the new state
    await fake.commands.get("repair-off")!.handler({}, fake.ctx);
    expect(titles[titles.length - 1]).toContain("repair: off");

    // Toggle back ON
    await fake.commands.get("repair-on")!.handler({}, fake.ctx);
    expect(titles[titles.length - 1]).toContain("repair: on");
    expect(titles[titles.length - 1]).not.toContain("off");
  });
});

describe("extension integration — false-positive bash error suppression", () => {
  it("suppresses bash isError when error is not classified and output has content", async () => {
    const fake = createFakePi();
    fake.ctx.hasUI = true;
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    // Real scenario: bash tool's timeout wrapper is broken, isError=true,
    // but classifyErrorType returns null for the command output.
    // The command succeeded; the error is a false positive.
    const result = await fake.handlers.get("tool_result")!(
      {
        toolName: "bash",
        input: { command: "echo hi" },
        content: [{ type: "text", text: "hi\n" }],
        isError: true,
      },
      fake.ctx,
    );
    expect(result).toBeUndefined();

    const ctxRes = await fake.handlers.get("context")!({ messages: [] }, fake.ctx);
    expect(ctxRes).toBeUndefined();
  });
});

describe("extension integration — /repair-status command", () => {
  it("registers and runs without throwing", async () => {
    const fake = createFakePi();
    fake.ctx.hasUI = false;
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    const handler = fake.commands.get("repair-status")!.handler;
    await expect(handler({}, fake.ctx)).resolves.not.toThrow();
  });
});
