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

## Coverage Results (2026-05-27)
| Metric | Score | Threshold | Status |
|--------|-------|-----------|--------|
| Statements | 98.38% | 70% | ✅ PASS |
| Branches | 95.27% | 60% | ✅ PASS |
| Functions | 100% | 70% | ✅ PASS |
| Lines | 98.38% | 70% | ✅ PASS |

## Test Structure

### Unit Tests (repairs.test.ts)
- **64 test cases** covering all repair functions
- **TDD approach**: Tests written for critical business logic
- **No mocks**: Pure functions, no dependencies to mock
- **Edge cases**: Comprehensive boundary condition testing

### Test Categories
1. **Path Repair Tests** (9 tests)
   - Markdown link unwrapping
   - Path normalization
   - ~/ path resolution

2. **JSON Parse Tests** (5 tests)
   - Array/object string parsing
   - Invalid JSON handling
   - Primitive rejection

3. **Array Wrap Tests** (8 tests)
   - Bare value wrapping
   - Object wrapping
   - Null/undefined handling

4. **Relational Defaults Tests** (4 tests)
   - read_file offset/limit defaults
   - No-op when both present

5. **Field Classification Tests** (10 tests)
   - Path field detection
   - Content field exclusion
   - Boolean/number field detection

6. **Null-Like String Tests** (3 tests)
   - Null/none/n/a detection
   - False positive prevention

7. **String Split Tests** (9 tests)
   - Comma/space splitting
   - JSON/path/URL exclusion

8. **Boolean Coercion Tests** (6 tests)
   - Truthy/falsy string coercion
   - Case insensitivity
   - Unknown string handling

9. **Number Coercion Tests** (6 tests)
   - Integer/decimal coercion
   - Ambiguous string rejection
   - Edge case handling

10. **Content Field Detection Tests** (2 tests)
    - Content field identification
    - Non-content field exclusion

11. **Number Field Detection Tests** (2 tests)
    - Number field identification
    - Non-number field exclusion

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
