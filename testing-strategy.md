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
| extension-integration | test-integration | 50% |

## Coverage Results
| Metric | Score | Threshold | Status |
|--------|-------|-----------|--------|
| Statements | 98.38% | 70% | ✅ PASS |
| Branches | 95.27% | 60% | ✅ PASS |
| Functions | 100% | 70% | ✅ PASS |
| Lines | 98.38% | 70% | ✅ PASS |

## Test Count (current)
| Test File | Tests | Mutations Target |
|-----------|-------|------------------|
| `repairs.test.ts` | 88 | 70% |
| `recorder.test.ts` | 70 | 70% |
| `stats.test.ts` | 23 | 50% |
| **Total** | **181** | — |

## Test Structure

### Unit Tests: repairs.test.ts (88 tests)
- **All repair functions** covered
- **TDD approach**: Tests written for critical business logic
- **No mocks**: Pure functions, no dependencies to mock
- **Edge cases**: Comprehensive boundary condition testing

### Unit Tests: recorder.test.ts (70 tests)
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
2. Set up Stryker for mutation testing
3. Add security scanning with ESLint
4. Set up CI/CD pipeline with GitHub Actions
