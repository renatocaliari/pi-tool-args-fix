# pi-tool-repair-layer

pi extension that intercepts tool_call events and fixes common LLM argument mistakes before tools execute.

## Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all 209 tests (Vitest) |
| `npx vitest run` | Run tests once |
| `npx vitest --watch` | Watch mode |

## Architecture

| Module | Lines | Purpose |
|--------|-------|---------|
| `index.ts` | ~917 | Extension entry: 2 handlers + 4 commands + 8 sub-functions |
| `repairs.ts` | ~540 | Pure repair functions (field-level arg fixes) |
| `recorder.ts` | ~545 | JSONL persistence, aggregation, blindspot analysis |
| `recorder/classifier.ts` | ~115 | Error classification + CLI help text |
| `recorder/tracker.ts` | ~70 | Consecutive failure loop detection |
| `stats.ts` | ~115 | In-memory session stats |
| `suggest-repairs.ts` | ~742 | LLM repair suggestion engine (blindspot analysis, critical recommendation, GitHub Issue composition) |
| `recorder.test.ts` | ~545 | 41 I/O + analysis + formatting tests |
| `recorder/classifier.test.ts` | ~140 | 21 classifier/grep/help tests |
| `recorder/tracker.test.ts` | ~75 | 8 loop detection tests |
| `repairs.test.ts` | ~640 | 88 tests for repair functions |
| `stats.test.ts` | ~215 | 23 tests for stats module |
| `suggest-repairs.test.ts` | ~175 | 17 tests for suggestion engine (unit + formatting + recommendation + issue) |

## Key Concepts

- **Repairs**: field-level fixes (validate-then-repair, content fields NEVER touched)
- **/repair-suggest workflow**: gather data → confirm → generate suggestions → LLM composes GitHub Issue (title + body with code hints) → opens pre-filled New Issue page in browser → user reviews and submits
- **auto-evolution**: every user who submits an Issue contributes patterns/corrections back to the repo — no API token, no GitHub integration
- **Zero-token GitHub flow**: uses `github.com/owner/repo/issues/new?title=...&body=...&labels=suggestion` query params — no API key needed
- **Issue template**: composed by user's own LLM with context (error patterns, frequency, correction code) but no sensitive session data
- **Recorder**: JSONL event logging per session at `.pi/repair-log/`, retention 50 sessions
- **Blindspots**: error patterns without repair coverage (via `computeBlindspots`)
- **Loop detection**: `ConsecutiveFailureTracker` marks 3+ consecutive failures as `CONSECUTIVE_LOOP`
- **CLI guidance**: intercepts 2nd+ consecutive CLI failure with contextual `--help` docs
- **Error classification**: `classifyErrorType()` — pure pattern matching, no tool name dependency

## Naming

- All code, identifiers: **English**
- Extension commands: `/repair-stats`, `/repair-stats-global`, `/repair-gaps`, `/repair-suggest`
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
