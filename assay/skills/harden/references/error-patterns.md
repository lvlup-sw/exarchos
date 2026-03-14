# Error Patterns Reference

Taxonomy of error handling patterns, anti-patterns, and severity guidance for the `harden` skill. Use this reference when classifying catch blocks and evaluating error propagation.

## Silent Catch Taxonomy

Four categories of catch block behavior, ordered from most dangerous to least:

### 1. Empty Catch (Severity: HIGH)

```typescript
// Pattern: catch body is empty or contains only whitespace
try { riskyOperation(); } catch (e) {}
try { riskyOperation(); } catch { }
```

**Why it matters:** Errors are completely invisible. The operation appears to succeed when it failed. Downstream code operates on incorrect assumptions.

**Action:** Must add error handling. At minimum, log with context and re-throw if the caller needs to know.

### 2. Log-Only (Severity: MEDIUM)

```typescript
// Pattern: catch logs but takes no corrective action
try { riskyOperation(); } catch (e) { console.log(e); }
try { riskyOperation(); } catch (e) { logger.warn('failed', e); }
```

**Why it matters:** The error is visible in logs but the system continues as if nothing happened. If the operation was important, downstream code operates on stale or missing data.

**Action:** Evaluate whether the operation needs recovery. If yes, add recovery logic. If the operation is truly optional, document why in a comment.

### 3. Swallow-and-Default (Severity: MEDIUM to HIGH)

```typescript
// Pattern: catch replaces the result with a default value
try { config = loadConfig(); } catch { config = DEFAULT_CONFIG; }
try { data = fetchRemote(); } catch { data = cachedData; }
```

**Why it matters:** The system silently switches to degraded behavior. The operator has no visibility into the fallback. If the default is incorrect or stale, the system produces wrong results while appearing healthy.

**Severity escalation:** HIGH when the default can cause data loss or incorrect behavior. MEDIUM when the default is safe but operators should know.

**Action:** Log the fallback activation. Add metrics or health checks that surface degraded mode.

### 4. Catch-and-Rethrow-Generic (Severity: MEDIUM)

```typescript
// Pattern: catch wraps the error but loses context
try { riskyOperation(); } catch (e) { throw new Error('Operation failed'); }
// vs. correct:
try { riskyOperation(); } catch (e) { throw new Error('Failed to load user config', { cause: e }); }
```

**Why it matters:** The original error's stack trace, message, and context are lost. Debugging requires reproducing the issue rather than reading the error chain.

**Action:** Preserve the cause chain using `{ cause: e }`. Include what operation failed and why in the wrapper message.

---

## Error Context Checklist

Every error message should answer these four questions:

| Question | Example (Good) | Example (Bad) |
|----------|----------------|---------------|
| **What failed?** | "Failed to read workflow state for feature-123" | "Read failed" |
| **Why did it fail?** | "File not found at /tmp/state/feature-123.json" | "Error occurred" |
| **What to do about it?** | "Ensure the workflow was initialized with `init`" | (nothing) |
| **Cause chain?** | `new Error('...', { cause: originalError })` | `new Error(originalError.message)` |

### Context Completeness Scoring

- **4/4 questions answered:** Excellent error — no finding
- **3/4 questions answered:** Acceptable — LOW finding if missing "what to do"
- **2/4 questions answered:** Incomplete — MEDIUM finding
- **1/4 or 0/4 questions answered:** Poor — HIGH finding (effectively opaque)

---

## Fallback Anti-Patterns

### Silent Degradation (Severity: HIGH)

The system switches to a less capable mode without any signal to the operator.

```typescript
// Anti-pattern: silent mode switch
function getStore() {
  if (!configuredStore) {
    return new InMemoryStore(); // Silently degrades to non-persistent store
  }
  return configuredStore;
}
```

**Fix:** Log when fallback activates. Add a health check endpoint or metric that surfaces degraded state.

### Invisible Mode Switches (Severity: HIGH)

```typescript
// Anti-pattern: behavior changes silently based on error
let mode = 'full';
try { await connectToService(); } catch { mode = 'limited'; }
// Rest of code behaves differently but nothing signals the switch
```

**Fix:** Make mode visible via logging, metrics, or return value. Callers should know they're operating in degraded mode.

### Best-Effort Without Signaling (Severity: MEDIUM)

```typescript
// Anti-pattern: best-effort with no visibility
async function syncData() {
  try { await pushToRemote(data); } catch { /* best effort */ }
}
```

**Fix:** Even best-effort operations should log failures. The operator needs to know sync is failing so they can investigate and fix the root cause.

---

## Promise Rejection Patterns

### Swallowed Rejections (Severity: HIGH)

```typescript
// Pattern: promise rejection silently consumed
promise.catch(() => {});
promise.catch(() => undefined);
someAsyncFn().catch(() => {});
```

**Why it matters:** Same as empty catch — the error is invisible. Worse in async contexts because the failure may surface much later as corrupted state.

### Unhandled Rejection Handlers (Severity: MEDIUM)

```typescript
// Pattern: global handler as a band-aid
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
```

**Why it matters:** Global handlers are a safety net, not a solution. Each rejection should be handled at the call site with appropriate recovery or propagation.

**Action:** Keep the global handler as a safety net, but fix each unhandled rejection at its source.

### Fire-and-Forget Without Error Handling (Severity: MEDIUM)

```typescript
// Pattern: async call started but never awaited and no catch
sendAnalytics(event); // Returns a promise, never awaited
cleanupTempFiles();   // Async, failure silently ignored
```

**Fix:** Either await and handle the error, or explicitly catch and log:
```typescript
sendAnalytics(event).catch(err => logger.warn('Analytics send failed', { err }));
```

**Exception:** Non-critical telemetry and observability side-effects (e.g., `emitGateEvent(...)`, `sendAnalytics(event)`) may be allowed to fail silently when all of: (1) the call is clearly annotated as fire-and-forget, (2) failure cannot affect primary execution correctness, and (3) the scope is limited to observability. Do not flag these as findings.

---

## Severity Summary

| Pattern | Default Severity | Escalation Condition |
|---------|-----------------|---------------------|
| Empty catch | HIGH | Always HIGH |
| Log-only catch | MEDIUM | HIGH if operation affects data integrity |
| Swallow-and-default | MEDIUM | HIGH if default can cause data loss |
| Catch-and-rethrow-generic | MEDIUM | HIGH if error is user-facing or triggers retry |
| Silent degradation | HIGH | Always HIGH |
| Invisible mode switch | HIGH | Always HIGH |
| Best-effort without signaling | MEDIUM | HIGH if operation is data-critical |
| Swallowed promise rejection | HIGH | Always HIGH |
| Unhandled rejection handler as fix | MEDIUM | HIGH if in production critical path |
| Fire-and-forget | MEDIUM | HIGH if operation has side effects |
