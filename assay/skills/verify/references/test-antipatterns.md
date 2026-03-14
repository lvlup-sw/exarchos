# Test Antipatterns

Catalog of test quality problems that create false confidence. Each pattern includes detection heuristics and severity guidance.

## Test-Production Divergence Patterns

Test-production divergence is the most dangerous test antipattern: tests exercise a system topology that does not exist in production. Four primary divergence vectors:

### Different Instances

Tests create their own instances of shared resources rather than using the same wiring as production. The test passes because it talks to itself; production fails because modules talk to separate, disconnected instances.

**Detection:** Compare `new Resource()` or factory calls in test setup against production initialization. If tests create instances that production does not, the test exercises a phantom path.

**Severity:** HIGH when the divergent instance manages shared state (event stores, caches, connection pools). MEDIUM when the instance is stateless but has different configuration.

### Different Initialization Order

Tests initialize dependencies in a different order than production startup. This masks timing bugs, race conditions, and initialization-dependent behavior.

**Detection:** Compare the sequence of setup calls in test `beforeEach`/`beforeAll` against the production bootstrap function. Order differences in stateful systems are bugs waiting to happen.

**Severity:** HIGH when initialization order affects state (e.g., registering handlers before vs after store initialization). LOW when order is truly independent.

### Different Configuration

Tests use different configuration values — different timeouts, different feature flags, different environment variables — creating a parallel universe where the system behaves differently than production.

**Detection:** Look for hardcoded values in test setup that differ from production defaults. `process.env` overrides in tests are a common vector.

**Severity:** MEDIUM for most configuration differences. HIGH when the configuration controls behavioral branching (feature flags, mode switches).

### Different Wiring

Tests wire dependencies differently than production — injecting mocks where production uses real implementations, or connecting modules that production leaves disconnected.

**Detection:** Compare the dependency graph in test setup against the production composition root. Every mock is a divergence point; every missing connection is a gap.

**Severity:** HIGH when the wiring difference affects the code path under test. LOW when the wiring difference is in an unrelated subsystem.

---

## Mock Overuse Taxonomy

Not all mocks are equal. The distinction between productive and harmful mocking lies in where the mock boundary sits.

### Mocking at Infrastructure Boundaries (Appropriate)

Mocks at true infrastructure boundaries — HTTP clients, database drivers, filesystem operations, external service calls — are productive. These boundaries are slow, flaky, and outside the system's control. Mocking them is a pragmatic tradeoff.

**Guideline:** If the dependency crosses a network, disk, or process boundary, mocking is appropriate.

### Mocking Collaborators (Smell)

Mocking collaborators — other classes and modules within the same system — is a design smell. It means the test is asserting on implementation details rather than observable behavior. When you refactor the internals, these tests break even though behavior is preserved.

**Guideline:** If the dependency is an in-process collaborator, prefer using the real implementation. If the real implementation is hard to construct, that is a design feedback signal (see "mock-as-design-crutch" below).

### Mock-as-Design-Crutch

When a class requires so many collaborators that testing without mocks is impractical, the mocks are compensating for a design problem. The class has too many responsibilities, too many dependencies, or both. The difficulty of testing is the design telling you something.

**Detection:** More than 3 mocked dependencies in a single test file. Constructor parameter counts exceeding 5. Test setup that is longer than the test itself.

**Severity:** MEDIUM. The mocks are a symptom; the disease is the design.

### Mock-as-Implementation-Detail-Test

Tests that assert on mock call counts, argument order, or internal delegation patterns are testing implementation, not behavior. These tests are maximally fragile: any refactoring breaks them, but no behavior change does.

**Detection:** Assertions like `expect(mock).toHaveBeenCalledTimes(3)`, `expect(mock).toHaveBeenCalledWith(...)` without also asserting on the observable output.

**Severity:** MEDIUM when the mock assertion is the only assertion. LOW when it supplements a behavioral assertion.

---

## The Sociable Test Preference

