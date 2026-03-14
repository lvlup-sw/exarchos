# Resilience Checklist

Structured checklist for evaluating operational resilience. Each section covers a resilience concern with pass/fail criteria. Use during the qualitative assessment phase of the `harden` skill.

---

## Resource Management

Verify that every acquired resource has a corresponding release, and that long-lived collections are bounded.

| # | Check | Pass Criteria | Fail Criteria |
|---|-------|---------------|---------------|
| R-1 | Bounded caches | Every `Map`, `Set`, or array used as a cache has a documented max size and eviction policy (LRU, TTL, or explicit `.clear()` on lifecycle events) | Collection grows without limit; no `.delete()`, `.clear()`, or size check nearby |
| R-2 | Connection pools | Database and HTTP connections use pooling with max connections configured; pools are drained on shutdown | Connections opened per-request without pooling, or pool has no max size |
| R-3 | File handle lifecycle | File handles opened in `try` are closed in `finally` (or use `using`/`await using` with disposable pattern); error paths close handles too | File opened in try, closed only on success path; error path leaks the handle |
| R-4 | Event listener cleanup | Listeners registered with `.on()` or `.addEventListener()` are removed with `.off()` / `.removeEventListener()` when the owner is disposed | Listeners accumulate without removal, causing memory leaks and duplicate processing |
| R-5 | Stream lifecycle | Streams are `.end()`ed or `.destroy()`ed on both success and error paths; pipeline errors trigger cleanup | Stream left open on error, causing resource leak or hanging process |

---

## Timeout Patterns

Verify that every external call is bounded by a timeout.

| # | Check | Pass Criteria | Fail Criteria |
|---|-------|---------------|---------------|
| T-1 | HTTP timeout | Every `fetch()` or HTTP client call has a `signal` (AbortController) or `timeout` option configured | `fetch()` called without timeout; could hang indefinitely on network issues |
| T-2 | Database query timeout | Database queries have statement-level or connection-level timeouts configured | Queries can run unbounded; a slow query blocks the connection pool |
| T-3 | File system timeout | Long-running file operations (directory walks, large reads) have either a timeout or are chunked | Unbounded `readdir` on large directories or `readFile` on potentially huge files |
| T-4 | AbortController usage | AbortController signals are wired correctly — controller created, signal passed, abort called on timeout/cancellation | AbortController created but signal never passed to the operation, or abort never called |
| T-5 | IPC/subprocess timeout | Child processes and IPC calls have timeouts; hung processes are killed | `child_process.exec` without timeout; process could hang forever |

---

## Retry Patterns

Verify that retry logic is bounded and uses appropriate backoff.

| # | Check | Pass Criteria | Fail Criteria |
|---|-------|---------------|---------------|
| Y-1 | Maximum attempts | Every retry loop has a configured max attempt count (typically 3-5 for transient failures) | `while (true) { try ... catch { continue } }` with no attempt counter |
| Y-2 | Exponential backoff | Retry delays increase exponentially (e.g., 100ms, 200ms, 400ms, 800ms) rather than fixed intervals | Fixed delay between retries (e.g., always `sleep(1000)`) or no delay at all |
| Y-3 | Jitter | Retry delays include random jitter to prevent thundering herd on shared resources | All instances retry at exactly the same intervals, causing load spikes |
| Y-4 | Circuit breaker | For services with sustained failures, a circuit breaker stops retrying and fails fast after N consecutive failures | System retries indefinitely against a down service, wasting resources and delaying fallback |
| Y-5 | Idempotency awareness | Retried operations are safe to repeat (idempotent) or use deduplication keys | Non-idempotent operations (e.g., payment charges) retried without deduplication |

---

## Concurrency Safety

Verify that concurrent access to shared state is safe.

| # | Check | Pass Criteria | Fail Criteria |
|---|-------|---------------|---------------|
| C-1 | Mutex / lock patterns | Shared mutable state accessed by concurrent operations is protected by a mutex, lock, or serialization queue | Two async operations can interleave reads and writes to the same state |
| C-2 | Compare-and-swap (CAS) | State updates that depend on current value use CAS or optimistic locking patterns | Read-then-write without checking that the value hasn't changed between read and write |
| C-3 | Single-instance guards | Operations that must run exactly once (initialization, migration) have guard mechanisms (flags, locks, or idempotency checks) | Initialization can run concurrently from two entry points, causing duplicate setup or race conditions |
| C-4 | Async iteration safety | Collections are not mutated during async iteration (`for await ... of`) | Array/Map modified while being iterated, causing skipped or duplicate items |
| C-5 | Promise.all error handling | `Promise.all` failures are handled (consider `Promise.allSettled` when partial success is acceptable) | One rejection in `Promise.all` causes all results to be lost; no partial success handling |

---

## Graceful Degradation

Verify that the system handles partial failures without cascading collapse.

| # | Check | Pass Criteria | Fail Criteria |
|---|-------|---------------|---------------|
| G-1 | Partial failure tolerance | System continues operating when a non-critical subsystem fails; critical path is isolated from optional features | Single subsystem failure takes down the entire system |
| G-2 | Feature flags for degraded mode | Degraded behavior can be toggled via configuration without code deployment; operators can disable failing features | Degraded mode requires a code change and redeployment to activate |
| G-3 | Health check accuracy | Health endpoints reflect actual system state, including degraded subsystems | Health check returns "healthy" while a critical subsystem is down |
| G-4 | Bulkhead isolation | Independent request paths don't share failure domains; one slow endpoint doesn't block others | All requests share a single thread pool or connection pool; one slow path starves others |
| G-5 | Load shedding | System rejects excess load with clear error (429/503) rather than accepting and timing out | System accepts all requests regardless of capacity, causing timeouts and cascading failures |

---

## How to Use This Checklist

1. **Scope:** Apply to the files/modules specified in the harden skill invocation
2. **Evaluate:** For each check, determine Pass or Fail based on the criteria
3. **Report:** Failed checks become findings with the severity from the corresponding dimension (DIM-7 for resource/timeout/retry/concurrency, DIM-2 for degradation visibility)
4. **Prioritize:** HIGH findings (unbounded growth, missing timeouts on critical paths, no retry limits) before MEDIUM (suboptimal patterns that don't risk failure)
