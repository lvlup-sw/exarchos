# Workflow State MCP Server — Testing Gap Bugs

Discovered during the `refactor-testing-gaps` workflow on 2026-02-06 while auditing the codebase and planning fixes for the issues in `docs/audits/2026-02-06-testing-gaps.md`.

---

## Bug 5: HSM compound phase names not supported by Zod schema

**Severity:** High — corrupts state file, blocks all subsequent MCP operations

**Reproduction:**
1. Initialize a refactor workflow: `workflow_init({ featureId: 'test', workflowType: 'refactor' })`
2. Set scope assessment and transition to `brief`
3. Transition to overhaul track: `workflow_set({ phase: 'overhaul-plan' })`
4. HSM accepts the transition and writes `"phase": "overhaul-plan"` to the state file
5. Any subsequent `workflow_set` or `workflow_get` call fails with:
   ```
   STATE_CORRUPT: Schema validation failed — Invalid enum value.
   Expected 'explore' | 'brief' | 'plan' | ... received 'overhaul-plan'
   ```

**Root Cause:** The HSM defines compound sub-state names like `overhaul-plan`, `overhaul-delegate`, `polish-implement`, etc., but the Zod `WorkflowStateSchema` only accepts a fixed set of simple phase names (`plan`, `delegate`, `implement`, etc.). When the HSM transitions to a compound sub-state, it writes the full compound name to the phase field. On next read, Zod validation rejects it.

The HSM transition succeeds (via `executeTransition`) because it bypasses Zod. But the next `readStateFile()` call runs `WorkflowStateSchema.safeParse()` which rejects the compound phase name.

**Location:**
- `src/state-machine.ts` — defines compound states like `overhaul-plan`, `polish-implement`
- `src/schemas.ts` — `PhaseSchema` enum doesn't include compound sub-state names
- `src/state-store.ts:151` — `readStateFile()` validates via Zod, rejects unknown phase names

**Impact:** Refactor workflows using `overhaul-plan`, `overhaul-delegate`, etc. become permanently corrupted after the first transition into a compound sub-state. The state file must be manually edited to recover.

**Workaround:** Manually edit the state file to replace compound phase names with the simple equivalent:
```
"overhaul-plan" → "plan"
"overhaul-delegate" → "delegate"
"polish-implement" → "implement"
```

**Fix options:**
1. Add all compound sub-state names to the Zod schema's phase enum
2. Use `.passthrough()` on the schema so it doesn't reject unknown phase values
3. Map compound names to simple names before writing (lossy — would hide which track is active)

---

## Bug 6: Circuit breaker metadata key mismatch — never triggers via events.ts path

**Severity:** Critical — circuit breaker silently broken in `handleSummary` and `handleNextAction`

**Reproduction:**
1. Advance a feature workflow through multiple fix cycles (delegate → integrate fail → delegate)
2. Call `handleSummary()` — circuit breaker state reports `fixCycleCount: 0` regardless of actual cycles
3. Call `handleNextAction()` at integrate phase with `integration.passed = false` — returns `AUTO:delegate` instead of `BLOCKED:circuit-open`

**Root Cause:** Two independent fix-cycle counting functions exist with incompatible metadata key expectations:

| Function | Location | Reads key | Used by |
|----------|----------|-----------|---------|
| `countFixCycles()` | `state-machine.ts:656` | `metadata?.compound` | `executeTransition()` (line 810) |
| `getFixCycleCount()` | `events.ts:51` | `metadata?.compoundStateId` | `circuit-breaker.ts` → `handleSummary()`, `handleNextAction()` |

The event writer at `state-machine.ts:921` writes:
```typescript
metadata: { compound: parent?.id }  // key is "compound"
```

So `countFixCycles()` (used during transitions) correctly counts fix cycles, but `getFixCycleCount()` (used for reporting/next-action) never finds them because it looks for `compoundStateId`.

Additionally, `compound-entry` events (lines 892-897) carry NO metadata at all, but `getFixCycleCount()` tries to use `metadata.compoundStateId` on compound-entry events to find the baseline.

