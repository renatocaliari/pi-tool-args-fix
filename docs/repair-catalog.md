# Repair Function Catalog

**Source of truth for all functions in this extension.** Organized by category to match the README.
Agents should use this catalog to preserve functionality during refactoring and to verify test coverage.

---

## 1. Field-Level Repairs (repairs.ts)

9 structural repairs in the `classifyField` → `repairFieldValue` dispatch pipeline.
Ordered by execution priority.

| # | Action | Dispatcher | Core Function(s) | README # | Tests |
|---|--------|------------|-------------------|----------|-------|
| 1 | `clean-path` | `dispatchCleanPath` | `unwrapMarkdownLink`, `cleanPathValue` | #1 | ✅ |
| 2 | `parse-json` | `dispatchParseJson` | `tryParseJsonString` | #2 | ✅ |
| 3 | `wrap-object-as-array` | `dispatchWrapObjectAsArray` | `wrapObjectAsArrayIfNeeded` | #3 | ✅ |
| 4 | `wrap-array` | `dispatchWrapArray` | `wrapAsArrayIfNeeded` | #4 | ✅ |
| 5 | `split-string-to-array` | `dispatchSplitStringToArray` | `trySplitStringToArray` | #5 | ✅ |
| 6 | `strip-extra-properties` | `dispatchStripExtraProperties` | `stripExtraPropertiesFromItems` | #6 | ✅ |
| 7 | — (inline in `classifyField`) | — | `isNullLikeString` → strip null fields | #7 | ✅ |
| 8 | `coerce-boolean` | `dispatchCoerceBoolean` | `coerceToBoolean`, `TRUTHY_STRINGS`, `FALSY_STRINGS` | #8 | ✅ |
| 9 | `coerce-number` | `dispatchCoerceNumber` | `coerceToNumber`, `NUMBER_FIELD_NAMES` | #9 | ✅ |

### Classification Predicates

| Predicate | Used By | Extracted OR-Chain |
|---|---|---|
| `isArrayLike` | `classifyField` | `ARRAY_NAMES` + `_list` / `list` / `_names` / `names` / `_items` / `items` / `_array` / `array` |
| `isBooleanField` | `classifyField` | `BOOLEAN_NAMES` + `is_` / `has_` / `can_` / `_flag` |
| `looksLikeNumberField` | `classifyField` | `NUMBER_NAMES` + `max` / `min` / `_count` / `_size` / `_index` |

### Dispatch Table

```typescript
const repairDispatchers = {
  "clean-path": dispatchCleanPath,
  "parse-json": dispatchParseJson,
  "wrap-object-as-array": dispatchWrapObjectAsArray,
  "wrap-array": dispatchWrapArray,
  "split-string-to-array": dispatchSplitStringToArray,
  "coerce-boolean": dispatchCoerceBoolean,
  "coerce-number": dispatchCoerceNumber,
  "strip-extra-properties": dispatchStripExtraProperties,
} as const;
```

### Schema-Aware Strip

`ARRAY_ITEM_SCHEMAS` controls which properties are allowed per field:

| Field | Allowed Properties |
|---|---|
| `edits` | `oldText`, `newText` |
| `replacements` | `path`, `symbol`, `text` |
| `files` | `path`, `edits`, `replacements` |
| `tasks` | `agent`, `task`, `count`, `output`, `outputMode`, `reads`, `progress`, `model`, `skill`, `cwd` |
| `steps` | `agent`, `task`, `output`, `outputMode`, `reads`, `progress`, `model`, `skill`, `cwd` |
| `commands` | `label`, `command` |

---

## 2. Execution-Aware Features (repairs.ts + index.ts)

Runtime adjustments — not field repairs, but automatic safety nets.

| Feature | Function(s) | When |
|---------|-------------|------|
| **Relational defaults** | `applyRelationalDefaults` | Tool has `limit` but missing `offset` |
| **Directory fallback** | `isEisdirError`, `formatDirectoryListing`, `extractTextContent` | `read`/`read_file` on a directory |
| **Write directory fallback** | `formatDirectoryListing` | `write` to a path without extension |
| **Content hash staleness** | `ContentHashCache`, `simpleHash` | After every successful `read`/`read_file` |
| **ContentHashCache after edit/write** | `ContentHashCache`, `updateCacheFromFile` | After successful `edit`/`edit_file`/`write` — prevents false-positive staleness on sequential edits |
| **Empty result detection** | — (inline in `detectEmptyResult`) | Tool returns success with no content |
| **Path validation (non-bash)** | `resolvePath`, `extractPathsFromArgs`, `isUrlOrFlag` | Blocks tool with guidance on ENOENT |
| **Path guidance (bash)** | `resolvePath`, `extractPathsFromArgs` | Queues guidance on ENOENT, does NOT block |
| **Auto-timeout** | `isLongRunningCommand`, `suggestAutoTimeout` | Detectable long-running commands |
| **Priority-based guidance cap** | `getGuidancePriority` | When guidance exceeds 2000-char cap, drops lowest-priority items first (circuit breaker > staleness > tool help) |

---

## 3. Error Recovery Guidance (repairs.ts)

