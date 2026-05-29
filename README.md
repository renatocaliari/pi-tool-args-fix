# pi-tool-repair-layer

**A pi extension that intercepts `tool_call` events and fixes common LLM argument mistakes before tools execute.**

Open-weight and smaller LLMs (DeepSeek, GLM, Qwen, Llama) are notorious for tool-calling failures — but ~90% of these failures are *the same four bugs* repeating across every model. This extension catches and fixes them transparently, so the tool never even sees the broken input.

Inspired by [@mrahmadawais](https://x.com/mrahmadawais/status/2050956678502420612).

## The Failure Modes We Fix

| # | What the model emits | What the tool needs | Repair |
|---|---------------------|---------------------|--------|
| 1 | `{limit: null}` | omit the field entirely | Strip `null` from optional fields |
| 2 | `paths: "[\"a.ts\",\"b.ts\"]"` | `paths: ["a.ts", "b.ts"]` | Parse stringified JSON arrays/objects |
| 3 | `edits: {oldText, newText}` | `edits: [{oldText, newText}]` | Wrap bare object → single-element array |
| 4 | `function_names: "main"` | `function_names: ["main"]` | Wrap bare string/number → array |
| 5 | `path: "[notes.md](http://notes.md)"` | `path: "notes.md"` | Unwrap markdown auto-links from paths |
| 6 | `{limit: 30}` | `{offset: 1, limit: 30}` | Relational defaults for read/read_file |
| 7 | `tags: "admin, user"` | `tags: ["admin", "user"]` | Split comma/space-separated strings → array |
| 8 | `name: "null"` | omit the field entirely | Strip null-like strings ("null", "none", "n/a") |
| 9 | `strict: "true"` | `strict: true` | Coerce boolean strings ("true", "yes", "1") |
| 10 | `limit: "42"` | `limit: 42` | Coerce number strings ("42", "3.14") |
| 11 | `read ~/dir/` → EISDIR | `📁 Directory: listing` | Fallback: `fs.readdir()` and return listing with hint |
| 12 | `edits: [{oldText, newText, path}]` | `edits: [{oldText, newText}]` | Strip extra properties from array items (schema-aware) |

## Architecture

**Validate-then-repair** — parse first, only repair what would fail. Valid input passes through unchanged. Content fields (`command`, `code`, `oldText`, `newText`) are **never** touched — only structural/container fields are repaired.

### Schema-Aware Array Item Repair

When a model sends extra properties inside array items (e.g. `path` duplicated inside each `edits[]` item), the extension strips them based on a per-field schema map:

| Field | Allowed Properties |
|-------|--------------------|
| `edits` | `oldText`, `newText` |
| `replacements` | `path`, `symbol`, `text` |
| `files` | `path`, `edits`, `replacements` |
| `tasks` | `agent`, `task`, `count`, `output`, `outputMode`, `reads`, `progress`, `model`, `skill`, `cwd` |
| `steps` | `agent`, `task`, `output`, `outputMode`, `reads`, `progress`, `model`, `skill`, `cwd` |
| `commands` | `label`, `command` |

This catches the common pattern where the model duplicates a parent-level parameter (like `path`) into every nested array item.

### Directory Fallback

When the model calls `read` on a directory path instead of a file, the native tool returns an EISDIR error. The extension intercepts this via the `tool_result` hook, detects the EISDIR error, lists the directory contents via `fs.readdir()`, and returns a clean listing with a hint for the model — all in the same tool result. No second tool call needed.

### CLI Guidance (Consecutive Failure)

When a native CLI tool (`bash`, `grep`, `find`, `ls`) fails 2+ times consecutively with the same argument pattern, the extension intercepts the `tool_result` and appends contextual documentation explaining the tool's exit code semantics and common causes.

Example: on the 2nd consecutive `grep` failure, the model sees:
```
(no output) — exited with code 1

── Tool guidance ──
The grep tool searches for patterns in files.
  - Exit code 0: match(es) found
  - Exit code 1: no matches found (this is NORMAL, not an error)
  - Exit code 2: error (e.g. file not found, invalid pattern)
Tip: Try a broader pattern, check the file path, or use grep -i
```

This works for any native CLI tool. Extension tools (`agent_browser`, `ctx_search`, etc.) are excluded — their error semantics differ per extension.

### Consecutive Loop Detection

The extension tracks consecutive failures per tool via `ConsecutiveFailureTracker`. When the same tool fails 3+ times with the same argument pattern, the event is marked as `CONSECUTIVE_LOOP` in the blindspot log. This catches the common pattern where the model enters an unproductive retry loop (e.g. 15+ retries of `edit` on the same file).

### Error Classification (Blindspot Detection)

All `tool_result` errors are classified by `classifyErrorType()`, a pure pattern-matching function that works on error text alone (no tool name dependency):

| Pattern | Classification |
|---------|---------------|
| `EISDIR` | `EISDIR` |
| `no such file` / `ENOENT` | `ENOENT` |
| `permission denied` / `EACCES`/`EPERM` | `EACCES` |
| `timeout` / `timed out` | `timeout` |
| `rate limit` / `429` | `rate_limit` |
| `bad request` / `400` | `bad_request` |
| `could not find the exact text` / `oldText does not match` | `EDIT_MISMATCH` |
| `Validation failed` / `must not have more than` / `must be one of` | `SCHEMA_VALIDATION` |
| `4xx` / `5xx` HTTP codes | `HTTP_<code>` |

Unclassifiable errors are filtered:
- **Native CLI false positives**: `bash|grep|find|ls` with empty error text → not flagged
- **Generic safety net**: any tool with empty error text → not flagged
- **Empty results**: successful tool calls with no output logged as `EMPTY_RESULT` (analytics only)

### Tool Call Repair Order

1. `clean-path` — unwrap markdown links, normalize `~/` paths
2. `parse-json` — string → object/array
3. `wrap-object-as-array` — `{...}` → `[{...}]`
4. `wrap-array` — bare value → `[value]`
5. `split-string-to-array` — `"foo, bar"` → `["foo", "bar"]`
6. `strip-extra-properties` — remove unknown keys from array items
7. `null-like-to-undefined` — strip "null", "none", "n/a" strings
8. `coerce-boolean` — "true"/"yes"/"1" → true
9. `coerce-number` — "42"/"3.14" → 42/3.14
10. Recurse into nested structures after type changes

Every repair is logged with `tool_input_repaired:<toolName>` via `console.error`, surfaced in the TUI status bar, and persisted to JSONL at `.pi/repair-log/<sessionId>.jsonl`.

## Install

```bash
pi install git:github.com/renatocaliari/pi-tool-repair-layer
```

Or from a local clone:

```bash
pi install ./path/to/pi-tool-repair-layer
```

## Usage

Once installed, repairs are automatic — no configuration needed. Every tool call is intercepted, validated, and repaired before execution.

### Commands

| Command | Description |
|---------|-------------|
| `/repair-stats` | Show in-memory repair statistics for the current session |
| `/repair-stats-global` | Show aggregated repair stats across all logged sessions |
| `/repair-gaps` | Show error patterns that lack repair coverage (blindspots) |

### Example Output

```
> /repair-stats

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

```
> /repair-gaps

🔍 Repair Blindspots (unfixed error patterns)
────────────────────────────────────────────

  [ENOENT] web_search — 5x
  ├─ Models: anthropic/claude-sonnet-4-5, openai/gpt-4o
  ├─ First: 2026-05-28T10:00:00.000Z
  ├─ Last:  2026-05-28T11:00:00.000Z
  ├─ Example: input keys: [query]
  └─ 💡 Consider fuzzy path matching: retry with relative path, check common parent dirs.

Total: 1 blindspot(s) detected.
```

## 📊 Event Logging

Every `tool_call` and `tool_result` event is recorded to a JSONL file for
post-session analysis.

### Storage Location

```
.pi/repair-log/
  ├── <sessionId>.jsonl       ← append-only events
  └── ... (one file per session)
```

### Event Schema (JSON, one object per line)

| Field | Type | Description |
|-------|------|-------------|
| `ts` | string | ISO 8601 timestamp |
| `eventType` | `"tool_call"` / `"tool_result"` | Phase of the event |
| `sessionId` | string | pi session identifier |
| `turnIndex` | number | Sequential event counter |
| `toolName` | string | Tool that was called (e.g. `read`, `edit`, `bash`) |
| `provider` | string | Model provider (e.g. `test-provider`) |
| `model` | string | Model id (e.g. `test-model`) |
| `repairs` | string[] | What repairs were applied |
| `wasRepaired` | boolean | Whether any repair was applied |
| `executionFailed` | boolean | Whether the tool execution failed |
| `executionErrorType` | string | Error category (`ENOENT`, `EACCES`, `timeout`, `EDIT_MISMATCH`, `SCHEMA_VALIDATION`, …) |
| `wasHandled` | boolean | Whether the extension handled the error (e.g. directory fallback, CLI guidance) |
| `handleType` | string | Handler name (`directory_fallback`, `cli_guidance`, …) |
| `blindspotCategory` | string | Non-null when this error could benefit from a new repair (`CONSECUTIVE_LOOP`, `EMPTY_RESULT`, …) |
| `inputKeys` | string[] | Structural fingerprint: input field names |
| `inputNullKeys` | string[] | Fields that were sent as `null` |
| `inputExtraProps` | string[] | Extra properties stripped from array items |

### Retention

Session logs are retained for the last **50 sessions**, pruned automatically at
extension startup. Storage is minimal (~10KB per session).

### DuckDB Integration

Since the log format is standard JSONL, you can query across sessions with DuckDB:

```sql
-- Count errors by tool and category
SELECT
  json_extract_string(line, '$.toolName') AS tool,
  json_extract_string(line, '$.executionErrorType') AS error_type,
  count(*) AS cnt
FROM read_text('.pi/repair-log/*.jsonl')
GROUP BY tool, error_type
ORDER BY cnt DESC;
```

Or combine with shell to analyze live:

```bash
# Most common repair types
jq -r '.repairs[]' .pi/repair-log/*.jsonl | sort | uniq -c | sort -rn | head -10

# Error rate per model
jq -r 'select(.eventType == "tool_result") | "\(.provider)/\(.model) \(.executionFailed)"'
  .pi/repair-log/*.jsonl | awk '{failed+=$2; total+=1} END {printf "%.1f%% (%d/%d)\n", failed/total*100, failed, total}'
```

## Why This Exists

> "The core insight: 'open model bad at tool calling' is almost always a harness problem. A finite set of compositional failures repeats across models." — Ahmad Awais

This extension is the harness fix. Rather than waiting for every model to fix these bugs, fix them once at the tool boundary.

## License

MIT
