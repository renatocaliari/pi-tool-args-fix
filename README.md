# pi-repair-layer

**Intercepts `tool_call` events and repairs common LLM argument mistakes before tools execute.**

Inspired by [@mrahmadawais](https://x.com/mrahmadawais/status/2050956678502420612).

## What It Fixes

| # | Repair | Example |
|---|--------|---------|
| 1 | Strip `null` from optional fields | `{limit: null}` → `{limit}` omitted |
| 2 | Parse stringified JSON arrays/objects | `"["a","b"]"` → `["a","b"]` |
| 3 | Wrap bare string → array | `function_names: "main"` → `["main"]` |
| 4 | Wrap object → single-element array | `edits: {oldText,newText}` → `[{...}]` |
| 5 | Unwrap markdown auto-links from paths | `[file.md](http://file.md)` → `file.md` |
| 6 | Relational defaults (read/read_file) | `{limit:30}` → `{offset:1, limit:30}` |

## Architecture

**Validate-then-repair** — parse first, on failure walk validator issues, repair at exact paths. Only repairs what would otherwise fail. Content fields (`command`, `code`, `oldText`, `newText`) are NEVER touched.

**Repair order:** `clean-path` → `parse-json` → `wrap-object-as-array` → `wrap-array` → recurse into nested structures.

## Install

```bash
pi install ./path/to/pi-repair-layer
```

Or from git:

```bash
pi install git:github.com/user/pi-repair-layer@v0.1.0
```

## Usage

Once installed, repairs happen automatically on every tool call. View stats with `/repair-stats`.

## License

MIT
