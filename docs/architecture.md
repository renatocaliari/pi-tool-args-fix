# Architecture

<!-- Last validated: 2026-06-04 -->

Deep architecture documentation for the repair-layer extension. The high-level
summary lives in `AGENTS.md`; this file is the "why" and "how" reference.

## Three-Layer Design

```
┌─────────────────────────────────────────────────────────┐
│  tool_call handler    (pre-execution repair + validate)  │
│                                                         │
│  • Step 1-2: Field repairs (null strip, array wrap,     │
│    boolean coercion, etc.) — sub-ms per field           │
│  • Step 3a: Auto-timeout injection (bash)               │
│  • Step 3b: Path validation — ENOENT pre-flight         │
│  • Step 3b-ii: EISDIR pre-flight (before read hits dir) │
│  • Step 3c: Content hash staleness check (edit tool)    │
│  • Step 3d: Sequential edit overlap detection           │
│  • Queues guidance via pendingGuidance[]                 │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  tool_result handler  (analytics + guidance queue only)  │
│                                                         │
│  Returns undefined for normal flows.                    │
│  Returns { content: [...] } ONLY for the documented     │
│  write-directory-fallback (Phase 6).                    │
│  • Phase 1-2: Error classification + empty detection    │
│  • Phase 3: Consecutive failure tracking + CLI queue    │
│  • Phase 4: Error-type guidance (once per category)     │
│  • Phase 5: Content hash tracking (read/read_file)      │
│  • Phase 6: Write directory fallback (THE EXCEPTION)    │
│  • Phase 7: Event recording to JSONL                    │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  context event handler  (side-channel guidance)          │
│                                                         │
│  • Fires before every LLM call                          │
│  • event.messages is shallow-copied (push only) —       │
│    original elements are never mutated, so the          │
│    persistent conversation history stays byte-identical │
│  • Injects queued guidance from pendingGuidance[]        │
│  • LLM sees guidance — cache is never modified           │
└─────────────────────────────────────────────────────────┘
```

## Module Map

| Module | Lines | Purpose |
|--------|-------|---------|
| `index.ts` | ~801 | 3-layer handler entry: `tool_call` + `tool_result` + `context` |
| `repairs.ts` | ~87 | Thin barrel — re-exports from `repairs/*.ts` sub-modules |
| `repairs/*.ts` | 9 files | Pure repair functions organized by concern |
| `repairs/dispatch.ts` | ~370 | `repairFieldValue` + `repairDispatchers` lookup table |
| `repairs/classification.ts` | ~110 | `classifyField` + 3 extracted predicates |
| `repairs/guidance.ts` | ~400 | Context-aware help text builders |
| `repairs/cache.ts` | ~100 | ContentHashCache for staleness detection |
| `repairs/coercion.ts` | ~100 | Boolean/number/string coercion |
| `repairs/array-utils.ts` | ~140 | Array wrapping, splitting, JSON parsing |
| `repairs/path-utils.ts` | ~100 | Path cleaning, resolution, extraction |
| `repairs/directory.ts` | ~70 | EISDIR fallback + directory listing |
| `repairs/timeout.ts` | ~50 | Auto-timeout detection |
| `repairs/constants.ts` | ~140 | 8 constant sets (PATH_FIELD_NAMES, etc.) |
| `recorder.ts` | ~373 | JSONL persistence, aggregation, blindspot analysis |
| `recorder/classifier.ts` | ~115 | Error classification + `getToolHelp` |
| `recorder/formatting.ts` | ~174 | Formatting helpers |
| `recorder/tracker.ts` | ~70 | Consecutive failure loop detection |
| `recorder/empty-search-tracker.ts` | ~160 | Empty search loop detection |
| `stats.ts` | ~173 | In-memory session stats + `RepairToggle` |
| `suggest-repairs.ts` | ~95 | LLM repair suggestion engine |
| `suggest-repairs/*.ts` | 7 files | Types, LLM client, analysis, parsing, code-gen, issue |
| `handlers/commands.ts` | ~329 | All `/repair-*` command registrations |
| `handlers/utils.ts` | ~94 | Shared UI helpers + `summarizeRepairs` |

## The 9 Field-Level Repairs (Execution Order)

1. **`clean-path`** — strip markdown link wrappers from path fields
   (`[notes.md](http://notes.md)` → `notes.md`)
2. **`parse-json`** — parse stringified JSON arrays/objects
   (`'["a","b"]'` → `["a","b"]`)
3. **`wrap-object-as-array`** — wrap a single object in an array
   (`{oldText, newText}` → `[{oldText, newText}]`)
4. **`wrap-array`** — wrap a bare string/number in an array
   (`"main"` → `["main"]`)
5. **`split-string-to-array`** — split delimited strings
   (`"admin, user"` → `["admin", "user"]`)
6. **`strip-extra-properties`** — remove schema-violating fields from array
   items (`{oldText, newText, path}` → `{oldText, newText}`)
7. **`null-like-to-undefined`** — strip null-like string values
   (`"null"` → undefined; field is dropped)
8. **`coerce-boolean`** — convert string booleans
   (`"true"` → `true`, `"false"` → `false`)
9. **`coerce-number`** — convert string numbers
   (`"42"` → `42`)

After any structural change, nested objects/arrays are recursively
validated and repaired.

## The 3 Classification Predicates

Extracted from inline switch/OR-chains to make `classifyField` readable:

