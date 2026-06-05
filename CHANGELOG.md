# Changelog

All notable changes to `pi-tool-repair-layer` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.0-alpha] - 2026-06-05

### Removed (breaking)

- **Cache cost tracking** — LLM pricing is volatile; static cost data
  would lie to the user the moment a provider changes pricing. Tokens
  are immutable and technically precise.
  - `prices/` directory deleted (`data_slim.json` + `lookup.ts`,
    ~200KB total)
  - `formatCacheInfo()` no longer emits dollar amounts, only tokens
    + hit rate + cache reads/writes
  - `/repair-cache-info` command output simplified accordingly
  - `stats.test.ts` expectations aligned

### Fixed

- **Toggle ON/OFF contract** — the toggle did not actually stop
  repair mutations or guidance injection in all paths.
  - `tool_call` when OFF: now early-returns with `repairSkipped=true`
    and `wouldHaveRepaired=[...]`. `event.input` is never mutated;
    no path validation / staleness / sequential overlap blocks fire.
  - `tool_result` when OFF: skips guidance queueing but still records
    analytics + JSONL events with `repairSkipped=true`.
  - `context` when OFF: clears `pendingGuidance` and returns
    `undefined` — zero LLM message injection.
  - Cache stats (`cacheRead/Write/Input`) continue accumulating when
    OFF, matching spec "off = disable repair/guidance but keep
    analytics/logs".
  - **Toolchain cleanup** — fixed 4 TypeScript strict errors left
    behind during the toggle refactor (unused imports `aggregateStats`
    and `repairObjectFieldsWithTrace`, unused destructure
    `repairSummary`, double-clone in OFF branch). Vitest does not
    catch these; `tsc --noEmit` does.

- **`summarizeRepairs` null-strip detection** — pre-fix bug: function
  only emitted `stripped null` for keys in `repaired` but not in
  `original` (i.e., ADDED keys, mislabeled). The actual case (key
  in original but not in repaired = stripped) was never detected.
  This made `finalRepairSummary` empty for the most common repair
  (null-strip on optional fields), so the repair notice never fired.
  Post-fix: two-pass iteration properly detects stripped, added, and
  changed keys.

- **`parsed JSON string → array` mislabel** — branch fired for ANY
  string→array, including `"single.txt"` → `["single.txt"]`. Now
  sniffs the source: JSON-like if it trims to start with `[`, `{`,
  or `"` and end with its matching close. Otherwise → `wrapped
  bare → array`. KISS bracket sniff, no `JSON.parse`.

### Changed (perf)

- **Cache-stable dedup keys for guidance notices** — weak keys
  replaced with content-based ones to reduce LLM prefix cache misses
  and prevent false dedup of legitimately different repairs.
  - `repair:` notice key: `${toolName}:${originalJson.length}` (weak,
    byte-length) → `${toolName}:${sortedSummary.join("|")}` (summary-
    based, sort-stable).
  - `edit-mismatch:` key: `${toolName}:${errorText.slice(0, 60)}`
    (weak, first 60 chars) → `${toolName}:${fnv1a(errorText.trim())}`
    (full text, FNV-1a 32-bit hash).
  - Added `fnv1a()` helper (no new deps, ~7-char base-36 output).
  - **Impact**: same kind of repair = same key = one guidance per
    session (cache hit). Different kind of repair = different key =
    LLM gets the right hint each time. Null-strip is now visible to
    the LLM for the first time (was silently suppressed before).

### DRY

- Reciprocal "MUST mirror" comments in `repairs/dispatch.ts` and
  `handlers/utils.ts` flag the coupling between strip rules and
  their classification. New strip rule in one place requires mirror
  in the other.

### Tests

- 17 new tests (542 total, all passing):
  - `handlers/utils.test.ts` (15): stripped detection, added/changed
    detection, JSON-like sniff, cache-key stability, nested prefix
  - `extension-integration.test.ts` (2): same summary dedup,
    different summary no-dedup
- Restored 3 tests lost in previous cleanup: `repairSkipped=true` in
  OFF event log, cache stats accumulate when OFF, eventSeq
  monotonicity (analytics integrity guard).

## [1.7.1-alpha] - 2026-06-04

### Added

- **LLM cache hit rate tracking** (`stats.ts`)
  - Accumulates `usage.cacheRead`, `usage.cacheWrite`, `usage.input` from
    assistant messages during the `context` event
  - Read-only — does not modify any messages
  - Per Claude's docs: "We run alerts on our prompt cache hit rate and
    declare SEVs if they're too low." Same metric, exposed via the
    extension
- **`/repair-cache-info` enhanced** (commands.ts)
  - Shows total input, cache reads, cache writes, uncached input
  - Calculates hit rate as a percentage
  - Cost estimate: based on Anthropic pricing (cache reads at 10%,
    writes at 125%, uncached at 100% of base)
  - Shows guidance injection count and the 4-rule cache-safety contract