**Impact:**
- `handleSummary()` always reports `fixCycleCount: 0` and `open: false`
- `handleNextAction()` never returns `BLOCKED:circuit-open`, allowing infinite fix cycles through the next-action path
- The circuit breaker DOES work within `executeTransition()` because it uses the matching `countFixCycles()` function

**Location:**
- Writer: `src/state-machine.ts:921` — writes `{ compound: parent?.id }`
- Writer: `src/state-machine.ts:892-897` — writes compound-entry with no metadata
- Reader 1: `src/state-machine.ts:663` — reads `metadata?.compound` (matches)
- Reader 2: `src/events.ts:58,75` — reads `metadata?.compoundStateId` (doesn't match)

**Fix:** Standardize on `compoundStateId` everywhere. Update the writer and `countFixCycles()` to use `compoundStateId`. Add metadata to compound-entry events. Eliminate the duplicate `countFixCycles()` in favor of `getFixCycleCount()`.

---

## Bug 7: Guard exceptions cause unhandled TypeError instead of structured error

**Severity:** High — corrupt state crashes guard evaluation

**Reproduction:**
1. Create a state with `artifacts: null` (instead of `{}`)
2. Attempt a transition where the guard accesses `state.artifacts.design`:
   ```
   executeTransition(hsm, { phase: 'ideate', artifacts: null, ... }, 'plan')
   ```
3. Guard throws `TypeError: Cannot read properties of null (reading 'design')`
4. Exception propagates up to MCP tool handler, returns raw error instead of `GUARD_FAILED`

**Root Cause:** `state-machine.ts:791` calls `transition.guard.evaluate(state)` without try/catch:
```typescript
const guardResult = transition.guard.evaluate(state);
```

Guards assume state has the expected shape (e.g., `artifacts` is an object, `planReview` exists). If state is corrupt or partially initialized, guard functions throw TypeError when accessing nested properties of null/undefined.

**Location:** `src/state-machine.ts:791`

**Impact:** Any corrupt or partially-written state file causes an unhandled exception instead of a clean `GUARD_FAILED` error. The caller gets a generic error with no actionable information.

**Fix:** Wrap guard evaluation in try/catch. On exception, return `{ success: false, errorCode: 'GUARD_FAILED', errorMessage: 'Guard threw: <message>' }`.

---

## Bug 8: handleSet shallow copy shares nested references

**Severity:** Medium — potential state corruption under concurrent access

**Reproduction:**
1. `handleSet()` reads state and creates a copy: `const mutableState = { ...state }` (line 161)
2. This is a shallow copy — `mutableState._events`, `mutableState.tasks`, `mutableState.artifacts` are shared references with `state`
3. If `executeTransition()` pushes to `_events` via the shared reference, the original `state` object is also mutated
4. If the transition then fails and the code returns early (no write), the in-memory state has been silently corrupted

**Root Cause:** `tools.ts:161` uses spread operator for copy:
```typescript
const mutableState = { ...state } as Record<string, unknown>;
```

Spread creates a shallow copy. All nested objects (arrays, objects) are copied by reference, not by value.

**Location:** `src/tools.ts:161`

**Impact:** Low in practice because state is read fresh from disk on each call. However, if any code path reads state, creates the shallow copy, mutates a nested object on the copy, then fails before writing — the original `state` variable is corrupted for the remainder of that function call.

**Fix:** Replace `{ ...state }` with `structuredClone(state)` to create a full deep copy.

---

## Summary

| Bug | Severity | Status | Planned Fix |
|-----|----------|--------|-------------|
| Bug 5: HSM compound phase names vs Zod schema | High | Open | Add compound names to schema OR use `.passthrough()` |
| Bug 6: Circuit breaker metadata key mismatch | Critical | Open | Standardize on `compoundStateId`, eliminate duplicate counter |
| Bug 7: Guard exceptions unhandled | High | Open | Wrap `guard.evaluate()` in try/catch |
| Bug 8: Shallow copy shared references | Medium | Open | Replace spread with `structuredClone()` |

Bugs 6-8 are tracked in the refactor plan: `docs/plans/2026-02-06-testing-gaps.md`
Bug 5 was discovered during the refactor workflow itself and should be added to the plan scope.