| Predicate | Matches |
|-----------|---------|
| `isArrayLike(key, lower)` | Field name contains `ARRAY_NAMES` OR ends in `_list`/`list`/`_names`/`names`/`_items`/`items`/`_array`/`array` |
| `isBooleanField(key, lower)` | Field name contains `BOOLEAN_NAMES` OR starts with `is_`/`has_`/`can_` OR ends in `_flag` |
| `looksLikeNumberField(key, lower)` | Field name contains `NUMBER_NAMES` OR matches `max`/`min`/`_count`/`_size`/`_index` |

These are intentional structural choices — the `repairs.test.ts`
"structural integrity" tests verify they survive refactoring. **Do not
inline them back into `classifyField`.**

## The 8-Entry Dispatch Table

```typescript
const repairDispatchers = {
  "clean-path": dispatchCleanPath,
  "parse-json": dispatchParseJson,
  "wrap-object-as-array": dispatchWrapObjectAsArray,
  "wrap-array": dispatchWrapArray,
  "split-string-to-array": dispatchSplitStringToArray,
  "coerce-boolean": dispatchCoerceBoolean,
  "coerce-number": dispatchCoerceNumber,
  "strip-extra-properties": dispatchStripExtraProperties,
} as const;
```

`repairFieldValue` looks up the action in this table and applies the
dispatcher. **Do not replace the lookup with a `switch`** — the dispatch
table is what makes new repairs easy to add (just add an entry).

## Tool-Call Handler: Step Layout

| Step | What | Why |
|------|------|-----|
| Step 1-2 | Field repairs via `repairObjectFields` | Structural fixes before tool runs |
| Step 3a | Auto-timeout injection (bash) | Detected long-running commands get `timeout_seconds` |
| Step 3b | Path validation | ENOENT pre-flight: fail fast on missing files |
| Step 3b-ii | EISDIR pre-flight | Catch "read a directory" before read tool returns EISDIR |
| Step 3c | Content hash staleness | Detect file changes since last read |
| Step 3d | Sequential edit overlap | Detect edits that would overlap with prior edits |
| Final | Queue guidance via `pendingGuidance` | Returns fixed args or `BLOCK_MESSAGE` |

## Tool-Result Handler: Phase Layout

| Phase | What | Why |
|-------|------|-----|
| Phase 1 | Error classification | Pure pattern matching on error text |
| Phase 2 | Empty result detection | `EMPTY_RESULT` for blindspot analysis |
| Phase 2.5 | Empty search loop detection | 3+ empty find/grep/ls → inject guidance |
| Phase 3 | Consecutive failure tracking | Circuit breaker at 7+ failures |
| Phase 4 | Error-type guidance | First occurrence of each error type |
| Phase 5 | Content hash tracking | Update `ContentHashCache` for next edit |
| Phase 6 | **Write directory fallback** | **The one content-mutation exception** |
| Phase 7 | Event recording | JSONL at `.pi/repair-log/` |

## Why 3 Layers, Not 1 or 2

A single combined handler would either:
- Miss the window for pre-execution repair (if it runs after the tool)
- Miss the analytics (if it runs only before)

A 2-layer design (pre + post, no context) would either:
- Break cache (if guidance is appended to tool_result)
- Miss the model entirely (if guidance is logged to disk only)

3 layers is the minimum that supports all three concerns:
- Pre-execution repair (zero cache impact)
- Analytics + guidance queue (zero cache impact, persists across runs)
- Side-channel injection (cache-safe, one-shot)

## Event Flow Example: Failed Bash

```
User: "list files in /nonexistent"
   ↓
tool_call handler:
  - args valid, no repair needed
  - returns undefined (proceed with tool)
   ↓
Bash runs: `ls /nonexistent` → "No such file or directory"
   ↓
tool_result handler:
  - hasError = true
  - executionErrorType = "ENOENT"
  - consecutiveCount = 1
  - queues CLI guidance: getToolHelp("bash") [one-shot]
  - queues error-type guidance: getErrorGuidance("ENOENT", "bash")
  - records event to JSONL
  - returns undefined (cache-safe)
   ↓
Next LLM call → context event fires:
  - pendingGuidance has 2 entries
  - shallow-copies event.messages
  - pushes 1 user message with both guidance strings joined
  - returns { messages: newArrayRef }
  - clears pendingGuidance
   ↓
LLM sees original messages + 1 new guidance message
Persistent history is unchanged (cache-stable)
Next time the same error recurs:
  - guidance is NOT re-queued (one-shot via injectedGuidance Set)
  - context returns undefined (no array copy needed)
```

## File System Side Effects

| Operation | Where | When | Reversible? |
|-----------|-------|------|-------------|
| JSONL append | `.pi/repair-log/<sessionId>.jsonl` | Every `tool_result` | Yes (delete file) |
| Pre-commit hook run | Shell | `git commit` | Yes (--no-verify bypass) |
| Directory listing read | `/path/to/dir` | Phase 6 of `tool_result` | Yes (read-only) |
| `read` content hash | In-memory `ContentHashCache` | After every successful read | Lost on session end |

None of these side effects touch the LLM's view of the conversation.

## References

- `docs/repair-catalog.md` — source of truth for repair function signatures
- `docs/cache-safety.md` — cache-safety contract (the "why" of the 3-layer design)
- `AGENTS.md` — high-level overview (what the agent reads every session)
- `repairs.test.ts` "structural integrity" section — pins the dispatch table + predicates
- `extension-integration.test.ts` — pins the wiring + lifecycle
- `repairs/catalog-drift.test.ts` — pins catalog ⇄ source consistency
- `repairs/test-coverage.test.ts` — pins per-function test coverage
