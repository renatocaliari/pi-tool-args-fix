# Agent Guidelines

<!-- Do not restructure or delete sections. Update individual values in-place when they change. -->

## Core Principles

- **Keep this file under 30 lines of instructions.** Every line competes for the agent's limited context budget (~150-200 total).
- **Only repair primary/builtin tools.** Never add repairs specific to external extension CLI agents (e.g., `agent_browser`, `web_search`, `fetch_content`). Extension tools get generic guidance via `getToolHelp` on every failure — no field-level or arg-level fixes.
- **Validate-then-repair.** Pure repair functions only fix structural arg issues (types, nulls, arrays), never content fields (`command`, `code`, `oldText`, `newText`).
- **No external runtime dependencies.** TypeScript + Vitest only.
- **REPAIR CATALOG:** See `docs/repair-catalog.md` — it is the source of truth for ALL 9 field-level repairs, 8 execution guidance functions, 3 classification predicates, 8 constant sets, and the dispatch table. Every refactoring MUST preserve the catalog contracts. **Do not delete or rename any function without updating the catalog and checking test coverage.**
- **TEST CONTRACT:** Every repair in the catalog must have tests in `repairs.test.ts`. Coverage is checked via `npx vitest run --coverage`. If a repair function has no tests, add them before committing.
- **Fase 3/4 dependency:** `classifyField` uses 3 predicate functions (`isArrayLike`, `isBooleanField`, `looksLikeNumberField`). `repairFieldValue` uses `repairDispatchers` lookup table (8 dispatch functions). Both were extracted from inline switch/OR-chains — these are intentional structural choices, not over-engineering. Preserve them.
- **Structural integrity tests:** 15 tests in `repairs.test.ts` verify the extracted architecture survived. `npx vitest run repairs.test.ts -t "structural integrity"` runs them. If any fail, the dispatch table or predicates were inlined — re-extract them before committing.

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
| `index.ts` | ~1193 | Extension entry: tool_call + tool_result handlers + commands |
| `repairs.ts` | ~1200 | Pure field-level repair functions + dispatch table + guidance |
| `repairs/constants.ts` | ~152 | 8 constant sets (PATH, ARRAY, BOOLEAN, CONTENT, NUMBER, FALSY, TRUTHY, LONG_RUNNING) |
| `recorder.ts` | ~372 | JSONL persistence, aggregation, blindspot analysis |
| `recorder/classifier.ts` | ~115 | Error classification + `getToolHelp` (generic guidance for ALL tools) |
| `recorder/formatting.ts` | ~174 | Formatting helpers extracted from recorder.ts |
| `recorder/tracker.ts` | ~70 | Consecutive failure loop detection |
| `stats.ts` | ~165 | In-memory session stats + RepairToggle + parseRepairType |
| `suggest-repairs.ts` | ~742 | LLM repair suggestion engine (blindspot analysis, GitHub Issue composition) |
| `docs/repair-catalog.md` | — | Repair function catalog — source of truth for refactoring safety |

### Key Behavior

- **Guidance injection fires for EVERY tool on every failure** — no hardcoded whitelist, no wait for repeated failure. Falls back to generic help for unknown/extension tools.
- **Circuit breaker** at 7+ consecutive failures forces strategy change.
- **Error classification** is pure pattern matching — no tool name dependency.
- **auto-evolution**: users submit Issues with correction patterns via zero-token GitHub Issue links.
- **Repair order**: classifyField → repairFieldValue (dispatch loop) → recurse into nested structures. Never touch content fields.

---

## Maintenance Notes

- Review AGENTS.md when architecture changes
- Update commands when workflows change
- Keep under 30 lines — move detail to separate docs if needed
- Delete anything the agent can infer from code