Context-aware help injected on tool failures, driven by `getToolHelp` + `getErrorGuidance` in classifier.

| Guidance | Function(s) | Error Type |
|----------|-------------|------------|
| **Edit mismatch context** | `buildEditMismatchContext`, `buildEnhancedEditMismatchGuidance` | `EDIT_MISMATCH` |
| **Edit non-unique oldText** | `extractNonUniqueEditCount`, `findAllOldTextMatchLines`, `buildEditNonUniqueGuidance` | `EDIT_MISMATCH` (non-unique) |
| **Edit wrong file** | `extractFailedEditIndex`, `extractFailedEditPath`, `buildEditWrongFileGuidance` | `EDIT_MISMATCH` (wrong file) |
| **Sequential edit overlap** | `buildSequentialEditGuidance` | `EDIT_MISMATCH` (pre-flight) |
| **Circuit breaker** | `buildCircuitBreakMessage`, `buildEditLoopGuidance` | `CONSECUTIVE_LOOP` |
| **Staleness** | `buildStalenessGuidance` | `EDIT_MISMATCH` (stale file) |
| **Path validation** | `buildPathValidationGuidance` | `ENOENT` |
| **Empty search loop** | `buildEmptySearchGuidance` | `EMPTY_RESULT` (find/grep/ls) |

---

## 4. Constants (repairs/constants.ts)

| Set | Values | Purpose |
|---|---|---|
| `PATH_FIELD_NAMES` | 8 names | Trigger `clean-path` repair |
| `ARRAY_FIELD_NAMES` | 32 names | Trigger array wrapping/splitting |
| `BOOLEAN_FIELD_NAMES` | 17 names | Trigger boolean coercion |
| `CONTENT_FIELD_NAMES` | 18 names | Protected — never repaired |
| `NUMBER_FIELD_NAMES` | 20 names | Trigger number coercion |
| `FALSY_STRINGS` | 7 values | Map `"false"` / `"no"` → false |
| `TRUTHY_STRINGS` | 7 values | Map `"true"` / `"yes"` → true |
| `LONG_RUNNING_TOKENS` | 18 regexes | Auto-timeout suppression |

---

## 5. Empty Search Loop Detection (recorder/empty-search-tracker.ts)

| Method | Purpose |
|--------|---------|
| `recordEmpty(pattern)` | Record an empty search result; increments concept-based counter |
| `recordFound()` | Reset ALL counters (single hit breaks any loop) |
| `getCount(pattern)` | Current consecutive empty count for this concept |
| `isInEmptyLoop(pattern)` | True when 3+ empties on this concept |
| `reset()` | Clear all state |

**Key design:** Counts are keyed by **concept** (not tool + pattern). find "NavUnifiedDropdown" then grep "nav_unified_drop" share one count via 4-char fragment overlap. `recordFound()` resets all state.

**Integration:** Phase 2.5 in the `tool_result` handler (`index.ts`). Injects `buildEmptySearchGuidance()` at 3+ consecutive empties before Phase 3 runs.

## 6. Stats & Recording

| Module | Key Exports | Purpose |
|--------|-------------|---------|
| `stats.ts` | `RepairToggle`, `parseRepairType`, `createStats`, `recordRepairs`, `formatStats` | Session stats |
| `recorder.ts` | `RepairEvent`, `AggregateStats`, `Blindspot` types + log I/O, aggregation, blindspot detection | JSONL persistence |
| `recorder/classifier.ts` | `classifyErrorType`, `getToolHelp`, `getErrorGuidance` | Error classification + help text |
| `recorder/tracker.ts` | `ConsecutiveFailureTracker` | Loop detection |
| `recorder/empty-search-tracker.ts` | `ConsecutiveEmptySearchTracker` | Empty search loop detection |
| `recorder/formatting.ts` | `formatExample`, `formatSessionStats`, `formatGlobalStats`, `formatBlindspots` | Output formatting |

---

## Structural Integrity Tests

**Purpose:** Prevent regression back to inline architecture. These tests verify that the extracted
dispatch table and predicates survive refactoring.

| Group | Tests | What It Verifies |
|---|---|---|
| Fase 3 predicates | 3 | `classifyField` calls `isBooleanField()`, `looksLikeNumberField()`, `isArrayLike()` — not inline OR-chain |
| Fase 4 dispatch table | 3 | `repairFieldValue` uses `repairDispatchers[...]` lookup, not `switch`; `classifyField` has no inline boolean/number OR-chain tokens |
| Constants barrel | 8 | All 8 constant sets re-exported from `repairs/constants.ts` |
| Dispatch completeness | 1 | All 9 action strings from `classifyField` are producible and actionable |

**Total: 15 structural integrity tests** in `repairs.test.ts`.

## Coverage Map

| Module | Coverage (Statements) | Coverage (Branches) | Gaps |
|---|---|---|---|
| `repairs.ts` | 97.9% | 95.68% | Normal pass-through branches (no repair needed → returns input unchanged) |
| `stats.ts` | 100% | 100% | None |
| `recorder.ts` | ~95% | ~92% | None |
| Overall | 98.11% | 96.01% | No untested repair logic |
