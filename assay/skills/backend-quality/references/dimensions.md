# Backend Quality Dimensions

Seven canonical dimensions for assessing backend architectural health. Each dimension is independently assessable — no dimension requires another's output to produce findings.

## DIM-1: Topology

**Definition:** The structural health of dependency graphs, wiring correctness, and state ownership. Topology violations create invisible coupling where modules behave differently depending on initialization order or runtime context.

**Invariants:**
- Every shared resource has a single source of truth for its lifecycle
- Dependencies are explicit (parameter/constructor injection), not ambient (module globals)
- No module silently creates degraded instances of shared resources

**Detectable Signals:**
- Module-global mutable state (`let moduleStore = ...` at file scope)
- Lazy fallback constructors (`if (!store) { store = new Store() }`)
- Manual wiring functions (`configureXxx()`, `registerXxx()`) without validation
- Divergent instances of the same resource across modules
- Circular dependency chains

**Severity Guide:**
- **HIGH:** Lazy fallback creates degraded instance silently (masks broken wiring)
- **MEDIUM:** Module-global mutable state without documented rationale
- **LOW:** Manual wiring that works but could be simplified

**Examples:**
- Violation: `getStore()` silently creates an in-memory store when the real store wasn't wired, causing events to be invisible across modules
- Healthy: Constructor injection where the absence of a dependency is a startup error, not a silent fallback

---

## DIM-2: Observability

**Definition:** The visibility of errors, failures, and system behavior. Observability violations hide problems, making bugs harder to find and diagnose. A system with poor observability may appear healthy while silently losing data.

**Invariants:**
- Every catch block either re-throws, logs with context, or has documented rationale for swallowing
- Error messages include what failed, why, and what to do about it
- Fallback behavior is visible (logged, metriced, or signaled), never silent

**Detectable Signals:**
- Empty catch blocks (`catch {}`, `catch (e) {}`)
- Catch blocks that only log without context (`catch (e) { console.log(e) }`)
- Silent fallbacks that switch behavior modes without signaling
- Missing error context (generic "something went wrong" messages)
- Swallowed promise rejections (`.catch(() => {})`)

**Severity Guide:**
- **HIGH:** Silent catch that masks data loss or incorrect behavior
- **MEDIUM:** Catch that logs but lacks actionable context
- **LOW:** Verbose error that could be more specific

**Examples:**
- Violation: `catch { mutableState._events = [] }` — silently resets state on error, hiding the failure
- Healthy: `catch (e) { throw new Error('Failed to load events from store', { cause: e }) }`

---

## DIM-3: Contracts

**Definition:** The integrity of schemas, APIs, and type boundaries. Contract violations occur when the actual runtime behavior diverges from the declared interface — fields removed from schemas but still read, breaking API changes without versioning, or type assertions that bypass safety.

**Invariants:**
- Every field read at runtime is present in the declared schema/type
- API changes are versioned or backward-compatible
- Type assertions (`as`, `!`) have validated preconditions

**Detectable Signals:**
- Schema fields removed but still accessed at runtime
- Zod/JSON schemas that don't match TypeScript types
- Unversioned breaking API changes
- Type assertions without guards (`value as Type` without `typeof`/`instanceof` check)
- Interface implementations that silently ignore new required members

**Severity Guide:**
- **HIGH:** Schema-runtime divergence (field removed from schema but read at runtime)
- **MEDIUM:** Type assertion without validation guard
- **LOW:** Overly permissive schema (accepts more than necessary)

**Examples:**
- Violation: `_events` removed from Zod schema but guard code still reads `state._events`, silently getting `undefined`
- Healthy: Schema changes accompanied by grep for all field references, with type system enforcing the change

---

## DIM-4: Test Fidelity

**Definition:** The degree to which tests exercise actual production behavior. Low test fidelity means tests can pass while the system is broken — the most dangerous kind of false confidence.

**Invariants:**
- Test setup matches production wiring (same instances, same initialization)
- Mocks are used only at true infrastructure boundaries (HTTP, DB, filesystem)
- Critical paths have integration tests, not just unit tests

**Detectable Signals:**
- Test setup creates different instances than production wiring
- More than 3 mocked dependencies in a single test (over-isolation)
- Unit tests for cross-cutting concerns that need integration tests
- Tests that assert on mock calls rather than observable behavior
- Test helpers that hide important setup details
- `describe.skip` or `it.skip` without tracked issue references