A sociable test uses real collaborators instead of mocks. It tests the unit through its natural interactions with its immediate dependencies. Sociable tests catch integration bugs that isolated tests miss, while remaining faster and more focused than full integration tests.

**When to prefer sociable tests:**
- The collaborator is deterministic and fast
- The collaborator is in the same bounded context
- The interaction between unit and collaborator is the interesting behavior
- The collaborator is easy to construct with test data

**When isolation (mocking) is still warranted:**
- The collaborator is non-deterministic (time, randomness, external state)
- The collaborator is slow (network, disk, heavy computation)
- The collaborator has side effects that are hard to observe or clean up
- You need to test error paths that the real collaborator rarely produces

---

## Test Isolation Pitfalls

### Tests That Pass in Isolation but Fail Together

Shared mutable state between tests — module-level variables, singleton caches, uncleared event listeners — causes test-order dependencies. Each test assumes a clean state but inherits side effects from previous tests.

**Detection:** Run tests in random order. If failures appear that don't appear in alphabetical order, shared state is leaking.

**Severity:** MEDIUM. Tests are unreliable, but the production code may be fine.

### Tests That Pass Together but Fail in Isolation

Tests that depend on setup performed by earlier tests — database seeding, module initialization, global state set by a "first" test — are coupled in ways that are invisible from the test file.

**Detection:** Run a single test file in isolation. If it fails, it depends on external setup.

**Severity:** MEDIUM. The test communicates less than it should about its preconditions.

---

## False Confidence Indicators

Signs that a test suite generates confidence without warranting it:

### High Coverage, Low Bug Detection

Coverage measures which lines executed, not whether assertions verified behavior. A test that calls a function without asserting on its return value achieves coverage without providing protection. If coverage is above 90% but bugs are still found in production, the tests are exercising code without verifying it.

**Detection:** Look for tests with no assertions, tests that assert only on `toBeDefined()` or `toBeTruthy()`, tests where the assertion is on a mock call rather than an output.

**Severity:** MEDIUM. The coverage number is actively misleading.

### Tests That Assert Mock Calls Instead of Behavior

When every assertion in a test file is about what mocks were called with, the test suite is a specification of the current implementation, not of the desired behavior. Refactoring becomes impossible without rewriting tests.

**Detection:** Count assertions on mock objects vs assertions on return values or state changes. If mock assertions dominate, the suite tests implementation.

**Severity:** MEDIUM when mocks are the primary assertion mechanism. LOW when mock assertions supplement behavioral assertions.

### Tautological Tests

Tests that effectively assert that the code does what it does — testing that a function returns what it returns, or that a mock returns the value it was configured to return. These tests can never fail (unless the language runtime breaks) and provide zero protection.

**Detection:** The test's expected value is derived from the same code path as the actual value. The mock's return value is the same as the assertion's expected value.

**Severity:** LOW individually, but HIGH in aggregate when they inflate test counts and coverage.

---

## Severity Summary

| Pattern | Default Severity | Escalation Condition |
|---------|-----------------|---------------------|
| Different instances (shared state) | HIGH | Always HIGH for stateful resources |
| Different instances (stateless) | MEDIUM | — |
| Different initialization order | HIGH/LOW | HIGH when order-dependent state involved |
| Different configuration | MEDIUM | HIGH for behavioral branching config |
| Different wiring | HIGH/LOW | HIGH when wiring affects code under test |
| Mocking at boundaries | N/A | Appropriate — not a finding |
| Mocking collaborators | MEDIUM | HIGH when collaborator interaction is the SUT |
| Mock-as-design-crutch | MEDIUM | — |
| Mock-as-implementation-detail | MEDIUM/LOW | MEDIUM when sole assertion |
| Tests pass alone, fail together | MEDIUM | — |
| Tests fail alone, pass together | MEDIUM | — |
| High coverage, low detection | MEDIUM | — |
| Tautological tests | LOW | HIGH in aggregate |
