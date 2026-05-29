<div align="center">

# 🔧 pi-tool-repair-layer

<br>

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/Tests-187_passing-2ea043?style=for-the-badge)

**Fix LLM tool-calling bugs transparently — no model changes, no retraining.**

<br>

[💡 Concept](#-concept) · [✨ Features](#-features) · [🚀 Quick Start](#-quick-start) · [🔍 Architecture](#-architecture) · [📊 Observability](#-observability) · [⚙️ Reference](#️-reference) · [🤝 Contributing](#-contributing)

<br>

</div>

---

> *"The core insight: 'open model bad at tool calling' is almost always a harness problem. A finite set of compositional failures repeats across models."* — Ahmad Awais

This extension is the harness fix. ~90% of tool-calling failures are the same reusable patterns — fix them once at the tool boundary and every model benefits.

---

## 💡 Concept

Open-weight and smaller LLMs (DeepSeek, GLM, Qwen, Llama) are notorious for broken tool calls. But the failures aren't random — they're **12 finite, compositional bugs** that repeat across every model:

| # | What the model emits | What the tool needs | Repair |
|---|---------------------|---------------------|--------|
| 1 | `{limit: null}` | omit the field entirely | Strip `null` from optional fields |
| 2 | `paths: "[\"a.ts\",\"b.ts\"]"` | `paths: ["a.ts", "b.ts"]` | Parse stringified JSON arrays/objects |
| 3 | `edits: {oldText, newText}` | `edits: [{oldText, newText}]` | Wrap bare object → single-element array |
| 4 | `function_names: "main"` | `function_names: ["main"]` | Wrap bare string/number → array |
| 5 | `path: "[notes.md](http://notes.md)"` | `path: "notes.md"` | Unwrap markdown links from paths |
| 6 | `{limit: 30}` | `{offset: 1, limit: 30}` | Relational defaults (read/read_file) |
| 7 | `tags: "admin, user"` | `tags: ["admin", "user"]` | Split delimited strings → array |
| 8 | `name: "null"` | omit the field entirely | Strip null-like strings |
| 9 | `strict: "true"` | `strict: true` | Coerce boolean strings |
| 10 | `limit: "42"` | `limit: 42` | Coerce number strings |
| 11 | `read ~/dir/` → EISDIR | `📁 Directory listing` | Directory fallback via `fs.readdir()` |
| 12 | `edits: [{oldText, newText, path}]` | `edits: [{oldText, newText}]` | Strip extra properties from array items |

### Why not just use better models?

Because this is a **harness problem**, not a model problem. Every model makes these mistakes — including frontier models. Fixing it at the harness level means:
- ✅ **Every model benefits** — from Llama to Claude
- ✅ **Zero changes to model weights** or training pipelines
- ✅ **Works offline**, no cloud dependency
- ✅ **Transparent** — model doesn't know it was helped
- ✅ **Sub-millisecond repairs** — no perceptible latency

<div align="center">
<br>
<img src="https://img.shields.io/badge/Validated_against-DeepSeek_GLM_Qwen_Llama_Claude_GPT-555?style=flat-square" alt="Models">
<img src="https://img.shields.io/badge/Repair_latency-%3C1ms_per_field-brightgreen?style=flat-square" alt="Latency">
<img src="https://img.shields.io/badge/Content_fields-NEVER_touched-red?style=flat-square" alt="Safety">
<br><br>
</div>

---

## ✨ Features

<details>
<summary><strong>🔧 12 field-level repairs</strong> — structural fixes before the tool runs</summary>

<br>

**Validate-then-repair:** every field is parsed first — valid input passes through unchanged. Content fields (`command`, `code`, `oldText`, `newText`, `text`) are **never** touched.

| Priority | Repair | Description |
|----------|--------|-------------|
| 1 | `clean-path` | Unwrap markdown links, normalize `~/` paths |
| 2 | `parse-json` | Stringified JSON → object/array |
| 3 | `wrap-object-as-array` | `{...}` → `[{...}]` |
| 4 | `wrap-array` | Bare value → `[value]` |
| 5 | `split-string-to-array` | `"foo, bar"` → `["foo", "bar"]` |
| 6 | `strip-extra-properties` | Remove unknown keys from array items (schema-aware) |
| 7 | `null-like-to-undefined` | Strip `"null"`, `"none"`, `"n/a"` strings |
| 8 | `coerce-boolean` | `"true"` / `"yes"` / `"1"` → `true` |
| 9 | `coerce-number` | `"42"` / `"3.14"` → `42` / `3.14` |
| — | Recurse into nested structures after type changes |

</details>

<details>
<summary><strong>🛡️ Error recovery</strong> — catch failures, inject guidance, break retry loops</summary>

<br>

| Mechanism | Trigger | Effect |
|-----------|---------|--------|
| **Directory fallback** | `read` on a directory → EISDIR | Returns `📁 Directory: listing` with contents |
| **CLI guidance** | 2nd+ consecutive `bash`/`grep`/`find`/`ls` failure | Appends `── Tool guidance ──` with exit code semantics |
| **Edit guidance** | 2nd+ consecutive `edit` failure | Tells model to re-read the file before trying again |
| **Schema guidance** | First `SCHEMA_VALIDATION` error per tool | Explains validation rules (types, enums, maxLength) |
| **Loop detection** | 3+ consecutive same-tool failures | Flags as `CONSECUTIVE_LOOP` in analytics |
| **Empty result detection** | Successful call, no output | Logs as `EMPTY_RESULT` for blindspot analysis |

</details>

<details>
<summary><strong>📊 Observability</strong> — every event logged, analyzable across sessions</summary>

<br>

- **Per-session JSONL logs** at `.pi/repair-log/<sessionId>.jsonl`
- **3 commands** for live analysis: `/repair-stats`, `/repair-stats-global`, `/repair-gaps`
- **28-field event schema** with error classification, blindspot detection, repair tracking
- **50-session retention** with auto-prune
- **DuckDB queryable** — standard JSONL format

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
| `EDIT_MISMATCH` | Edit text not found | Read file before retry |
| `SCHEMA_VALIDATION` | Schema violation | Field-level truncation |
| `CONSECUTIVE_LOOP` | 3+ same-tool failures | Circuit break, guidance |
| `EMPTY_RESULT` | Tool succeeded, no output | Analytics only |

</details>

---

## 🚀 Quick Start

```bash
# Install
pi install git:github.com/renatocaliari/pi-tool-repair-layer

# That's it. Every tool call is intercepted and repaired automatically.
# Check session stats:
/repair-stats
```

**No configuration. No model changes. Zero dependencies pulled in.**

---

## 🔍 Architecture

```
                    tool_call                    tool_result
                         │                           │
                         ▼                           ▼
               ┌─────────────────────┐     ┌──────────────────────┐
               │ 1. Classify fields  │     │ 1. Classify error     │
               │    (array, string,  │     │ 2. Detect empty       │
               │     boolean, etc.)  │     │ 3. Track failures     │
               │                     │     │ 4. Inject guidance    │
               │ 2. Apply repairs    │     │ 5. Directory fallback │
               │    (sub-millisecond)│     │ 6. Log to JSONL       │
               └────────┬────────────┘     └──────────┬───────────┘
                        │                             │
                        ▼                             ▼
                  No repairs?                     Handled?
                  ───────────                     ────────
                  Pass through                     Return patched result
                  untouched                        or undefined (pass)
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

### Event Pipeline

Every `tool_call` and `tool_result` flows through 5 handler phases:

```
Phase 1.a — Field repair (tool_call)
Phase 1.b — Consecutive failure tracking + guidance injection (tool_result)
Phase 1.c — Empty result detection (tool_result)
Phase 1.d — Error-type guidance on first occurrence (tool_result)
Phase 2   — EISDIR directory fallback (tool_result)
Phase 3   — Event recording to JSONL + in-memory stats (tool_result)
```

---

## 📊 Observability

### Live Commands

| Command | Description |
|---------|-------------|
| `/repair-stats` | In-memory stats for the current session |
| `/repair-stats-global` | Aggregated stats across all logged sessions |
| `/repair-gaps` | Error patterns without repair coverage |

### Example: Session Stats

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
| `could not find the exact text` / `could not find edits[*]` / `oldText does not match` | `EDIT_MISMATCH` |
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
├── index.ts                  # Extension entry: handlers + commands (~703 lines)
├── repairs.ts                # Pure repair functions (~540 lines)
├── recorder.ts               # Event recording + analysis + re-exports (~545 lines)
├── recorder/
│   ├── classifier.ts         # Error classification + help text (~110 lines)
│   └── tracker.ts            # Consecutive failure tracker (~70 lines)
├── stats.ts                  # In-memory session stats (~115 lines)
├── *.test.ts                 # 187 tests across 5 files
└── README.md                 # You are here
```

---

## 🤝 Contributing

1. Fork → branch → PR
2. Keep functions ≤50 lines, files ≤400 lines (coding standards)
3. Add tests for any new repair or handler phase
4. Run `npx vitest run` before committing

```bash
# Development
git clone https://github.com/renatocaliari/pi-tool-repair-layer
cd pi-tool-repair-layer
npm install
npx vitest run   # 187 tests
```

---

## 📄 License

MIT. Inspired by [@mrahmadawais](https://x.com/mrahmadawais/status/2050956678502420612)'s tool-input repair layer for CommandCode.
