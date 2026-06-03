# Agent Guidelines

<!-- Do not restructure or delete sections. Update individual values in-place when they change. -->

## Core Principles

- **Cache preservation is non-negotiable.** Guidance never modifies `tool_result.content` (breaks LLM prefix cache). It is queued and injected via the `context` event side channel, which mutates only a deep copy of the messages array. Pre-execution repairs have zero cache impact and are the preferred path. Each guidance kind fires at most once per session per `(kind, tool, input)`.
- **Keep this file under 30 lines of instructions.** Every line competes for the agent's limited context budget (~150-200 total).
- **Only repair primary/builtin tools.** Never add repairs specific to external extension tools (`agent_browser`, `web_search`, `fetch_content`). Extension tools get generic guidance via `getToolHelp` on every failure — no field-level or arg-level fixes.
- **Validate-then-repair.** Pure repair functions only fix structural arg issues (types, nulls, arrays), never content fields (`command`, `code`, `oldText`, `newText`).
- **No external runtime dependencies.** TypeScript + Vitest only.
- **REPAIR CATALOG:** See `docs/repair-catalog.md` — source of truth for ALL 9 field-level repairs, 8 execution guidance functions, 3 classification predicates, 8 constant sets, and the dispatch table. Every refactoring MUST preserve the catalog contracts. **Do not delete or rename any function without updating the catalog and checking test coverage.**
- **TEST CONTRACT:** Every repair in the catalog must have colocated tests in `repairs/*.test.ts`. Coverage is checked via `npx vitest run --coverage`. If a repair function has no tests, add them before committing.
- **Fase 3/4 dependency:** `classifyField` uses 3 predicate functions (`isArrayLike`, `isBooleanField`, `looksLikeNumberField`). `repairFieldValue` uses `repairDispatchers` lookup table (8 dispatch functions). Both were extracted from inline switch/OR-chains — these are intentional structural choices, not over-engineering. Preserve them.
- **Structural integrity tests:** in `repairs.test.ts` verify the extracted architecture survived. `npx vitest run repairs.test.ts -t "structural integrity"` runs them. If any fail, the dispatch table or predicates were inlined — re-extract them before committing.

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
| `npx vitest run repairs.test.ts -t "structural integrity"` | Verify extracted architecture survived |

---

## Don'ts

- **Never modify `tool_result.content`** — breaks LLM prefix cache. Use `context` event side channel instead.
- **Never touch content fields** (`command`, `code`, `oldText`, `newText`, `text`, `content`) — structural repairs only.
- **Never add external runtime dependencies** — TypeScript + Vitest only.
- **Never add repairs for external extension tools** (`agent_browser`, `web_search`, `fetch_content`) — generic `getToolHelp` only.
- **Never rename or delete a repair function** without updating `docs/repair-catalog.md` and checking test coverage.
- **Never commit code without tests** — every repair function needs colocated tests in `repairs/*.test.ts`.

---

## Code Conventions

- Follow existing patterns in the codebase. KISS, DRY, pure functions preferred. Delete dead code immediately. All code and identifiers in English.

---

## Architecture

| Module | Lines | Purpose |
|--------|-------|---------|
| `index.ts` | ~798 | 3-layer: tool_call (repair+validate) + tool_result (analytics+queue) + context (side-channel injection) |
| `repairs.ts` | ~87 | Thin barrel — re-exports from `repairs/*.ts` sub-modules |
| `repairs/*.ts` | 9 files | Path, array, classification, coercion, directory, timeout, guidance, cache, dispatch |
| `recorder.ts` | ~373 | JSONL persistence, aggregation, blindspot analysis |
| `recorder/classifier.ts` | ~115 | Error classification + `getToolHelp` (generic guidance for ALL tools) |
| `recorder/formatting.ts` | ~174 | Formatting helpers extracted from recorder.ts |
| `recorder/tracker.ts` | ~70 | Consecutive failure loop detection |
| `recorder/empty-search-tracker.ts` | ~160 | Empty search loop detection (find/grep/ls returning nothing) |
| `stats.ts` | ~173 | In-memory session stats + RepairToggle + parseRepairType + formatCacheInfo |
| `suggest-repairs.ts` | ~95 | Barrel + orchestrator — re-exports from `suggest-repairs/*.ts` |
| `suggest-repairs/*.ts` | 7 files | Types, LLM client, analysis, parsing, formatting, code-gen, issue |
| `handlers/commands.ts` | ~329 | All `/repair-*` command registrations |
| `handlers/utils.ts` | ~94 | Shared UI helpers + `summarizeRepairs` |
| `docs/repair-catalog.md` | — | Repair function catalog — source of truth for refactoring safety |

### Key Behavior

- **Guidance is one-shot and side-channeled.** Each kind fires once per session per `(kind, tool, input)`; subsequent identical errors pass through unchanged → cache hit. All guidance goes via the `context` event (deep copy), never `tool_result.content`. The model still sees guidance; the conversation prefix is preserved.
- **Circuit breaker** at 7+ consecutive failures forces strategy change. **Empty search loop detection** triggers after 3+ empty returns from find/grep/ls on the same concept. **Error classification** is pure pattern matching — no tool name dependency. **auto-evolution**: users submit Issues with correction patterns via zero-token GitHub Issue links. **Repair order**: classifyField → repairFieldValue (dispatch loop) → recurse into nested structures. Never touch content fields.

---

## Maintenance Notes

- Review AGENTS.md when architecture changes. Update commands when workflows change. Keep under 30 lines — move detail to separate docs if needed. Delete anything the agent can infer from code.
