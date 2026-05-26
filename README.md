# pi-tool-args-fix

**A pi extension that intercepts `tool_call` events and fixes common LLM argument mistakes before tools execute.**

Open-weight and smaller LLMs (DeepSeek, GLM, Qwen, Llama) are notorious for tool-calling failures — but ~90% of these failures are *the same four bugs* repeating across every model. This extension catches and fixes them transparently, so the tool never even sees the broken input.

Inspired by [@mrahmadawais](https://x.com/mrahmadawais/status/2050956678502420612).

## The Four Failure Modes (and One Bonus)

| # | What the model emits | What the tool needs | Repair |
|---|---------------------|---------------------|--------|
| 1 | `{limit: null}` | omit the field entirely | Strip `null` from optional fields |
| 2 | `paths: "[\"a.ts\",\"b.ts\"]"` | `paths: ["a.ts", "b.ts"]` | Parse stringified JSON arrays/objects |
| 3 | `edits: {oldText, newText}` | `edits: [{oldText, newText}]` | Wrap bare object → single-element array |
| 4 | `function_names: "main"` | `function_names: ["main"]` | Wrap bare string/number → array |
| 5 | `path: "[notes.md](http://notes.md)"` | `path: "notes.md"` | Unwrap markdown auto-links from paths |
| 6 | `{limit: 30}` | `{offset: 1, limit: 30}` | Relational defaults for read/read_file |

## Architecture

**Validate-then-repair** — parse first, only repair what would fail. Valid input passes through unchanged. Content fields (`command`, `code`, `oldText`, `newText`) are **never** touched — only structural/container fields are repaired.

Repair order matters:
1. `clean-path` — unwrap markdown links, normalize `~/` paths
2. `parse-json` — string → object/array
3. `wrap-object-as-array` — `{...}` → `[{...}]`
4. `wrap-array` — bare value → `[value]`
5. Recurse into nested structures after type changes

Every repair is logged with `tool_input_repaired:<toolName>` via `console.error` and surfaced in the TUI status bar. View cumulative stats with `/repair-stats`.

## Install

```bash
pi install git:github.com/renatocaliari/pi-tool-args-fix@v0.1.0
```

Or from a local clone:

```bash
pi install ./path/to/pi-tool-args-fix
```

## Usage

Once installed, repairs are automatic — no configuration needed. Every tool call is intercepted, validated, and repaired before execution. The `/repair-stats` command shows per-model, per-tool repair counts.

## Why This Exists

> "The core insight: 'open model bad at tool calling' is almost always a harness problem. A finite set of compositional failures repeats across models." — Ahmad Awais

This extension is the harness fix. Rather than waiting for every model to fix these bugs, fix them once at the tool boundary.

## License

MIT
