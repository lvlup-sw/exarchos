# Plan: EventStore Constructor Injection (Refactor)

**Workflow:** `refactor-eventstore-constructor-injection`
**Linked:** `debug-v29-event-store-cluster` (#1182)
**Branch:** `fix/v29-event-projection-cluster` (continued)
**Supersedes:** commit `7b262ee4` (Fix 1's Registry-with-fallback shape)

## Why this refactor

Research convergence (Seemann, Fowler, Microsoft .NET DI guidelines):

- **Lifetime correct, shape suboptimal.** A single shared `EventStore` per process is the right invariant — Microsoft's "Improper Instantiation" antipattern explicitly endorses singleton-lifetime for resource-wrapping classes.
- **Lazy fallback is the recurrence trap.** The `getOrCreateEventStore` fallback that lazy-creates with a logged warning is the same DIM-1 shape that caused #1182, just relocated. CI noise will swallow the warning.
- **Constructor injection eliminates the trap.** Pass `EventStore` explicitly through `DispatchContext` to handlers; tests construct their own context. No module-global, no fallback, no recurrence surface.

## End state

- `views/tools.ts` no longer exports `getOrCreateEventStore`, `registerCanonicalEventStore`, or `cachedEventStore` module globals
- All ~12 production call sites receive `EventStore` via parameter (handler signature or DispatchContext)
- ~17 test files construct their own `DispatchContext` in `beforeEach`
- The composition-root allowlist in `scripts/check-event-store-composition-root.mjs` lists 5 paths after the refactor: `index.ts`, `core/context.ts`, and the three CLI subprocess entrypoints (`cli-commands/assemble-context.ts`, `cli-commands/pre-compact.ts`, `evals/run-evals-cli.ts`). The deleted `views/tools.ts:getOrCreateEventStore` and `review/tools.ts:new EventStore(...)` no longer appear.
- The single-composition-root integration test asserts the new contract: handlers invoked through `dispatch()` receive `ctx.eventStore`

## Execution waves

### Wave 1 — Adapter scaffolding (atomic)

Add `adaptWithEventStore<T>` to `orchestrate/composite.ts`, mirroring the existing `adaptWithCtx` pattern:

```typescript
function adaptWithEventStore<T>(
  handler: (args: T, stateDir: string, eventStore: EventStore) => Promise<ToolResult>,
): ActionHandler {
  return async (args, stateDir, ctx) => {
    if (!ctx?.eventStore) throw new Error(`${handler.name}: ctx.eventStore required`);
    return handler(args as unknown as T, stateDir, ctx.eventStore);
  };
}
```

No call-site changes yet. Just the adapter is available.

### Wave 2 — Convert 7 orchestrate handlers

For each of:
- `orchestrate/check-event-emissions.ts` (`handleCheckEventEmissions`)
- `orchestrate/design-completeness.ts` (`handleDesignCompleteness`)
- `orchestrate/provenance-chain.ts` (`handleProvenanceChain`)
- `orchestrate/task-decomposition.ts` (`handleTaskDecomposition`)
- `orchestrate/context-economy.ts` (`handleContextEconomy`)
- `orchestrate/prepare-synthesis.ts` (`handlePrepareSynthesis`)
- `orchestrate/static-analysis.ts` (`handleStaticAnalysis`)

Each conversion is mechanical:

```typescript
// Before
export async function handleX(args: XArgs, stateDir: string): Promise<ToolResult> {
  const store = getOrCreateEventStore(stateDir);
  // ...
}

// After
export async function handleX(
  args: XArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  const store = eventStore;
  // ...
}
```

In `composite.ts`:
```typescript
// Before
check_event_emissions: adapt(handleCheckEventEmissions),

// After
check_event_emissions: adaptWithEventStore(handleCheckEventEmissions),
```

After each handler conversion, run that handler's tests. Most will fail — see Wave 4.

### Wave 3 — CLI commands + telemetry + review

- `cli-commands/pre-compact.ts`: already bootstraps its own EventStore (Fix 1 wave). Verify it still calls `registerCanonicalEventStore` — if so, leave it; the refactor will delete the registry surface in Wave 4 and the call site becomes self-contained.
- `evals/run-evals-cli.ts:88`: convert from `getOrCreateEventStore` to `new EventStore + initialize` (CLI entrypoint pattern, mirrors `assemble-context.ts`).
- `telemetry/tools.ts:70`: trace caller — likely needs eventStore param threaded through.
- `review/tools.ts`: already uses `getOrCreateEventStore` (Fix 1 left it that way). Convert to receive eventStore via parameter or context.

### Wave 4 — Delete the registry surface + update tests

In `views/tools.ts`:
- Delete `canonicalEventStore` module-global
- Delete `canonicalEventStoreDir` module-global
- Delete `registerCanonicalEventStore`
- Delete `getOrCreateEventStore`
- Update `resetMaterializerCache` — only clears materializer state now

Remove `registerCanonicalEventStore` calls from:
- `core/context.ts:initializeContext`
- `index.ts:createServer`
- `cli-commands/assemble-context.ts`
- `cli-commands/pre-compact.ts`

Update `scripts/check-event-store-composition-root.mjs`:
- Remove `views/tools.ts` from ALLOWLIST
- Update header docstring

Update integration test `__tests__/event-store/single-composition-root.test.ts`:
- Replace `HandlerObtainedEventStore_IsSameInstance_AsContext` with `Handler_DispatchedThroughComposite_ReceivesContextEventStore` (assert via spy or capture, not via getOrCreateEventStore)
- Keep `ConcurrentAppends_AcrossObtainPaths_PreserveSequenceIntegrity` as a regression test, but update the second instance to be `new EventStore(stateDir)` directly (manually constructed for the test) — assert that even with two instances the canonical wired through ctx isn't disturbed

Update ~17 test files (the ones that previously hit the lazy fallback):
- Each `beforeEach` constructs `EventStore + initialize + DispatchContext`
- Handler invocations pass the new param
- Where tests use `dispatch()` directly, they pass the constructed `ctx`
- Where tests call CLI commands, those commands self-bootstrap (no test change needed for that path)

### Wave 5 — Validate, update docs, open PR

- `npm run typecheck` clean
- Root suite passes
- MCP server suite passes (5 pre-existing baseline failures excluded)
- `node scripts/check-event-store-composition-root.mjs` exit 0
- Integration test asserts new contract
- Update RCA `docs/rca/2026-04-26-v29-event-projection-cluster.md` with "Final implementation" section noting the constructor-injection approach
- Update `docs/plans/2026-04-26-v29-event-projection-cluster.md` Fix 1 section
- PR title: `fix(mcp): EventStore constructor injection — supersede #1182 fallback shape`
- PR body explicitly notes commit 7b262ee4's intermediate shape and the research that drove this refactor

## Risks

- **Test churn breadth.** ~17 test files updated mechanically. Each change is small; total surface is large. Risk: missing one file leaves a flaky test in the suite.
- **Handler signature change is breaking.** Any external consumer of these handlers (custom tools registered via config, third-party code) breaks. Acceptable for internal handlers; verify by grep.
- **Composite.ts complexity.** Adding another adapter helper to an already-busy file. Mitigation: pattern is identical to existing `adaptCtx`/`adaptArgsWithEventStore`, no new architectural concept.

## Rollback

Each wave is its own commit. If Wave 4's test churn proves intractable:
- Revert Wave 4 commits
- Keep Waves 1-3 (handlers receive eventStore via param when dispatched, but module-global stays for tests)
- Document the partial state in the RCA as a known compromise

This is strictly better than commit 7b262ee4's shape (production paths use injection; only tests use the fallback) but doesn't fully eliminate the registry.

## Out of scope

- Fix 2 (#1179, #1184 projection layer) — separate refactor, separate PR
- Fix 3 (#1180 contract drift) — separate cleanup
- Removing module globals from `views/tools.ts` for materializer caching — unrelated, defer
