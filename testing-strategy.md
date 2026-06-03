---
version: 1
product_type: software
generated_by: cali-testing-ai-code
generated_at: 2026-05-27
---

# Testing Strategy for pi-tool-repair-layer

## Tech Stack
- Language: TypeScript
- Unit: Vitest
- Coverage: @vitest/coverage-v8
- Security: ESLint (recommended)

## Mutation Score Targets
| Path Type | Target | Minimum |
|-----------|--------|---------|
| Critical (repair functions) | 70% | 60% |
| Standard (extension logic) | 50% | 40% |

## Test Scopes
| Scope | Type | Mutation Target |
|-------|------|----------------|
| repair-functions | test-unit | 70% |
| barrel-contracts | test-contract | — (static) |
| handler-wiring | test-smoke | — (static) |
| extension-integration | test-integration | 50% |

## Coverage Results
| Metric | Score | Threshold | Status |
|--------|-------|-----------|--------|
| Statements | 98.11% | 70% | ✅ PASS |
| Branches | 96.01% | 60% | ✅ PASS |
| Functions | 100% | 70% | ✅ PASS |
| Lines | 98.11% | 70% | ✅ PASS |

## Test Count (current)
| Test File | Tests | Mutations Target |
|-----------|-------|------------------|
| `repairs.test.ts` | 252 (237 + 15 structural) | 70% |
| `recorder.test.ts` | 101 | 70% |
| `stats.test.ts` | 23 | 50% |
| `suggest-repairs.test.ts` | 21 | — |
| `repairs/barrel-contract.test.ts` | 24 | — (static) |
| `repairs/barrel-contract.test.ts` | 24 | — (contract + smoke) |
| **Total** | **469** | — |

## Test Structure

### Unit Tests: repairs.test.ts (252 tests)
- **237 behavioral tests**: All repair functions covered + edge cases
- **15 structural integrity tests**: Verificam que Fase 3/4 extração não foi revertida (v0 abaixo)
- **Fase 3 predicates**: `isBooleanField`, `looksLikeNumberField` (via `classifyField`)
- **Fase 4 dispatch table**: `repairDispatchers` lookup covers all 8 actions
- **Edit guidance**: `extractNonUniqueEditCount`, `findAllOldTextMatchLines`, `buildEditNonUniqueGuidance`, `buildEditWrongFileGuidance`, `extractFailedEditIndex`, `extractFailedEditPath`, `buildEditMismatchContext`, `buildEnhancedEditMismatchGuidance`
- **Constants**: all 8 sets from `repairs/constants.ts` tested indirectly via classifyField
- **No mocks**: Pure functions, no dependencies to mock
- **Edge cases**: Null/undefined inputs, boundary conditions, recovery

### Unit Tests: recorder.test.ts (101 tests)
- **I/O**: ensureDir, recordEvent, readSessionEvents, readAllEvents, pruneOldSessions, malformed JSON, fallback session ID
- **aggregateStats**: counts, byTool, byModel, byRepairType, byErrorType, empty input
- **extractRepairTypes**: known patterns, empty input, unrecognized patterns
- **computeBlindspots**: grouping, filtering, model tracking, sorting
- **formatSessionStats / formatGlobalStats / formatBlindspots**: empty states, completeness, percentages
- **classifyErrorType**: all 9 error categories plus edge cases (EISDIR, ENOENT, EACCES, timeout, rate_limit, bad_request, HTTP, EDIT_MISMATCH, SCHEMA_VALIDATION)
- **ConsecutiveFailureTracker** (7 tests): counting, arg-pattern reset, recordSuccess, per-tool isolation, threshold, reset
- **getToolHelp** (5 tests): bash/grep/find/ls/unknown

### Unit Tests: stats.test.ts (23 tests)
- createStats, recordRepairs, formatStats, repair history

### Unit Tests: suggest-repairs.test.ts (21 tests)
- gatherAnalysisData, extractJSON, parseSuggestions, formatSuggestions, parseIssueContent, buildIssueUrl, callLLM timeout

## Reference

**Repair function catalog:** `docs/repair-catalog.md` — source of truth for all repair functions, classification predicates, constants, and the dispatch table. Updated when functions are added or removed.

**README:** `README.md` — user-facing docs with 9 field-level repairs, 5 execution-aware features, and 8 error recovery guidance items.

**Test verification:** Before any refactoring, run `npx vitest run` (382 tests) and `npx vitest run --coverage` to verify no regressions.

## Anti-Patterns Avoided
- ❌ No mocks for simple functions (pure functions)
- ❌ No 100% coverage target (70% is sufficient)
- ❌ No snapshot tests for non-UI components
- ❌ No single-run validation (tests are deterministic)

## CI/CD Gates
```yaml
GATES:
  test_results:
    condition: "any_failure"
    action: BLOCK
    rationale: "All tests must pass before merge"
  
  coverage_threshold:
    condition: "below_70%"
    action: WARN
    rationale: "Critical paths need 70% coverage"
```

## Running Tests
```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run in watch mode
npm run test:watch
```

## Next Steps
1. Add integration tests for the extension itself (requires pi API mocking)
2. ✅ Barrel contract tests (`repairs/barrel-contract.test.ts` — 24 tests)
3. ✅ Handler wiring smoke tests (built into barrel-contract.test.ts)
4. Set up Stryker for mutation testing (deferred — see evaluation below)
5. Add security scanning with ESLint
6. Set up CI/CD pipeline with GitHub Actions
7. ✅ Repair catalog created at `docs/repair-catalog.md`
8. ✅ AGENTS.md updated with repair preservation instructions
9. ✅ Coverage gaps documented (normal pass-through branches)

## Mutation Testing Evaluation

**Veredito: Não implementar agora.**

| Fator | Nota | Justificativa |
|-------|------|---------------|
| Cobertura atual | 🟢 98% branch | Mutantes seriam mortos pelos testes existentes |
| Natureza do código | 🟢 Funções puras | Testes de borda já cobrem o que mutation revelaria |
| Custo de setup | 🔴 Alto | Stryker + ESM + CI time, ~2-5x mais lento |
| Risco real | 🟢 Baixo | 98% branch + 100% funções = poucos escapes |

**Reavaliar quando:** houver lógica com estado (cache distribuído, decisão multi-passo) ou cobertura cair abaixo de 85%.
