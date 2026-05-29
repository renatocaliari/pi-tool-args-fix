# pi-tool-repair-layer

pi extension that intercepts tool_call events and fixes common LLM argument mistakes before tools execute.

## Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all 181 tests (Vitest) |
| `npx vitest run` | Run tests once |
| `npx vitest --watch` | Watch mode |

## Architecture

| Module | Lines | Purpose |
|--------|-------|---------|
| `index.ts` | ~640 | Extension entry: 2 event handlers + 3 commands |
| `repairs.ts` | ~592 | Pure repair functions (field-level arg fixes) |
| `recorder.ts` | ~720 | JSONL persistence, aggregation, blindspot analysis |
| `stats.ts` | ~115 | In-memory session stats |
| `recorder.test.ts` | 760 | 70 tests for recorder module |
| `repairs.test.ts` | ~200 | 88 tests for repair functions |
| `stats.test.ts` | ~60 | 23 tests for stats module |

## Key Concepts

- **Repairs**: field-level fixes (validate-then-repair, content fields NEVER touched)
- **Recorder**: JSONL event logging per session at `.pi/repair-log/`, retention 50 sessions
- **Blindspots**: error patterns without repair coverage (via `computeBlindspots`)
- **Loop detection**: `ConsecutiveFailureTracker` marks 3+ consecutive failures as `CONSECUTIVE_LOOP`
- **CLI guidance**: intercepts 2nd+ consecutive CLI failure with contextual `--help` docs
- **Error classification**: `classifyErrorType()` — pure pattern matching, no tool name dependency

## Naming

- All code, identifiers: **English**
- Extension commands: `/repair-stats`, `/repair-stats-global`, `/repair-gaps`
- git branches: standard (main)

## Tech Stack

- TypeScript (strict)
- Vitest (testing)
- No external runtime deps

## Don'ts

- Never add external dependencies without asking
- Never touch content fields (command, code, oldText, newText, code, etc.)
- Never put secrets in AGENTS.md
- Never use global mutable state
