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
| 11 | 11 | `read ~/dir/` → EISDIR | `📁 Directory: listing` | Fallback: `fs.readdir()` and return listing with hint |

## Architecture

**Validate-then-repair** — parse first, only repair what would fail. Valid input passes through unchanged. Content fields (`command`, `code`, `oldText`, `newText`) are **never** touched — only structural/container fields are repaired.

### Directory Fallback

When the model calls `read` on a directory path instead of a file, the native tool returns an EISDIR error. The extension intercepts this via the `tool_result` hook, detects the EISDIR error, lists the directory contents via `fs.readdir()`, and returns a clean listing with a hint for the model — all in the same tool result. No second tool call needed.

Repair order matters:
1. `clean-path` — unwrap markdown links, normalize `~/` paths
2. `parse-json` — string → object/array
3. `wrap-object-as-array` — `{...}` → `[{...}]`
4. `wrap-array` — bare value → `[value]`
5. `split-string-to-array` — `"foo, bar"` → `["foo", "bar"]`
6. `null-like-to-undefined` — strip "null", "none", "n/a" strings
7. `coerce-boolean` — "true"/"yes"/"1" → true
8. `coerce-number` — "42"/"3.14" → 42/3.14
9. Recurse into nested structures after type changes

Every repair is logged with `tool_input_repaired:<toolName>` via `console.error` and surfaced in the TUI status bar. View cumulative stats with `/repair-stats`.

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
| `/repair-stats` | Show repair statistics for the current session |

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

## Why This Exists

> "The core insight: 'open model bad at tool calling' is almost always a harness problem. A finite set of compositional failures repeats across models." — Ahmad Awais

This extension is the harness fix. Rather than waiting for every model to fix these bugs, fix them once at the tool boundary.

## License

MIT
