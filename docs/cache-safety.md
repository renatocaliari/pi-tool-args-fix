# Cache-Safety Contract

<!-- Last validated: 2026-06-04 -->

This document is the single source of truth for the LLM prefix-cache safety
guarantees of the repair-layer extension. If you change the contract here,
update the cache-safety tests in `repairs.test.ts` accordingly.

## TL;DR

- **The extension NEVER modifies `tool_result.content`** for any normal flow.
- The ONE documented exception is the `write` directory-fallback (Phase 6),
  which returns a directory listing when the user mistakenly targets a
  directory. The cache prefix for that tool result has no prior entries, so
  cache impact is zero.
- The `context` event returns a **shallow-copied** messages array (push only).
  The original `event.messages` is byte-identical turn-over-turn → cache hit.

## The Problem We Solve

LLM providers implement prefix caching: identical conversation prefixes bypass
recomputation. On DeepSeek V4 Flash this is a **50×** cost difference
($0.0028 vs $0.14 per million tokens). Every modification to a `tool_result`
breaks the prefix from that point forward.

A naive implementation would "helpfully" append guidance to the tool result
when the tool failed. That breaks the cache for every subsequent turn.

## The Solution: Side-Channel Guidance

```
Traditional (cache-breaking):
  tool runs → error → extension APPENDS guidance to tool_result
                                → history MODIFIED → cache miss

This extension (cache-preserving):
  tool runs → error → extension returns UNDEFINED → history UNCHANGED
                                → cache hit
                                  ↓
                  context event fires → shallow copy of messages
                                  ↓
                  guidance pushed onto shallow copy → LLM sees it
                                  ↓
                  shallow copy is DISCARDED after LLM call
                  persistent history still has original tool result
```

## The Invariant (Pinned by Tests)

The `context` handler in `index.ts` does exactly three things:

```typescript
const messages = [...event.messages];  // 1. Shallow copy the array
messages.push({                         // 2. Push ONE new user message
  role: "user" as const,
  content: [{ type: "text" as const, text: pendingGuidance.join("\n\n") }],
});
pendingGuidance.length = 0;             // 3. Clear the queue
return { messages };                    // 4. Return new array
```

**Invariant**: We never mutate any element of the original `event.messages`.
We only push a new element to the shallow copy. The original array and all
its message objects stay byte-identical.

The `tool_result` handler returns `undefined` for ALL normal flows. It only
classifies errors, queues guidance, and records events to JSONL. It never
returns a `{ content: [...] }` payload.

## The One Documented Exception

`tool_result` Phase 6 (write-directory-fallback):

```typescript
if (stat.isDirectory()) {
  const { listingContent } = formatDirectoryListing(resolved, entries, "write");
  return { content: [{ type: "text" as const, text: listingContent }], isError: false };
}
```

When the user calls `write` on an existing directory (a user error), the
extension returns a directory listing instead of failing. This IS a content
mutation, but it's safe because:
1. The original `write` call would have returned an error, so there's no
   prior cache prefix to invalidate.
2. The mutation is deterministic (same directory → same listing).
3. It's a fallback, not a normal flow.

The cache-safety test in `repairs.test.ts` pins this exception explicitly so
future refactors don't accidentally generalize it.

## Why Shallow Copy, Not Deep Copy

| Approach | Cost | Safety |
|----------|------|--------|
| Shallow copy + push only (current) | O(1) | ✓ if invariant holds |
| Deep copy of all messages | O(total size) | ✓ unconditionally |
| Mutate original messages | O(1) | ✗ breaks cache |

Deep copy would be marginally more robust against future maintainers
accidentally mutating an element, but the cost grows linearly with
conversation size. For long sessions (10K+ messages), this adds up.

Shallow copy with the "push only" invariant is the right trade-off:
- O(1) cost per turn
- Cache-safe as long as the invariant holds
- The invariant is pinned by the `cache-safety` section in `repairs.test.ts`

If you change the invariant (e.g., decide to mutate messages), you MUST:
1. Update this document.
2. Update the test in `repairs.test.ts` to match.
3. Re-think the cache implications.

## One-Shot Guidance

Each guidance kind fires at most once per session per `(kind, tool, input)`:

```typescript
function queueGuidance(key: string, text: string, injectStats: boolean): boolean {
  if (injectedGuidance.has(key)) return false;  // already injected
  injectedGuidance.add(key);
  if (injectStats) stats.guidanceInjections++;
  pendingGuidance.push(text);
  return true;
}
```

This means:
- First failure of `bash` → CLI guidance queued + injected
- Second failure of `bash` → no new guidance (key already seen)
- The `context` event returns `undefined` when nothing is queued

The result: cache-stable across turns where the same error recurs. Only the
first occurrence injects bytes; subsequent occurrences are silent.

## Deterministic Guidance Strings

Same error → same guidance text → byte-identical → cache-stable.

The `getToolHelp(toolName)` function is a pure function of `toolName`. The
`getErrorGuidance(errorType, toolName)` function is a pure function of the
classification. No timestamps, no random IDs, no environment-dependent
data in the guidance strings.

This is what makes the cache work: if the LLM sees the same error twice
across sessions, the guidance is byte-identical, so the cache hits.

## What This Document Does NOT Cover

- **Pre-execution repairs** (tool_call handler) — these modify args BEFORE the
  tool runs, never touching `tool_result.content`. Always cache-safe by
  construction.
- **The `tool_result` analytics path** — records events to JSONL at
  `.pi/repair-log/<sessionId>.jsonl`. This is a side effect on disk, not on
  the LLM's view of the conversation. Not a cache concern.
- **The pre-commit hook** — runs vitest on staged changes. Runs in the
  developer's shell, not in the LLM context. Not a cache concern.

## References

- `index.ts` lines 770-790 — the `context` handler (the contract in code)
- `repairs.test.ts` "cache-safety" section — the tests that pin the contract
- `README.md` "Cache Strategy" — user-facing explanation
- `/Users/cali/.local/share/opencode/storage/message/...` — DeepSeek V4
  Flash 50× cache cost example
- Anthropic Claude prompt caching docs — cache hit pricing (10% of base)
