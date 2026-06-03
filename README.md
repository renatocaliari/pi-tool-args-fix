<div align="center">

# 🔧 pi-tool-repair-layer

<br>

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/Tests-479_passing-2ea043?style=for-the-badge)

**Fix LLM tool-calling bugs transparently — no model changes, no retraining, no cache penalty.**

<br>

[💡 Concept](#-concept) · [✨ Features](#-features) · [🚀 Quick Start](#-quick-start) · [🔍 Architecture](#-architecture) · [🧠 Cache Strategy](#-cache-strategy) · [📊 Observability](#-observability) · [🔁 Auto-Evolution](#-auto-evolution) · [⚙️ Reference](#️-reference) · [🤝 Contributing](#-contributing)

<br>

</div>

---

> *"The core insight: 'open model bad at tool calling' is almost always a harness problem. A finite set of compositional failures repeats across models."*  
> — [Ahmad Awais](https://x.com/mrahmadawais/status/2050956678502420612)

This extension is the harness fix. The patterns were observed and fixed from production [DeepSeek V4 and Mimo 2.5](https://x.com/mrahmadawais/status/2050956678502420612) agent logs, but the repairs are field-name based — any model that emits the same structural mistakes gets the same transparent fix.

---

## 💡 Concept

Production LLMs (DeepSeek V4, Mimo 2.5, and others) share a surprising pattern: most of their tool-calling failures come from a small, recurring set of structural mistakes — around a dozen patterns we've observed and fixed.

| # | What the model emits | What the tool needs | Repair |
|---|---------------------|---------------------|--------|
| # | What the model emits | What the tool needs | Repair |
|---|---------------------|---------------------|--------|
| 1 | `{limit: null}` | omit the field entirely | Strip `null` from optional fields |
| 2 | `paths: "[\"a.ts\",\"b.ts\"]"` | `paths: ["a.ts", "b.ts"]` | Parse stringified JSON arrays/objects |
| 3 | `edits: {oldText, newText}` | `edits: [{oldText, newText}]` | Wrap bare object → single-element array |
| 4 | `function_names: "main"` | `function_names: ["main"]` | Wrap bare string/number → array |
| 5 | `path: "[notes.md](http://notes.md)"` | `path: "notes.md"` | Unwrap markdown links from paths |
| 6 | `{limit: 30}` | `{offset: 1, limit: 30}` | Relational defaults for tools with `limit`/`offset` (e.g. `read`, `read_file`) |
| 7 | `tags: "admin, user"` | `tags: ["admin", "user"]` | Split delimited strings → array |
| 8 | `name: "null"` | omit the field entirely | Strip null-like strings |
| 9 | `strict: "true"` | `strict: true` | Coerce boolean strings |
| 10 | `limit: "42"` | `limit: 42` | Coerce number strings |
| 11 | `edits: [{oldText, newText, path}]` | `edits: [{oldText, newText}]` | Strip extra properties from array items |

### Why not just use better models?

Because this is a **harness problem**, not a model problem. Even frontier models make these mistakes. Fixing it at the harness level means:
- ✅ **Any model that makes the same mistakes benefits**
- ✅ **Zero changes to model weights** or training pipelines
- ✅ **Works offline**, no cloud dependency
- ✅ **Transparent** — model doesn't know it was helped
- ✅ **Fast repairs** — sub-millisecond per field (pure string operations)

<div align="center">
<br>
<img src="https://img.shields.io/badge/Validated_with-DeepSeek_V4_Flash_Pro_Mimo_2.5-555?style=flat-square" alt="Models">
<img src="https://img.shields.io/badge/Repair_latency-%3C1ms_per_field-brightgreen?style=flat-square" alt="Latency">
<img src="https://img.shields.io/badge/Content_fields-NEVER_touched-red?style=flat-square" alt="Safety">
<br><br>
</div>

---

## ✨ Features

<details>
<summary><strong>🔧 9 field-level repairs</strong> — structural fixes before the tool runs (dispatch pipeline in <code>repairFieldValue</code>)</summary>

<br>

All 9 are pure structural fixes: type coercion, array wrapping, string parsing. **Content fields** (`command`, `code`, `oldText`, `newText`, `text`) are **never** touched.

| # | Action | What the model emits | What the tool needs |
|---|--------|---------------------|---------------------|
| 1 | `clean-path` | `path: "[notes.md](http://notes.md)"` | `path: "notes.md"` |
| 2 | `parse-json` | `paths: "[\"a.ts\",\"b.ts\"]"` | `paths: ["a.ts", "b.ts"]` |
| 3 | `wrap-object-as-array` | `edits: {oldText, newText}` | `edits: [{oldText, newText}]` |
| 4 | `wrap-array` | `function_names: "main"` | `function_names: ["main"]` |
| 5 | `split-string-to-array` | `tags: "admin, user"` | `tags: ["admin", "user"]` |
| 6 | `strip-extra-properties` | `edits: [{oldText, newText, path}]` | `edits: [{oldText, newText}]` |
| 7 | `null-like-to-undefined` | `name: "null"` | omit the field entirely |
| 8 | `coerce-boolean` | `strict: "true"` | `strict: true` |
| 9 | `coerce-number` | `limit: "42"` | `limit: 42` |

</details>

<details>
<summary><strong>⚙️ Execution-aware features</strong> — defaults, fallbacks, and safety checks at runtime</summary>

<br>

These aren't field repairs — they're runtime adjustments that make the agent more resilient.

| Feature | When | What happens |
|---------|------|--------------|
| **Directory fallback** | `read`/`read_file` on a directory → EISDIR | Returns `📁 Directory: listing` with contents instead of failing |
| **Write directory fallback** | `write` target path is an existing directory | Lists directory contents and returns as non-error |
| **Relational defaults** | Tool has `limit` but no `offset` | Injects `offset: 1` so LLMs don't re-read the first page |
| **Content hash staleness** | After every successful `read`/`read_file` | Caches a content hash so stale-edit guidance can detect drift |
| **Empty result detection** | Tool succeeded but returned nothing | Logs `EMPTY_RESULT` for blindspot analysis (analytics only) |

</details>

<details>
<summary><strong>🛡️ Error recovery guidance (side-channel)</strong> — classification + context-aware help, zero cache impact</summary>

<br>

All guidance is injected via the `context` event (deep copy of messages). The original `tool_result` content is never modified — the LLM sees the guidance, but the conversation prefix is preserved for cache hits.

| Guidance | Trigger | Delivery |
|----------|---------|----------|
| **Pre-execution validation** | Invalid path, stale file, sequential overlap | Returns fixed `"[repair-layer] blocked"` + guidance via context event |
| **CLI semantics** | 2nd+ consecutive `bash`/`grep`/`find`/`ls` failure | Context event with tool-specific tips |
| **Edit mismatch** | `EDIT_MISMATCH` on 2nd+ consecutive `edit` failure | Reads the target file and shows current content around the failed `oldText` |
| **Edit non-unique** | `oldText` matches multiple locations | Reports match count and line numbers so the model can narrow |
| **Edit wrong file** | Error path differs from input path | Surfaces the mismatch with both paths |
| **Schema validation** | First `SCHEMA_VALIDATION` error per tool | Explains validation rules (types, enums, maxLength) |
| **Circuit breaker** | 7+ consecutive same-tool failures | `🛑 Circuit breaker` via context event instead of looping |
| **Auto-timeout** | Detected long-running command (install/build/test) | Injects `timeout_seconds` pre-execution |
| **Staleness** | File changed since last read | Blocked pre-execution with context guidance |

</details>

<details>
<summary><strong>📊 Observability</strong> — every event logged, analyzable across sessions</summary>

<br>

- **Per-session JSONL logs** at `.pi/repair-log/<sessionId>.jsonl`
- **7 commands** for live analysis: `/repair-on`, `/repair-off`, `/repair-toggle`, `/repair-stats-session`, `/repair-stats-global`, `/repair-gaps`, `/repair-suggest`
- **28-field event schema** with error classification, blindspot detection, repair tracking
- **50-session retention** with auto-prune
- **DuckDB queryable** — standard JSONL format
- **Auto-evolution** — every session starts with a global overview; cross-command hints guide you from local stats → global stats → suggesting fixes upstream

</details>

<details>
<summary><strong>🧠 Blindspot detection</strong> — knows what it doesn't fix</summary>

<br>

Every error pattern without a repair is classified and surfaced. The `/repair-gaps` command shows:

| Category | Meaning | Replacements from data |
|----------|---------|----------------------|
| `ENOENT` | File not found | Fuzzy path matching |
| `EACCES` | Permission denied | Directory permissions |
| `timeout` | Tool timed out | Auto-timeout extension |
| `EDIT_MISMATCH` | Edit text not found (3 sub-types) | Read-file context, non-unique oldText, wrong-file detection |
| `SCHEMA_VALIDATION` | Schema violation | Field-level truncation |
| `CONSECUTIVE_LOOP` | 3+ same-tool failures | Circuit break, guidance |
| `EMPTY_RESULT` | Tool succeeded, no output | Analytics only |

</details>

---

## 🚀 Quick Start

```bash
# Install
pi install git:github.com/renatocaliari/pi-tool-repair-layer

# That's it — every tool call is intercepted and repaired automatically.
# Monitor what's happening with built-in commands:
/repair-on              # Enable repair layer (default)
/repair-off             # Disable repair layer
/repair-toggle          # Toggle on/off
/repair-stats-session   # Repairs in this session
/repair-stats-global    # Repairs across all sessions
/repair-cache-info      # Cache impact metrics
/repair-gaps            # Error patterns not yet covered
/repair-suggest         # LLM suggestions for new repairs
```

**No configuration. No model changes. Zero dependencies pulled in.**

---

## 🔍 Architecture

### Three-Layer Design

The extension uses three pi event handlers in sequence, each with a distinct responsibility:

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
│  NEVER modifies event.content — returns undefined        │
│  • Phase 1-2: Error classification + empty detection    │
│  • Phase 3: Consecutive failure tracking + CLI queue    │
│  • Phase 4: Error-type guidance (once per category)     │
│  • Phase 5: Content hash tracking (read/read_file)      │
│  • Phase 6: Write directory fallback                    │
│  • Phase 7: Event recording to JSONL                    │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  context event handler  (side-channel guidance)          │
│                                                         │
│  • Fires before every LLM call                          │
│  • event.messages is a DEEP COPY — mutations don't      │
│    affect the persistent conversation history           │
│  • Injects queued guidance from pendingGuidance[]        │
│    into the deep copy                                    │
│  • LLM sees guidance — cache is never modified           │
└─────────────────────────────────────────────────────────┘
```

### Validate-then-Repair Philosophy

Every repair follows the same contract: **parse first, validate, repair only what would fail**.

```typescript
// Valid input → passes through unchanged
repairFieldValue(["a.ts", "b.ts"], "paths", "read")
// → ["a.ts", "b.ts"]  (no change)

// Invalid input → repaired
repairFieldValue("\"main\"", "function_names", "edit")
// → ["main"]
```

Content fields (`command`, `code`, `oldText`, `newText`, `text`, `content`) are **never** touched. Only structural and container fields are repaired.

### Repair Order

1. `clean-path` → 2. `parse-json` → 3. `wrap-object-as-array` → 4. `wrap-array` → 5. `split-string-to-array` → 6. `strip-extra-properties` → 7. `null-like-to-undefined` → 8. `coerce-boolean` → 9. `coerce-number` → 10. Recurse

After any structural change, nested objects/arrays are recursively validated.

---

## 🧠 Cache Strategy

### The Problem

LLM providers implement **prefix caching**: identical conversation prefixes bypass recomputation. Cache hit vs miss on DeepSeek V4 Flash costs $0.0028 vs $0.14 per million tokens — a **50× difference**. Anthropic Claude cache reads cost 10% of base input (opt-in via `cache_control`). OpenAI offers automatic caching with up to 90% discount.

Every modification to a `tool_result` changes the byte sequence of the conversation from that point forward, preventing the full prefix from matching cached units. Even partial cache hits are compromised — the unchanged prefix (system prompt, tool definitions, earlier turns) can still be cached independently, but every tool_result mutation creates a new byte sequence that must be recomputed from the mutation point onward.

### Two Types of Work

| Category | What | Cache Impact |
|----------|------|-------------|
| **Pre-execution repair** | Null stripping, array wrapping, boolean coercion, JSON parsing, path cleaning | **Zero** — args modified before the tool runs; conversation history is unchanged |
| **Post-execution guidance** | Error help text, context about repairs, circuit breaker messages | Traditional approach: appended to tool result → **breaks cache** |

### The Solution: Side-Channel Guidance

```
Traditional (cache-breaking):
  tool runs → error → extension APPENDS guidance to tool_result → history MODIFIED → cache miss

This extension (cache-preserving):
  tool runs → error → extension returns UNDEFINED → history UNCHANGED → cache hit
                                      ↓
                        context event fires → deep copy of messages
                                      ↓
                        guidance injected into DEEP COPY → LLM sees it
                                      ↓
                        deep copy is DISCARDED after LLM call
                        persistent history still has original tool result
```

Key principles:
1. **One-shot injection**: Each guidance kind fires **once per session**. Subsequent identical errors pass through unchanged → cache hit.
2. **Deterministic guidance strings**: Same error always produces the same guidance text → byte-stable across sessions.
3. **Minimal block messages**: Pre-execution validators (path check, staleness, overlap) block tools with a fixed `"[repair-layer] blocked"` string — always byte-identical.
4. **Analytics-only tool_result**: The `tool_result` handler never modifies `event.content`. It only classifies errors, queues guidance, and records events to JSONL.

### Cache Metrics

Track injection impact with `/repair-cache-info`:

```
> /repair-cache-info

📊 Cache Impact
─────────────────
Guidance injections: 3
Each injection means the tool_result text differs from what it would be
without this extension, potentially invalidating DeepSeek's 64-token
block cache for subsequent tokens.

Note: pre-execution repairs (null stripping, array wrapping, etc.)
have ZERO cache impact — they modify args before the tool executes.
Only post-execution guidance injection affects the conversation prefix.
```

---

## 📊 Observability

### Live Commands

| Command | Description |
|---------|-------------|
| `/repair-on` | Enable the repair layer (default) |
| `/repair-off` | Disable — pass raw tool args through unrepaired |
| `/repair-toggle` | Toggle repair layer on/off |
| `/repair-stats-session` | In-memory stats for the current session |
| `/repair-stats-global` | Aggregated stats across all logged sessions |
| `/repair-cache-info` | Cache impact metrics (guidance injection count) |
| `/repair-gaps` | Error patterns without repair coverage |
| `/repair-suggest` | LLM-powered blindspot analysis and new repair suggestions |

### Example: Session Stats

```
> /repair-stats-session

📊 Repair Stats (this session)

Repair Type            Count    %
--------------------------------------
parsed JSON              12   38%
wrapped bare              8   25%
unwrapped markdown        5   16%
coerced boolean           3    9%
split string              2    6%
coerced number            1    3%
--------------------------------------
Total                    31
```

### Example: /repair-suggest Workflow

```
> /repair-suggest

⚡ Confirm: Analyze repair gaps?
   Using claude/sonnet-4
   1526 events, 8 blindspots, 37 errors
   This will consume LLM tokens. Continue?

✓ (confirm)

┌─────────────────────────────────────────────┐
│ 🔧 Repair Suggest - Analyzing               │  ◄ widget via setWidget()
│ ─────────────────────────                    │
│   ⠴ 🤖 Analyzing patterns with LLM...       │  ◄ Braille spinner animado
└─────────────────────────────────────────────┘

💡 Repair Suggestions (LLM-generated)
...

🔎 Critical Analysis
...
✅ Recommendation: implement #1, #2 | defer #3

⚡ Confirm: Open GitHub Issue?
   You just helped the repair-layer evolve automatically.
   Every issue like this makes the extension smarter for everyone.

   Recommended to implement 2 suggestion(s).
   The LLM will compose a title + body with code hints —
   you review and submit.

   Proceed?

✓ (confirm)

┌─────────────────────────────────────────────┐
│ ✍️ Repair Suggest — Composing Issue         │
│ ─────────────────────────                    │
│   ✍️ Composing GitHub Issue...              │  ◄ dots spinner animado
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ 🌐 Repair Suggest — Opening Browser         │
│ ─────────────────────────                    │
│ Opening GitHub issue in browser...          │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ ✅ Repair Suggest — Complete!               │
│ ─────────────────────────                    │
│ Issue opened in browser.                    │
│ Review and click 'Submit new issue'.        │
└─────────────────────────────────────────────┘

✅ Issue pre-filled in your browser.
   Review and click "Submit new issue".
   You just helped the repair-layer evolve.
   Every issue makes it smarter for everyone.
```

**Progress feedback:** The command uses `ctx.ui.setWidget()` for a persistent progress widget above the editor. During analysis, an animated Braille spinner (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) runs at 300ms intervals during the LLM call. During Issue composition, an animated dots spinner ( . . . ) runs at 150ms intervals. Status bar updates via `ctx.ui.setStatus()` run alongside the widget. All timers are cleaned up in the `finally` block even on exception.

**How it works:** The LLM composes a GitHub Issue (title + body with error patterns and code hints) and opens a pre-filled `New Issue` page via GitHub's URL query parameters — no API token, no setup. User reviews and clicks Submit.

### Example: Blindspot Report

```
> /repair-gaps

🔍 Repair Blindspots (unfixed error patterns)

  [ENOENT] web_search — 5x
  ├─ Models: claude-sonnet-4-5, gpt-4o
  ├─ First: 2026-05-28T10:00:00.000Z
  ├─ Last:  2026-05-28T11:00:00.000Z
  └─ 💡 Consider fuzzy path matching: retry with relative path, check common parent dirs.

Total: 1 blindspot(s) detected.
```

### Event Schema

Every event is recorded as a JSONL line with 28 fields:

| Field | Type | Example |
|-------|------|---------|
| `eventType` | `"tool_call"` / `"tool_result"` | `"tool_result"` |
| `toolName` | `string` | `"edit"` |
| `provider` | `string` | `"anthropic"` |
| `model` | `string` | `"claude-sonnet-4-5"` |
| `repairs` | `string[]` | `["wrap-array", "parse-json"]` |
| `wasRepaired` | `boolean` | `true` |
| `executionFailed` | `boolean` | `false` |
| `executionErrorType` | `string` | `"EDIT_MISMATCH"` |
| `wasHandled` | `boolean` | `false` |
| `handleType` | `string` | `"cli_guidance"` |
| `blindspotCategory` | `string` | `"CONSECUTIVE_LOOP"` |
| `inputKeys` | `string[]` | `["path", "edits"]` |

Full schema: 28 fields including `sessionId`, `turnIndex`, `ts`, `inputNullKeys`, `inputExtraProps`.

### Automated Analysis

Standard JSONL format means any JSON tool works:

```bash
# Most common repair types
jq -r '.repairs[]' .pi/repair-log/*.jsonl | sort | uniq -c | sort -rn | head -10

# Error rate per model
jq -r 'select(.eventType == "tool_result") | "\(.provider)/\(.model) \(.executionFailed)"' \
  .pi/repair-log/*.jsonl | awk '{failed+=$2; total+=1} END {printf "%.1f%% (%d/%d)\n", failed/total*100, failed, total}'
```

```sql
-- DuckDB: errors by tool and category
SELECT
  json_extract_string(line, '$.toolName') AS tool,
  json_extract_string(line, '$.executionErrorType') AS error_type,
  count(*) AS cnt
FROM read_text('.pi/repair-log/*.jsonl')
GROUP BY tool, error_type
ORDER BY cnt DESC;
```

---

## ⚙️ Reference

### Schema-Aware Array Item Repair

| Field | Allowed Properties |
|-------|--------------------|
| `edits` | `oldText`, `newText` |
| `replacements` | `path`, `symbol`, `text` |
| `files` | `path`, `edits`, `replacements` |
| `tasks` | `agent`, `task`, `count`, `output`, `outputMode`, `reads`, `progress`, `model`, `skill`, `cwd` |
| `steps` | `agent`, `task`, `output`, `outputMode`, `reads`, `progress`, `model`, `skill`, `cwd` |
| `commands` | `label`, `command` |

### Error Classification

| Error Text Pattern | Classification |
|--------------------|----------------|
| `EISDIR` | `EISDIR` |
| `no such file` / `ENOENT` | `ENOENT` |
| `permission denied` / `EACCES` / `EPERM` | `EACCES` |
| `timeout` / `timed out` | `timeout` |
| `rate limit` / `429` | `rate_limit` |
| `bad request` / `400` | `bad_request` |
| `could not find the exact text` / `could not find edits[*]` / `oldText does not match` / `replacement produced identical content` / `no changes made to` / `occurrences of the text` | `EDIT_MISMATCH` |
| `Validation failed` / `must not have more than` / `must be one of` / `must match` | `SCHEMA_VALIDATION` |
| `4xx` / `5xx` HTTP codes | `HTTP_<code>` |

### Native Tools × Extension Tools

| Type | Tools | Repair Strategy |
|------|-------|-----------------|
| **Pi native** | `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` | Generic field repairs + execution guidance on consecutive failures |
| **Extension tools** | `agent_browser`, `ctx_search`, `web_search`, etc. | Generic field repairs only (error semantics vary per extension) |

### File Structure

```
pi-tool-repair-layer/
├── index.ts                  # Extension entry: 3 handlers (tool_call, tool_result, context)
├── repairs.ts                # Pure repair functions + dispatch table + guidance
├── repairs/*.ts              # Sub-modules (constants, path-utils, array-utils, coercion, etc.)
├── recorder.ts               # Event recording + analysis + re-exports
├── recorder/
│   ├── classifier.ts         # Error classification + CLI help text
│   ├── tracker.ts            # Consecutive failure tracker
│   └── formatting.ts         # Text formatting helpers
├── stats.ts                  # In-memory session stats + RepairToggle
├── suggest-repairs.ts        # LLM repair suggestion engine
├── handlers/
│   ├── commands.ts           # All /repair-* command handlers
│   └── context.ts            # Shared handler types
├── docs/repair-catalog.md    # Source of truth for all repair function signatures
├── testing-strategy.md       # Test coverage and mutation strategy
├── *.test.ts                 # 479 tests across 17 files
└── README.md                 # You are here
```

---

## 🔁 Auto-Evolution

This extension is designed to evolve **through usage**, not just code changes. The `/repair-suggest` command is the evolution loop:

```
session logs ──► analyze blindspots ──► LLM generates fix suggestions
                                             │
                                             ▼
                              pre-filled GitHub Issue ──► you review & submit
                                                                 │
                                                                 ▼
                                        repo gets smarter → everyone updates
```

**How it works:** Every time you run `/repair-suggest`, the extension:
1. Analyzes error patterns collected from your sessions
2. Sends them to the LLM which composes concrete fix suggestions
3. Opens a pre-filled GitHub Issue with code hints and examples
4. You **review and submit** — no API token, no setup needed

Every submitted Issue makes the extension smarter for everyone. Over time, the community collects patterns that no single developer would discover alone.

The same philosophy applies to the observability commands:

| On this command… | …you'll see this hint |
|------------------|----------------------|
| `session_start` (auto) | Global overview: sessions, events, repairs, + tips for `/repair-stats-session`, `/repair-stats-global`, `/repair-suggest` |
| `/repair-stats-session` | 💡 Tip: run `/repair-stats-global` for all-session aggregate |
| `/repair-stats-global` | 💡 Tip: run `/repair-suggest` to send patterns upstream |

This creates a natural flow: start → inspect local stats → inspect global → suggest fixes → evolve.

## 🤝 Contributing

1. Fork → branch → PR
2. Keep functions ≤50 lines, files ≤400 lines (coding standards)
3. Add tests for any new repair or handler phase
4. Run `npx vitest run` before committing

**Want the easiest contribution?** Just use `/repair-suggest` in your own sessions. Every submitted Issue is a contribution that helps everyone.

---

## 📄 License

MIT.