- **4-rule cache-safety contract** documented in `AGENTS.md` and
  `docs/cache-safety.md`
  - Replaces the over-strict "never modify `tool_result.content`" rule
  - Rules: static cutoff + one-shot + byte-deterministic + stable position
  - Coexistence notes: documents how this extension composes safely with
    `condensed-milk`, `pi-tscg`, `pi-rtk`, `filter-output` (all follow
    the same 4-rule pattern)
  - Per Anthropic skill best practices and Microsoft Learn skills guidance

### Verification

```
Tests:                530 passed (20 files)
AGENTS.md validator:  13/13 rules passed
Stack conflict:       identical to v1.7.0-alpha (0 new event hooks)
```

## [1.7.0-alpha] - 2026-06-04

### Added

- **Cache-safety regression tests** (`repairs.test.ts` — 7 new tests)
  - `tool_result` returns `undefined` for all normal flows (no `event.content` mutation)
  - `context` returns a new array reference; original `event.messages` is byte-identical
  - Original message elements are never mutated (shallow-copy + push-only invariant)
  - `write-directory-fallback` (Phase 6) pinned as the ONE documented exception
- **Fake `ExtensionAPI` integration tests** (`extension-integration.test.ts` — 18 new tests)
  - Handler registration contract (session_start, session_shutdown, tool_call, tool_result, context)
  - Full lifecycle flow: session_start → tool_call → tool_result → context
  - One-shot guidance injection per `(tool, error)` per session
  - Survival under empty / malformed events
- **Test coverage guard** (`repairs/test-coverage.test.ts` — 19 new tests)
  - Every exported function/class/const-fn in `repairs/*.ts` is referenced in its colocated `.test.ts`
  - Summary: 100% reference rate across all 9 sub-modules
- **Catalog drift guard** (`repairs/catalog-drift.test.ts` — 7 new tests)
  - `docs/repair-catalog.md` ⇄ `repairs/dispatch.ts` + `repairs/classification.ts` consistency
  - 9 action rows in catalog, 8 dispatchers in dispatch table, 3 classification predicates
- **Pre-commit hook** (`scripts/hooks/pre-commit`)
  - Runs `vitest run --reporter=dot` on staged TS/JSON/MD changes
  - Bypass with `git commit --no-verify`
  - Install: `npm run setup:hooks` (configures `core.hooksPath`)
- **`docs/cache-safety.md`** — new reference doc
  - The WHY of the 3-layer design: shallow-copy invariant, push-only contract
  - Why shallow copy (not deep copy): cost trade-off + invariant pins the contract
  - One documented exception: write-directory-fallback (cache impact = 0)
- **`docs/architecture.md`** — new reference doc
  - The HOW: module map, 9 repairs in execution order, 3 classification predicates
  - 8-entry dispatch table, tool_call/tool_result phase layout
  - Event flow example: failed bash command end-to-end
- **Periodic review prompt** in AGENTS.md — `<!-- Last validated: YYYY-MM-DD -->` comment for staleness tracking

### Changed

- **`AGENTS.md` rewritten** (91 → 70 lines, 13/13 validator rules pass)
  - Line target: 20-30 → 70-100 (sweet spot per Augment Code, ETH Zurich, aihackers.net)
  - Added References section with progressive-disclosure pointers
  - Added exact stack versions (TypeScript 5.7, Vitest 3.1.1)
- **`README.md` doc sync**
  - Test count badge: 479 → 530
  - File structure: 17 → 20 test files
  - "deep copy" → "shallow copy" (4 occurrences) — accurate to actual code
  - Architecture diagram updated to show "push only" invariant
  - Cache Strategy section rewritten with shallow-copy mental model
  - Contributing section: added "Development Setup" + "Cache-Safety Guards" subsections
- **`index.ts` comment fixes** (2 occurrences of "deep copy" → "shallow copy")
  - Top-of-file comment: "shallow-copied messages"
  - `context` handler inline: documents the push-only invariant with pointer to regression test
- **`.gitignore_global`** (user-level) — added `.opencode/`, `.pi/`, `.claude/`, `.gemini/`
  - Affects all future projects; existing tracked files need `git rm --cached`

### Verification

```
Tests:                530 passed (20 files)
AGENTS.md validator:  13/13 rules passed
Cache-safety:         tool_result undefined (all normal flows)
                      context new array ref, original untouched
Stack conflict:       identical to v1.6.1-alpha (0 new event hooks)
```

## [1.6.1-alpha] - 2026-06-03

### Fixed

- AGENTS.md validation: cache preservation principle now self-references `context` event
  side channel correctly
