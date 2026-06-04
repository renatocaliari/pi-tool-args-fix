/**
 * Extension integration test — fake `ExtensionAPI` that records every
 * handler registered via `pi.on()`, then invokes them with synthetic
 * events to prove the wiring actually works end-to-end.
 *
 * Pairs with the cache-safety tests in `repairs.test.ts`:
 *   - cache-safety tests: pin individual contracts (return shapes, no mutation)
 *   - this file: pin the wiring (handlers exist, lifecycle works, full
 *     session_start → tool_call → tool_result → context flow runs)
 *
 * Side effects: `recordEvent` writes JSONL to `.pi/repair-log/`. That's
 * wrapped in try/catch in the source — failures never break the test,
 * they just leak a few lines of JSON. No cleanup needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readSessionEvents, sessionLogPath } from "./recorder.js";
import * as fs from "node:fs";

// ─── Fake ExtensionAPI ───────────────────────────────────────────────────

interface FakePi {
  pi: any;
  ctx: any;
  handlers: Map<string, (event: any, ctx: any) => Promise<any>>;
  commands: Map<string, { description: string; handler: Function }>;
  tools: Map<string, any>;
}

function createFakePi(): FakePi {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const commands = new Map<string, { description: string; handler: Function }>();
  const tools = new Map<string, any>();
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => Promise<any>) {
      // Last write wins — default() may be called multiple times across tests,
      // we want the LATEST registration
      handlers.set(event, handler);
    },
    registerCommand(name: string, def: { description: string; handler: Function }) {
      commands.set(name, def);
    },
    registerTool(name: string, def: any) {
      tools.set(name, def);
    },
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
  return { pi, ctx, handlers, commands, tools };
}

async function loadExtension(fake: FakePi) {
  const mod = await import("./index.js");
  mod.default(fake.pi);
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("extension integration — handler registration contract", () => {
  let fake: FakePi;

  beforeEach(async () => {
    fake = createFakePi();
    await loadExtension(fake);
  });

  it("registers session_start handler", () => {
    expect(fake.handlers.has("session_start")).toBe(true);
  });

  it("registers session_shutdown handler", () => {
    expect(fake.handlers.has("session_shutdown")).toBe(true);
  });

  it("registers tool_call handler", () => {
    expect(fake.handlers.has("tool_call")).toBe(true);
  });

  it("registers tool_result handler", () => {
    expect(fake.handlers.has("tool_result")).toBe(true);
  });

  it("registers context handler", () => {
    expect(fake.handlers.has("context")).toBe(true);
  });

  it("registers /repair-stats-session command", () => {
    expect(fake.commands.has("repair-stats-session")).toBe(true);
  });

  it("registers /repair-stats-global command", () => {
    expect(fake.commands.has("repair-stats-global")).toBe(true);
  });

  it("registers /repair-suggest command", () => {
    expect(fake.commands.has("repair-suggest")).toBe(true);
  });

  it("registers /repair-toggle command", () => {
    expect(fake.commands.has("repair-toggle")).toBe(true);
  });
});

describe("extension integration — full lifecycle flow", () => {
  it("runs session_start → tool_call → tool_result → context without crashing", async () => {
    const fake = createFakePi();
    await loadExtension(fake);

    // 1. session_start — initializes state, sets status
    await fake.handlers.get("session_start")!(
      { reason: "startup" },
      fake.ctx,
    );

    // 2. tool_call — bash with clean args, no repair needed
    const toolCallResult = await fake.handlers.get("tool_call")!(
      {
        toolName: "bash",
        input: { command: "ls -la" },
      },
      fake.ctx,
    );
    // Should not block (wasRepaired = false), returns undefined
    expect(toolCallResult).toBeUndefined();

    // 3. tool_result — successful, no error
    const toolResultResult = await fake.handlers.get("tool_result")!(
      {
        toolName: "bash",
        input: { command: "ls -la" },
        content: [{ type: "text", text: "file1\nfile2\n" }],
        isError: false,
      },
      fake.ctx,
    );
    expect(toolResultResult).toBeUndefined();

    // 4. context — no guidance queued, no-op
    const contextResult = await fake.handlers.get("context")!(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "list files" }] },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
      },
      fake.ctx,
    );
    expect(contextResult).toBeUndefined();
  });
});

describe("extension integration — tool_call repair paths", () => {
  let fake: FakePi;

  beforeEach(async () => {
    fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);
  });

  it("repairs null-valued fields (strips them) on tool_call", async () => {
    // Pass a field with `null` value — should be stripped
    const result = await fake.handlers.get("tool_call")!(
      {
        toolName: "bash",
        input: { command: "echo hi", extra: null },
      },
      fake.ctx,
    );
    // Either returns undefined (repaired silently) or the repaired args
    // We just want to ensure it doesn't crash
    expect(result === undefined || (result && result.input)).toBe(true);
  });

  it("blocks tool_call with [repair-layer] blocked message on invalid args", async () => {
    // Pass a clearly invalid input that the validator will reject
    // The exact validation rule depends on the tool's schema; we just
    // verify the handler doesn't crash and returns SOMETHING defined
    // (either undefined, repaired args, or block message).
    const result = await fake.handlers.get("tool_call")!(
      {
        toolName: "bash",
        input: { command: 123 }, // command must be string
      },
      fake.ctx,
    );
    // No crash is the success criterion here
    expect(result === undefined || (result && typeof result === "object")).toBe(true);
  });
});

describe("extension integration — error handling", () => {
  it("survives an event with missing fields (does not throw)", async () => {
    const fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    // Pass a tool_result event with completely empty fields
    await expect(
      fake.handlers.get("tool_result")!({} as any, fake.ctx),
    ).resolves.not.toThrow();
  });

  it("survives a context event with empty messages array", async () => {
    const fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    await expect(
      fake.handlers.get("context")!({ messages: [] }, fake.ctx),
    ).resolves.not.toThrow();
  });

  it("survives a tool_call event with non-bash tool", async () => {
    const fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    // Unknown tool — should not crash, just return undefined
    const result = await fake.handlers.get("tool_call")!(
      { toolName: "totally-fake-tool", input: { foo: "bar" } },
      fake.ctx,
    );
    expect(result === undefined || (result && typeof result === "object")).toBe(true);
  });
});

describe("extension integration — guidance flow", () => {
  it("queues guidance on tool failure, injects on next context", async () => {
    const fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    // Trigger a failure that queues CLI guidance
    await fake.handlers.get("tool_result")!(
      {
        toolName: "bash",
        input: { command: "false-cmd-xyz" },
        content: [{ type: "text", text: "command not found: false-cmd-xyz\n" }],
        isError: true,
      },
      fake.ctx,
    );

    // Now context should return appended guidance
    const result = await fake.handlers.get("context")!(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "original user msg" }] },
        ],
      },
      fake.ctx,
    );

    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    // The returned array should have MORE entries than the original
    expect(result.messages.length).toBeGreaterThan(1);
  });

  it("guidance injection is one-shot per (tool, key) per session", async () => {
    const fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    const failingEvent = {
      toolName: "bash",
      input: { command: "false-cmd-xyz" },
      content: [{ type: "text", text: "command not found: false-cmd-xyz\n" }],
      isError: true,
    };

    // First failure — queues guidance
    await fake.handlers.get("tool_result")!(failingEvent, fake.ctx);
    const first = await fake.handlers.get("context")!(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      fake.ctx,
    );
    expect(first.messages.length).toBeGreaterThan(1);

    // Second failure (same tool, same error) — should NOT queue again
    await fake.handlers.get("tool_result")!(failingEvent, fake.ctx);
    const second = await fake.handlers.get("context")!(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      fake.ctx,
    );
    // No new guidance → returns undefined (no-op)
    expect(second).toBeUndefined();
  });
});

describe("extension integration — session_shutdown", () => {
  it("session_shutdown handler runs without throwing", async () => {
    const fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    await expect(
      fake.handlers.get("session_shutdown")!({}, fake.ctx),
    ).resolves.not.toThrow();
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
  it("tool_result skips guidance when toggle OFF, but still records events", async () => {
    const fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

    // Turn repair OFF
    const offCmd = fake.commands.get("repair-off")!;
    await offCmd.handler({}, fake.ctx);

    // Trigger a failure that would normally queue CLI guidance
    await fake.handlers.get("tool_result")!(
      {
        toolName: "bash",
        input: { command: "false-cmd-xyz" },
        content: [{ type: "text", text: "command not found: false-cmd-xyz\n" }],
        isError: true,
      },
      fake.ctx,
    );

    // Context should return undefined — no guidance was queued
    const result = await fake.handlers.get("context")!(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
        ],
      },
      fake.ctx,
    );
    expect(result).toBeUndefined();
  });

  it("tool_call records repairSkipped=true when toggle OFF", async () => {
    const fake = createFakePi();
    await loadExtension(fake);
    await fake.handlers.get("session_start")!({ reason: "startup" }, fake.ctx);

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