**Severity Guide:**
- **HIGH:** Test-production divergence on shared state (different instances)
- **MEDIUM:** Over-mocking hides real integration behavior
- **LOW:** Test naming doesn't follow conventions

**Examples:**
- Violation: All tests use the same EventStore instance for producer and consumer, but production has two separate instances that were never connected — 4192 tests pass, system is broken
- Healthy: Test creates the same wiring as production startup, catching initialization bugs

---

## DIM-5: Hygiene

**Definition:** The absence of dead code, vestigial patterns, and evolutionary leftovers. Poor hygiene increases cognitive load, hides the actual architecture, and provides misleading signals about what the system does.

**Invariants:**
- Every exported symbol has at least one consumer
- No commented-out code blocks (use version control instead)
- No divergent implementations of the same behavior

**Detectable Signals:**
- Unreachable code paths (after unconditional return/throw)
- Unused exports (exported but never imported)
- Commented-out code blocks (more than 3 lines)
- Feature flags for features that shipped long ago
- Duplicate implementations (same behavior in multiple places)
- Functions that are declared but never called

**Severity Guide:**
- **HIGH:** Divergent implementations causing inconsistent behavior
- **MEDIUM:** Dead code actively misleading about system behavior
- **LOW:** Minor unused exports or stale comments

**Examples:**
- Violation: `registerEventTools()` exists but is never called in production — vestigial from an earlier design that was refactored
- Healthy: Unused code removed, version history preserves it if needed

---

## DIM-6: Architecture

**Definition:** Compliance with fundamental design principles — SOLID, coupling/cohesion, dependency direction. Architecture violations make the system rigid, fragile, and resistant to change.

**Invariants:**
- Dependencies point inward (high-level modules don't depend on low-level details)
- No circular dependency chains between modules
- Each module has a single, well-defined responsibility
- Interfaces are at domain boundaries, not within a module

**Detectable Signals:**
- God objects (classes/modules with >10 public methods or >500 lines)
- Circular imports between modules
- Dependency inversion violations (core depends on infrastructure)
- Feature envy (method primarily uses another class's data)
- Shotgun surgery indicators (one change requires edits in >5 files)

**Severity Guide:**
- **HIGH:** Circular dependencies creating build or runtime issues
- **MEDIUM:** SOLID violations that resist planned changes
- **LOW:** Mild coupling that doesn't impede current work

**Examples:**
- Violation: Event store module imports from CLI module, creating a circular dependency that constrains refactoring
- Healthy: Event store depends on interfaces; CLI implements those interfaces

---

## DIM-7: Resilience

**Definition:** Operational robustness under stress, failure, and resource pressure. Resilience violations don't break normal operation but cause cascading failures under load, resource exhaustion, or partial outages.

**Invariants:**
- Every cache has a maximum size and eviction policy
- Every external call has a timeout
- Retry logic has bounded attempts and backoff
- Resource acquisition has corresponding release (open/close symmetry)

**Detectable Signals:**
- Unbounded caches (`Map` or `Set` that grows without limit)
- Missing timeouts on HTTP calls, database queries, or file operations
- Retry loops without maximum attempts
- Resource leaks (file handles, connections opened but not closed in error paths)
- Missing graceful degradation (all-or-nothing behavior)
- Synchronous blocking on I/O in async contexts

**Severity Guide:**
- **HIGH:** Unbounded resource growth that will eventually crash
- **MEDIUM:** Missing timeout that could hang indefinitely
- **LOW:** Suboptimal resource management that doesn't impact normal operation

**Examples:**
- Violation: In-memory cache grows without limit as events are processed, eventually exhausting heap
- Healthy: LRU cache with configurable max size, eviction logged for observability

---

## Dimension Independence

Each dimension can be assessed in isolation. However, some findings may span multiple dimensions:

- A lazy fallback constructor (DIM-1: Topology) may also be a silent error (DIM-2: Observability)
- Dead code (DIM-5: Hygiene) may also be a test fidelity issue if tests reference it (DIM-4)

When a finding spans dimensions, it should be reported under the **primary** dimension (the one most directly violated) with a cross-reference note. The `audit` skill handles deduplication when the same evidence appears under multiple dimensions.
