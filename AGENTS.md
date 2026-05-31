# Agent Guidelines

<!-- Do not restructure or delete sections. Update individual values in-place when they change. -->

## Core Principles

- **Keep this file under 30 lines of instructions.** Every line competes for the agent's limited context budget (~150-200 total).
- **Only repair primary/builtin tools.** Never add repairs specific to external extension CLI agents (e.g., `agent_browser`, `web_search`, `fetch_content`). Extension tools get generic guidance via `getToolHelp` on every failure — no field-level or arg-level fixes.
- **Validate-then-repair.** Pure repair functions only fix structural arg issues (types, nulls, arrays), never content fields (`command`, `code`, `oldText`, `newText`).
- **No external runtime dependencies.** TypeScript + Vitest only.

---

## Project Overview

**Project type:** pi coding-agent extension  
**Primary language:** TypeScript (strict)  
**Key dependencies:** Vitest (testing only)

---

## Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all tests (Vitest) |
| `npx vitest run` | Run tests once |
| `npx vitest --watch` | Watch mode |

---

## Code Conventions

- Follow existing patterns in the codebase
- KISS, DRY, pure functions preferred
- Delete dead code immediately
- All code, identifiers: English

---

## Architecture

| Module | Lines | Purpose |
|--------|-------|---------|
| `index.ts` | ~917 | Extension entry: tool_call + tool_result handlers |
| `repairs.ts` | ~540 | Pure field-level repair functions |
| `recorder.ts` | ~545 | JSONL persistence, aggregation, blindspot analysis |
| `recorder/classifier.ts` | ~115 | Error classification + `getToolHelp` (generic guidance for ALL tools) |
| `recorder/tracker.ts` | ~70 | Consecutive failure loop detection |
| `stats.ts` | ~115 | In-memory session stats |
| `suggest-repairs.ts` | ~742 | LLM repair suggestion engine (blindspot analysis, GitHub Issue composition) |

### Key Behavior

- **Guidance injection fires for EVERY tool on every failure** — no hardcoded whitelist, no wait for repeated failure. Falls back to generic help for unknown/extension tools.
- **Circuit breaker** at 7+ consecutive failures forces strategy change.
- **Error classification** is pure pattern matching — no tool name dependency.
- **auto-evolution**: users submit Issues with correction patterns via zero-token GitHub Issue links.

---

## Maintenance Notes

- Review AGENTS.md when architecture changes
- Update commands when workflows change
- Keep under 30 lines — move detail to separate docs if needed
- Delete anything the agent can infer from code
