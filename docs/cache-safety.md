# Cache-Safety Contract

<!-- Last validated: 2026-06-04 -->

This document is the single source of truth for the LLM prefix-cache safety
guarantees of the repair-layer extension. If you change the contract here,
update the cache-safety tests in `repairs.test.ts` and the integration tests
in `extension-integration.test.ts` accordingly.

## TL;DR

- Pre-execution repairs (tool_call handler) have **zero cache impact** —
  they modify args BEFORE the tool runs.
- Post-execution modifications to `tool_result.content` are **allowed**
  if they follow all 4 rules of the cache-safety pattern.
- The `context` event returns a **shallow-copied** messages array
  (push only). Original `event.messages` stays byte-identical turn-over-turn.
- Cache hit rate is **tracked** in stats and exposed via `/repair-cache-info`
  (provider-reported via `usage.cacheRead` / `usage.cacheWrite`).

## The 4-Rule Cache-Safety Pattern

Any modification to `tool_result.content` (or any other LLM-visible byte
sequence) must follow ALL FOUR rules to be cache-safe:

| # | Rule | What it means |
|---|------|---------------|
| 1 | **Static cutoff** | Only modify content older than a threshold. Recent content stays byte-identical. |
| 2 | **One-shot** | Same `(kind, key)` produces the same modification every turn. After the first occurrence, no further modifications. |
| 3 | **Byte-deterministic** | Pure function of inputs. No timestamps, random IDs, env vars, or non-deterministic data. |
| 4 | **Stable position** | Modifications happen at the same position in the byte sequence turn-over-turn. |

If all 4 hold, the modified content is **cache-stable** — the LLM provider's
prefix cache hits on every subsequent turn with the same input.

If ANY rule is violated, the modification is **cache-breaking** — every
subsequent turn with the same input will miss the cache.

## What This Extension Does (and Why It's Cache-Safe)

### Phase 1-5: Analytics + Guidance Queue (side-channel, cache-safe)

Phases 1-5 of the `tool_result` handler:
- Classify errors
- Track consecutive failures
- Detect empty results
- Update content hash cache
- Queue guidance via `pendingGuidance[]`

**All return undefined** for normal flows. The LLM never sees modified
`tool_result.content` from these phases. The only thing that flows to the
LLM is the side-channel `pendingGuidance` array, which is pushed as a
new user message in the `context` event (NOT appended to tool_result).

### Phase 6: Write-Directory Fallback (one-shot, cache-safe)

When `write` is called on a directory, the handler returns a directory
listing instead of the original error. See `repairs/directory.ts`.

**Conformance to the 4 rules**:
- **Static cutoff**: N/A (only fires on first encounter of the error condition)
- **One-shot**: same directory always produces same listing
- **Byte-deterministic**: directory contents are stable
- **Stable position**: listing format is fixed

Cache impact: **zero** — the original tool call would have returned an
error (no prior cache prefix), so the rewrite doesn't invalidate anything.

### Context Event: Side-Channel Guidance (always cache-safe)

The `context` event handler:

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

Plus: **cache analytics accumulation**. The handler always iterates
`event.messages` to extract `usage.cacheRead` / `usage.cacheWrite` from
assistant messages, regardless of whether guidance is being pushed. This
gives the user visibility into their actual cache hit rate.

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
- The invariant is pinned by tests in `repairs.test.ts` and
  `extension-integration.test.ts`

If you change the invariant (e.g., decide to mutate messages), you MUST:
1. Update this document.
2. Update the test in `repairs.test.ts` to match.
3. Update the integration tests in `extension-integration.test.ts`.
4. Re-think the cache implications.

## Coexistence With Other Extensions

Multiple pi extensions in the wild modify `tool_result.content`. The
order of `pi.on("tool_result", ...)` hooks matters:

```
[other extension 1] → [us] → [other extension 2] → [LLM sees final]
```

If we run first: we clean our noise, then others see cleaner content.
If we run second: we see what others produced, then clean OUR noise on top.

**All are safe IF all follow the 4 rules.** Static cutoff + one-shot +
byte-deterministic + stable position compose: the combined output is
still cache-stable.

Known coexisting extensions:
- **`condensed-milk`** — retroactively masks old tool results (static cutoff)
- **`pi-tscg`** — tool-result compression (deterministic per-tool strategy)
- **`pi-rtk`** — strips noise from 22 filter modules (per-tool, deterministic)
- **`filter-output`** (michalvavra/agents) — redacts API keys (deterministic regex)

All four follow the 4-rule pattern. They can run alongside us.

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

## Cache Hit Rate Tracking

The `context` handler accumulates cache stats from assistant message
`usage` fields:

```typescript
for (const m of event.messages) {
  const msg = (m as any)?.message ?? m;
  if (msg?.role === "assistant" && msg?.usage) {
    const u = msg.usage;
    stats.totalCacheRead += u.cacheRead ?? 0;
    stats.totalCacheWrite += u.cacheWrite ?? 0;
    stats.totalUncachedInput += u.input ?? 0;
  }
}
```

Exposed via `/repair-cache-info`:
- Hit rate = `totalCacheRead / (totalCacheRead + totalCacheWrite + totalUncachedInput)`
- Cost estimate: based on Anthropic pricing (cache reads at 10%, writes at 125%, uncached at 100% of base)

Per Claude's docs: "We run alerts on our prompt cache hit rate and declare
SEVs if they're too low." Same metric, exposed via the same command.

## What This Document Does NOT Cover

- **Pre-execution repairs** (tool_call handler) — modify args BEFORE the
  tool runs, never touching `tool_result.content`. Always cache-safe by
  construction.
- **The `tool_result` analytics path** — records events to JSONL at
  `.pi/repair-log/<sessionId>.jsonl`. This is a side effect on disk, not on
  the LLM's view of the conversation. Not a cache concern.
- **The pre-commit hook** — runs vitest on staged changes. Runs in the
  developer's shell, not in the LLM context. Not a cache concern.
- **pi tool driver UI logs** — diagnostic messages that may appear in
  pi's chat UI are emitted by the driver, NOT in `tool_result.content`.
  Our hook doesn't see them. They are a display-layer artifact, not an
  LLM-cache concern.

## References

- `index.ts` lines 770-810 — the `context` handler (the contract in code)
- `index.ts` lines 770-810 — the `context` handler (the contract in code)
- `repairs.test.ts` "cache-safety" section — the tests that pin the contract
- `extension-integration.test.ts` — end-to-end lifecycle
- `README.md` "Cache Strategy" — user-facing explanation
- `stats.ts` `formatCacheInfo` — cache hit rate display
- [Claude prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Lessons from building Claude Code: Prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)
- [Anthropic cache diagnostics](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics)
- [Pi extension API](https://pi.dev/docs/latest/extensions)
- [pi-tscg](https://pi.dev/packages/pi-tscg) — coexisting tool-result compression
- [pi-rtk](https://github.com/codexstar69/pi-rtk) — coexisting tool output transformer
- [condensed-milk](https://github.com/tomooshi/condensed-milk-pi) — coexisting retro-masker
