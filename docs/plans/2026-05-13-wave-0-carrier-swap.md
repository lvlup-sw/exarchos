# Implementation Plan — Wave 0 Carrier Swap

**Design:** [`docs/designs/2026-05-13-wave-0-carrier-swap.md`](../designs/2026-05-13-wave-0-carrier-swap.md)
**Date:** 2026-05-13
**Workflow:** `v2-10-wave-0-carrier-swap`
**Epic:** [#1354](https://github.com/lvlup-sw/exarchos/issues/1354)
**Iron Law:** NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST

## Surface inventory

- 4 visible composite tools, 91 actions total: workflow (10), event (3), orchestrate (64), view (14). One hidden tool (`sync`, 1 action) is exempted from MCP registration but still gets schemas (CLI surface).
- 10 `zodToJsonSchema()` call sites across 4 files (`describe/handler.ts` ×6, `projections/rehydration/fingerprint.ts` ×2, `runbooks/handler.ts` ×1, `adapters/schema-introspection.ts` ×1).
- Existing partial state: 3 actions already declare `outputSchema` (`workflow.set/transition/update`) — these consolidate into the new factory.

## Phase map

```text
A. Schema foundations  ──┐
                         │     ┌──→ E. Per-action declarations  ──┐
B. JSON Schema 2020-12 ──┼──→ C. Tighten ToolAction ──┐           │
                         │                            ├──→ D. Carrier swap ──→ F. Integration + parity tests ──→ G. Cleanup
                         └────────────────────────────┘
```

- **A** + **B** are independent; can run in parallel.
- **C** depends on **A** (needs the types).
- **D** depends on **A**, **C**.
- **E** depends on **C**, can fan out per composite tool.
- **F** depends on **D**, **E**.
- **G** depends on **F**.

---

## Phase A — Schema foundations

Add the Zod schemas every other phase consumes. All in a new module `servers/exarchos-mcp/src/schemas/envelope.ts` (test sibling: `envelope.test.ts`).

### Task A.1: `NextActionSchema` lifted from `NextAction` interface
**Phase:** RED → GREEN

1. [RED] Write test: `NextActionSchema_AcceptsCanonicalNextAction_Succeeds` in `schemas/envelope.test.ts`
   - Expected failure: schemas module does not exist.
2. [GREEN] Create `schemas/envelope.ts`. Define `NextActionSchema` matching the `NextAction` interface at `next-action.ts` (verb, reason, validTargets fields).
3. [REFACTOR] None.

**Dependencies:** None.
**Parallelizable:** Yes (Group A).

### Task A.2: `ErrorEnvelopeSchema` lifted from `ErrorEnvelope` interface
**Phase:** RED → GREEN

1. [RED] Write test: `ErrorEnvelopeSchema_AcceptsWrapErrorOutput_Succeeds` in `schemas/envelope.test.ts`. Exercise with `wrapError(new ConcurrencyError(...))` and `wrapError(new StorageBusyError(...))`.
   - Expected failure: schema does not exist.
2. [GREEN] Add `ErrorEnvelopeSchema` to `schemas/envelope.ts` matching the `ErrorEnvelope` shape from `format.ts:275`.
3. [REFACTOR] Confirm exported shape matches `wrapError()` output for all three branches (ConcurrencyError, StorageBusyError, generic fallthrough).

**Dependencies:** None.
**Parallelizable:** Yes (Group A).

### Task A.3: `EnvelopeSchema(dataSchema)` factory
**Phase:** RED → GREEN

1. [RED] Write test: `EnvelopeSchema_DiscriminatesOnSuccessField_AcceptsBothBranches` in `schemas/envelope.test.ts`. Assert success branch validates `wrap({foo: 1})`; error branch validates `wrapError(new ConcurrencyError(...))`.
   - Expected failure: factory does not exist.
2. [GREEN] Implement `EnvelopeSchema<D extends z.ZodTypeAny>(dataSchema: D)` as `z.discriminatedUnion('success', [SuccessBranch(dataSchema), ErrorEnvelopeSchema])`.
3. [REFACTOR] Co-locate `PerfMetricsSchema`, `EventHintsSchema`, `CacheHintsSchema`, `CorrectionsSchema` in the same module (lifted from `format.ts` interfaces).

**Dependencies:** A.1, A.2.
**Parallelizable:** No (within Group A — sequential after A.1/A.2).

### Task A.4: `toEnvelope(result: ToolResult)` shared helper
**Phase:** RED → GREEN

1. [RED] Write test: `toEnvelope_MapsSuccessToolResult_ReturnsSuccessEnvelope` and `toEnvelope_MapsFailureToolResult_ReturnsErrorEnvelope` in `format.test.ts`.
   - Expected failure: function does not exist.
2. [GREEN] Add `toEnvelope` in `format.ts`. Maps `{success: true, data, ...}` → `Envelope<T>` via `wrap()`; maps `{success: false, error, ...}` → `ErrorEnvelope` (preserves the `error` block already shaped by `wrapError`-callers).
3. [REFACTOR] Reuse `wrap()` internally; do not duplicate the perf-default logic.

**Dependencies:** A.3.
**Parallelizable:** No (within Group A — sequential).

### Task A.5: `ActionAnnotations` type + default table
**Phase:** RED → GREEN

1. [RED] Write test: `ActionAnnotations_RequiredFields_RejectsPartial` in `registry.test.ts`. Assert TypeScript rejects (compile-time) and Zod-style validator rejects (runtime) annotations missing any of {safety, readOnly, destructive, idempotent, openWorld}.
   - Expected failure: type does not exist.
2. [GREEN] Add `ActionAnnotations` type to `registry.ts`. Add a `validateAnnotations(a: unknown): asserts a is ActionAnnotations` runtime guard used at registration.
3. [REFACTOR] None.

**Dependencies:** None (type addition).
**Parallelizable:** Yes (Group A).

---

## Phase B — JSON Schema 2020-12 conformance (#1277)

Centralize the draft via a wrapper; migrate the 10 call sites. Independent of Phase A.

### Task B.1: `adapters/json-schema.ts` wrapper
**Phase:** RED → GREEN

1. [RED] Write test: `zodToJsonSchema_DefaultTarget_Emits2020Draft` in `adapters/json-schema.test.ts`. Assert emitted `$schema === 'https://json-schema.org/draft/2020-12/schema'`.
   - Expected failure: wrapper module does not exist.
2. [GREEN] Create `adapters/json-schema.ts` re-exporting `zodToJsonSchema` with default `target: 'jsonSchema2020'` and pass-through for overrides.
3. [REFACTOR] None.

**Dependencies:** None.
**Parallelizable:** Yes (Group B).

### Task B.2: Migrate `describe/handler.ts` (6 sites)
**Phase:** RED → GREEN

1. [RED] Write test: `DescribeHandler_EmittedSchemas_Use2020Draft` in `describe/handler.test.ts`. Snapshot-assert `$schema` on the describe output for each composite tool.
   - Expected failure: handler still imports `zod-to-json-schema` directly with default target.
2. [GREEN] Replace 6 imports of `zod-to-json-schema` in `describe/handler.ts` with the wrapper. Verify each call site does not pass a conflicting `target` opt.
3. [REFACTOR] None.

**Dependencies:** B.1.
**Parallelizable:** No (within Group B — sequential after B.1).

### Task B.3: Migrate `projections/rehydration/fingerprint.ts` (2 sites)
**Phase:** RED → GREEN

1. [RED] Write test: `FingerprintEmittedSchema_Uses2020Draft` in the existing fingerprint test.
   - Expected failure: still Draft 7.
2. [GREEN] Replace 2 imports with the wrapper.
3. [REFACTOR] None.

**Dependencies:** B.1.
**Parallelizable:** Yes with B.2/B.4/B.5 (independent files).

### Task B.4: Migrate `runbooks/handler.ts` (1 site)
**Phase:** RED → GREEN

1. [RED] Test in `runbooks/handler.test.ts`: assert emitted schema uses 2020-12.
2. [GREEN] Replace 1 import.
3. [REFACTOR] None.

**Dependencies:** B.1.
**Parallelizable:** Yes with B.2/B.3/B.5.

### Task B.5: Migrate `adapters/schema-introspection.ts` (1 site)
**Phase:** RED → GREEN

1. [RED] Test in `adapters/schema-introspection.test.ts`.
2. [GREEN] Replace 1 import.
3. [REFACTOR] None.

**Dependencies:** B.1.
**Parallelizable:** Yes with B.2/B.3/B.4.

---

## Phase C — Tighten `ToolAction`

After Phase A. Makes `outputSchema` and `annotations` required.

### Task C.1: Make `ToolAction.outputSchema` required
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `Registry_LoadFullRegistry_FailsIfAnyActionLacksOutputSchema` in `registry.test.ts`. Iterate every action across `TOOL_REGISTRY`; assert each `action.outputSchema` is defined.
   - Expected failure: most actions lack `outputSchema` today (only 3 declared).
2. [GREEN] No code change yet — Phase E adds the per-action declarations. Test fails until Phase E lands. **This task only writes the test; production change is gated on Phase E completion.**
3. [REFACTOR] None.

**Dependencies:** A.3, A.4.
**Parallelizable:** No (test gate for Phase E).

### Task C.2: Make `ToolAction.annotations` required
**Phase:** RED → GREEN

1. [RED] Write test: `Registry_LoadFullRegistry_FailsIfAnyActionLacksAnnotations` in `registry.test.ts`.
   - Expected failure: no action declares annotations today.
2. [GREEN] No production change yet — Phase E adds them. **Test-only task.**
3. [REFACTOR] None.

**Dependencies:** A.5.
**Parallelizable:** Yes with C.1.

### Task C.3: Registration-time validator
**Phase:** RED → GREEN

1. [RED] Write test: `BuildCompositeSchema_MissingOutputSchemaOrAnnotations_Throws` in `registry.test.ts`. Construct a malformed action; assert `buildCompositeSchema` (or a new `validateAction()` guard) throws with the action name in the message.
   - Expected failure: validator does not exist.
2. [GREEN] Add `validateAction(action: ToolAction): void` called from `buildCompositeSchema()` (or a new registration-time pass). Throws with action name on missing `outputSchema` or any required `annotations` field.
3. [REFACTOR] None.

**Dependencies:** A.5.
**Parallelizable:** Yes with C.1, C.2.

---

## Phase D — Carrier swap

After A, C. The actual `formatResult` split + `registerTool` plumbing + CLI envelope.

### Task D.1: `toMcpResult(env)` in `adapters/mcp.ts`
**Phase:** RED → GREEN

1. [RED] Write test: `toMcpResult_SuccessEnvelope_ReturnsBothTextAndStructuredContent` in `adapters/mcp.test.ts`. Assert output has `content[0].text === JSON.stringify(env)`, `structuredContent === env`, `isError === false`. Symmetric test for error envelope.
   - Expected failure: function does not exist.
2. [GREEN] Add `toMcpResult(env: Envelope<unknown> | ErrorEnvelope)` per the design §2.3 signature.
3. [REFACTOR] None.

**Dependencies:** A.3.
**Parallelizable:** Yes with D.2.

### Task D.2: `toCliResult(env, format)` in `adapters/cli-format.ts`
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `toCliResult_JsonFormat_WritesEnvelopeOnStdout` and `toCliResult_TableFormat_DelegatesToPrettyPrint` in `cli-format.test.ts`. Use a stdout/stderr capture harness; assert `--format json` stdout is `JSON.stringify(env, null, 2) + '\n'`.
   - Expected failure: function does not exist.
2. [GREEN] Add `toCliResult(env, format)` per design §2.3. Under `--format json`: write envelope to stdout. Under `--format table|tree`: fall through to existing `prettyPrint(toolResult)` (mapped back from envelope) so table/tree paths are unchanged.
3. [REFACTOR] Keep `prettyPrint` for table/tree but route through `toCliResult` from the CLI entry. No duplicated rendering.

**Dependencies:** A.3, A.4.
**Parallelizable:** Yes with D.1.

### Task D.3: `EXARCHOS_CLI_ENVELOPE=0` opt-out flag
**Phase:** RED → GREEN

1. [RED] Write test: `toCliResult_EnvelopeOptOut_PreservesLegacyShape` in `cli-format.test.ts`. With `EXARCHOS_CLI_ENVELOPE=0`, `--format json` stdout matches today's `data`-only shape; stderr sidebars unchanged.
   - Expected failure: opt-out not implemented.
2. [GREEN] In `toCliResult`, check `process.env.EXARCHOS_CLI_ENVELOPE`. When `'0'`, call legacy `prettyPrint(toolResult)` path. Default and any other value: emit envelope.
3. [REFACTOR] None.

**Dependencies:** D.2.
**Parallelizable:** No (sequential after D.2).

### Task D.4: Pass LCD `outputSchema` to `server.registerTool()`
**Phase:** RED → GREEN

1. [RED] Write test: `MCPServer_RegisterTool_PassesOutputSchemaPerTool` in `adapters/mcp.test.ts`. Spy on the SDK's `registerTool` call; assert third argument's `outputSchema` matches `EnvelopeSchema(z.unknown())`.
   - Expected failure: only `inputSchema` is passed today.
2. [GREEN] In `adapters/mcp.ts:78`, add `outputSchema: LCD_OUTPUT_SCHEMA` to the registerTool options.
3. [REFACTOR] Hoist the constant module-scope.

**Dependencies:** A.3, D.1.
**Parallelizable:** Yes with D.5, D.6.

### Task D.5: Per-call validation against per-action `outputSchema`
**Phase:** RED → GREEN

1. [RED] Write test: `MCPAdapter_DispatchResultViolatesPerActionSchema_ReturnsInternalErrorEnvelope` in `adapters/mcp.test.ts`. Register a stub action whose `outputSchema` requires `data.foo: string`; dispatch returns `{success: true, data: {foo: 42}}`. Assert response is a `success: false` envelope with `error.code === 'INTERNAL_ERROR'` and `_meta.outputSchemaViolation` carrying the Zod issue path.
   - Expected failure: no per-call validation today.
2. [GREEN] In the `mcpHandler` closure, after `dispatch()` returns, look up the dispatched action by name, validate `toEnvelope(result)` against `action.outputSchema`. On failure, produce an `INTERNAL_ERROR` envelope via `wrapError()` with `_meta.outputSchemaViolation = issues`.
3. [REFACTOR] Extract `validateAgainstActionSchema(tool, action, env)` helper.

**Dependencies:** A.3, A.4, D.1.
**Parallelizable:** Yes with D.4, D.6.

### Task D.6: `tools/list` annotations from `ActionAnnotations`
**Phase:** RED → GREEN

1. [RED] Write test: `ToolsList_AnnotationsField_AggregatesPerActionFlags` in `adapters/mcp.test.ts`. Per the spec, `tools/list` carries one `annotations` per tool. Decision: aggregate per-tool as `all-true & all-true`? **No** — per the design, each *action* has its own annotations; the *tool*-level annotations summarize across actions. Aggregation rule: `readOnly = every action.readOnly`; `destructive = some action.destructive`; `idempotent = every action.idempotent`; `openWorld = some action.openWorld` (as-implemented contract — any externally-effectful action lifts the tool to openWorld; an earlier draft said `every` here, since corrected to match the adapter test). Assert against this rule.
   - Expected failure: no annotations populated today.
2. [GREEN] Add `aggregateToolAnnotations(actions): ToolAnnotations` helper. Pass result as `annotations` option to `server.registerTool()`.
3. [REFACTOR] Add a per-action override path: future `describe.tool-action` could expose per-action annotations; not required for this PR.

**Dependencies:** A.5, C.3, D.4.
**Parallelizable:** Yes with D.4, D.5.

### Task D.7: Remove old `formatResult` from MCP adapter
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `MCPHandler_ReturnsToMcpResultOutput_NotFormatResult` in `adapters/mcp.test.ts`. Assert the handler output shape contains `structuredContent` and equals `toMcpResult(toEnvelope(dispatchResult))`.
   - Expected failure: still routes through `formatResult`.
2. [GREEN] Replace `formatResult(...)` call sites in `adapters/mcp.ts` with `toMcpResult(toEnvelope(...))`.
3. [REFACTOR] None.

**Dependencies:** D.1, D.5.
**Parallelizable:** No (sequential after D.5).

### Task D.8: Wire `action.annotations.safety` into HSM guards and `computeNextActions`
**Phase:** RED → GREEN → REFACTOR

Closes design §2.4: "safety is consumed by HSM guards and by `computeNextActions` — refactored from in-handler prose to a single read from this metadata table." Without this task, `safety` is declared but unused (DIM-5 hygiene).

1. [RED] Write tests in `next-action.test.ts` and the HSM-guard test file (locate via `grep -l "computeNextActions\|HSMGuard\|transitionGuard" servers/exarchos-mcp/src`):
   - `ComputeNextActions_ReadsSafetyFromAction_ProducesCompensableVerb` — when the source action has `safety: 'compensable'`, the produced next_actions include a `cancel`/`rollback` verb (or the equivalent topology-derived shape).
   - `HSMGuard_RejectsDestructiveActionInGuardedPhase_ReadsFromAnnotations` — a guarded phase with `requiresSafety: 'read-only'` rejects an action whose `annotations.safety === 'remote-mutation'`.
   - Expected failure: today the same reasoning lives in handler prose; no read from `action.annotations.safety`.
2. [GREEN] Refactor `computeNextActions` to look up the dispatched action via the registry and read `annotations.safety`. Refactor the HSM-guard primitive (`workflow.transition`-side) to consume the field. Remove the corresponding in-handler prose reasoning that the new path supersedes.
3. [REFACTOR] Confirm no other handler-internal prose reads safety semantics — `grep` for `'read-only'\|'compensable'\|'local-mutation'\|'remote-mutation'` in handler code; every remaining hit should route through `registry.findActionInRegistry(...).annotations.safety`.

**Dependencies:** A.5, C.3, E.1–E.5 (all actions must declare annotations before consumers refactor to read them).
**Parallelizable:** No (sequential after E completes; depends on annotations being populated).

---

## Phase E — Per-action schema + annotations declarations

After C, D. One task per composite tool. Each task adds `outputSchema: EnvelopeSchema(z.unknown())` and `annotations: { ... }` to every action in its tool. Per-action data shapes tighten in follow-up work (out of scope per design §10).

### Task E.1: `workflow` composite — 10 actions
**Phase:** RED → GREEN → REFACTOR

1. [RED] Tests A.1–A.5 + C.1/C.2 (already written) start passing for workflow actions as they're declared. New test: `WorkflowComposite_AllActionsDeclareSchemaAndAnnotations` — iterate `workflowActions`, assert each has both fields. Expected: still failing until GREEN.
2. [GREEN] For each of the 10 workflow actions:
   - Set `outputSchema: EnvelopeSchema(z.unknown())` (or tighten where #1340-era schema already exists — `set/transition/update`).
   - Set `annotations` per the milestone-16 §4.2 table: `get` = read-only; `init/set/update/transition` = remote-mutation / non-destructive; `cancel/cleanup` = compensable; `reconcile/rehydrate` = local-mutation read-write; `checkpoint` = local-mutation; `describe` = read-only.
3. [REFACTOR] Consolidate the existing `WorkflowSet/Transition/UpdateOutputSchema` constants into the new factory; the standalone exports stay for one release as deprecated re-exports.

**Dependencies:** A.3, A.5, C.3.
**Parallelizable:** Yes with E.2, E.3, E.4 (different file regions; merge serializes).

### Task E.2: `event` composite — 3 actions
**Phase:** RED → GREEN

1. [RED] Test: `EventComposite_AllActionsDeclareSchemaAndAnnotations`.
2. [GREEN] Apply per design table: `query` = read-only; `append` = local-mutation; `replay` = local-mutation read-heavy.
3. [REFACTOR] None.

**Dependencies:** A.3, A.5, C.3.
**Parallelizable:** Yes with E.1, E.3, E.4.

### Task E.3: `orchestrate` composite — 64 actions (split into sub-batches)
**Phase:** RED → GREEN → REFACTOR

64 actions is the largest section. Split into 4 sub-tasks of ~16 actions each, each with its own RED/GREEN. The fan-out cost is bounded — these are mechanical additions, not novel design — but the merge cost favors batching.

- **E.3a:** orchestrate actions 1–16 (delegate/task/agent surface).
- **E.3b:** orchestrate actions 17–32 (review/synthesize/shepherd surface).
- **E.3c:** orchestrate actions 33–48 (merge/cleanup/cancel surface).
- **E.3d:** orchestrate actions 49–64 (utility, describe, status surface).

Each sub-task structure:

1. [RED] Per-batch test asserting each declared action has both fields.
2. [GREEN] Apply table from design §2.4. Default `safety: 'local-mutation'` for actions with side-effects; `'read-only'` for getters; `'compensable'` for irreversible orchestration steps.
3. [REFACTOR] None.

**Dependencies:** A.3, A.5, C.3.
**Parallelizable:** Yes within (E.3a–d can run in worktrees; each touches a disjoint registry region). Merge serializes — orchestrate region is one editing surface.

### Task E.4: `view` composite — 14 actions
**Phase:** RED → GREEN

1. [RED] Test: `ViewComposite_AllActionsDeclareSchemaAndAnnotations`.
2. [GREEN] All view actions are read-only per design table: `view.*` = read-only / idempotent / openWorld false.
3. [REFACTOR] None.

**Dependencies:** A.3, A.5, C.3.
**Parallelizable:** Yes with E.1, E.2, E.3.

### Task E.5: `sync` (hidden) composite — 1 action
**Phase:** RED → GREEN

1. [RED] Same registry-level test.
2. [GREEN] Declare schema + annotations even though tool is hidden — keeps the validator's "all actions" invariant clean.
3. [REFACTOR] None.

**Dependencies:** A.3, A.5, C.3.
**Parallelizable:** Yes with E.1–E.4.

---

## Phase F — Integration + parity tests

After D, E. Wire-level and CLI-parity coverage.

### Task F.1: `tools/list` shape integration test
**Phase:** RED → GREEN

1. [RED] Write test: `MCPServer_ToolsList_ReturnsOutputSchemaAndAnnotationsPerTool` in `__tests__/integration/tools-list.test.ts`. Start an MCP server in-process; call `tools/list` via the SDK; assert each visible tool entry has `outputSchema` (JSON Schema 2020-12 `$schema`) and `annotations` (4 boolean fields).
   - Expected failure: existing wire shape lacks both.
2. [GREEN] Already implemented by D.4 + D.6 — this test is wired only after E completes; expected to pass post-E.

**Dependencies:** D.4, D.6, E.1–E.5.
**Parallelizable:** Yes with F.2, F.3.

### Task F.2: `tools/call` carrier integration test
**Phase:** RED → GREEN

1. [RED] Write test: `MCPServer_ToolsCall_ReturnsTextAndStructuredContent` in `__tests__/integration/tools-call.test.ts`. Dispatch one read-only action per visible tool; assert response has both `content[0].text` and `structuredContent`; assert `structuredContent === JSON.parse(content[0].text)`; assert `structuredContent` validates against the registered LCD `outputSchema`.
   - Expected failure: no `structuredContent` today.
2. [GREEN] Already implemented by D.7 — test expected to pass post-D.

**Dependencies:** D.7, E.1–E.5.
**Parallelizable:** Yes with F.1, F.3.

### Task F.3: CLI parity byte-equal test
**Phase:** RED → GREEN

1. [RED] Write test: `CLI_JsonFormat_ByteEqualToMcpStructuredContent` in `__tests__/integration/cli-parity.test.ts`. Run the same dispatch via both adapters: CLI subprocess with `--format json`; in-process MCP `tools/call`. Mask timestamps (`updatedAt`, `_perf.ms`) and IDs before comparison. Assert byte-equal modulo masks.
   - Expected failure: CLI today emits `data`-only.
2. [GREEN] Already implemented by D.2 — test expected to pass post-D.

**Dependencies:** D.2, D.7, E.1–E.5.
**Parallelizable:** Yes with F.1, F.2.

### Task F.4: `NextActionSchema` round-trip per workflow type
**Phase:** RED → GREEN

1. [RED] Write test: `ComputeNextActions_PerWorkflowType_ValidatesAgainstSchema` in `next-action.test.ts` or `schemas/envelope.test.ts`. Iterate workflow types {feature, oneshot, debug, refactor, hotfix, discovery}; for each phase × workflow type cell, call `computeNextActions(state, hsm)` and assert output array validates against `z.array(NextActionSchema)`.
   - Expected failure: schema does not match the existing in-tree shape until A.1 lands.
2. [GREEN] Already implemented by A.1 — test passes once the schema is accurate; if mismatch found, fix the schema (DIM-3 contracts).
3. [REFACTOR] None.

**Dependencies:** A.1.
**Parallelizable:** Yes with F.1, F.2, F.3.

### Task F.5: `wrapError` round-trip
**Phase:** RED → GREEN

1. [RED] Write test: `WrapError_AllBranches_ValidatesAgainstErrorEnvelopeSchema` in `format.test.ts`. Call `wrapError(new ConcurrencyError(...))`, `wrapError(new StorageBusyError(...))`, `wrapError(new Error('x'))`, `wrapError('plain')`. Assert each output validates against `ErrorEnvelopeSchema`.
   - Expected failure: if A.2 schema is incomplete, this catches it.
2. [GREEN] Already implemented by A.2 — fix schema gaps if any.
3. [REFACTOR] None.

**Dependencies:** A.2.
**Parallelizable:** Yes with F.1–F.4.

### Task F.6: Output validation overhead benchmark assertion
**Phase:** RED → GREEN

1. [RED] Write test: `MCPHandler_OutputSchemaValidation_StaysUnderOneMillisecond` in `__tests__/integration/perf-validation.test.ts`. Dispatch a representative action 100×; assert median per-call validation overhead (measure delta between `validateAgainstActionSchema` enter/exit) is sub-millisecond.
   - Expected failure: no measurement today.
2. [GREEN] Instrument the validation step. If the threshold is breached, the test fails — gates further per-call validation expansion (design §10 risk).
3. [REFACTOR] None.

**Dependencies:** D.5.
**Parallelizable:** Yes with F.1–F.5.

### Task F.7: CLI `--format table` and `--format tree` regression test
**Phase:** RED → GREEN

Closes design §7 test-plan item 6: "`--format table` and `--format tree` paths emit the same `data` content as today (no regression)".

1. [RED] Write test: `CLI_TableFormat_DataContentUnchangedAcrossCarrierSwap` and `CLI_TreeFormat_DataContentUnchangedAcrossCarrierSwap` in `__tests__/integration/cli-table-tree-regression.test.ts`. Run a representative tabular action (e.g. `view list-workflows`) and a representative tree action (e.g. `wf get`) under both formats; assert stdout byte-equal to the pre-swap baseline captured as a fixture.
   - Expected failure: regression suite missing today.
2. [GREEN] Capture the baseline by running each command before the D.2 refactor (or use the existing snapshot pattern in `cli-format.test.ts`). After the refactor, the stdout content must match the baseline byte-for-byte (sidebar stderr lines may move but `data`-rendering stays identical).
3. [REFACTOR] Consolidate the table/tree snapshot fixtures next to the parity baseline used by F.3.

**Dependencies:** D.2.
**Parallelizable:** Yes with F.1–F.6.

---

## Phase G — Cleanup

After F.

### Task G.1: Remove the original `formatResult` symbol
**Phase:** RED → GREEN

1. [RED] Write test: `Format_OldFormatResultSymbol_NotExported` in `format.test.ts`. Assert the `formatResult` named export no longer exists.
   - Expected failure: still exported.
2. [GREEN] Delete `formatResult` from `format.ts`. Remove any remaining call sites (`grep formatResult servers/exarchos-mcp/src` returns empty for non-test source files).
3. [REFACTOR] None.

**Dependencies:** D.7.
**Parallelizable:** Yes with G.2, G.3.

### Task G.2: Consolidate preview.2 standalone schemas
**Phase:** RED → GREEN

1. [RED] Write test: `Registry_PreviewTwoStandaloneSchemas_AreFactoryDerived` in `registry.test.ts`. Assert `WorkflowSet/Transition/UpdateOutputSchema` are now thin wrappers over `EnvelopeSchema(...)` with the same `_meta.deprecation` slot. Assert schema parse-equivalence (parse the same payload through both shapes; expect identical issues).
   - Expected failure: factory not used.
2. [GREEN] Rewrite the three constants as `EnvelopeSchema(z.object({/* per-action data */}).passthrough()).and(z.object({_meta: z.object({deprecation: MetaDeprecationSchema.optional()}).passthrough().optional()}))` or equivalent. Mark them `@deprecated` (one-release sunset).
3. [REFACTOR] None.

**Dependencies:** A.3, E.1.
**Parallelizable:** Yes with G.1, G.3.

### Task G.3: Surface per-action schema in `describe`
**Phase:** RED → GREEN

1. [RED] Write test: `DescribeHandler_PerActionResponse_IncludesOutputSchemaJson` in `describe/handler.test.ts`. Call `describe({tool: 'exarchos_workflow', action: 'get'})`; assert response has `outputSchemaJson` field carrying the per-action schema as JSON Schema 2020-12.
   - Expected failure: describe doesn't emit per-action outputSchema today.
2. [GREEN] In `describe/handler.ts`, emit `outputSchemaJson: zodToJsonSchema(action.outputSchema)` per action.
3. [REFACTOR] None.

**Dependencies:** B.1, B.2, E.1–E.5.
**Parallelizable:** Yes with G.1, G.2.

---

## Parallelization summary

| Group | Tasks | Notes |
|---|---|---|
| **Group A (parallel)** | A.1, A.2, A.5, B.1 | Independent foundation tasks |
| **Group A-seq** | A.3 (after A.1+A.2) → A.4 (after A.3) | EnvelopeSchema chain |
| **Group B (parallel)** | B.2, B.3, B.4, B.5 (after B.1) | Independent file edits |
| **Group C (parallel)** | C.1, C.2, C.3 (after A) | Test-only + validator |
| **Group D-1 (parallel)** | D.1, D.2 (after A) | adapters |
| **Group D-2 (parallel)** | D.4, D.5, D.6 (after D.1, D.2, C) | registerTool plumbing |
| **Group D-seq** | D.3 (after D.2) → D.7 (after D.5) → D.8 (after E completes) | opt-out + cutover + safety-field consumer refactor |
| **Group E (parallel)** | E.1, E.2, E.4, E.5; E.3a–E.3d serialize on orchestrate region | Per-tool declarations |
| **Group F (parallel)** | F.1, F.2, F.3, F.4, F.5, F.6, F.7 (after D, E) | Integration + regression tests |
| **Group G (parallel)** | G.1, G.2, G.3 (after F) | Cleanup |

Total tasks: 39 (E.3 split into 4 sub-tasks; D.8 + F.7 added in plan-review revision). Dependencies form 7 phases. Critical path: A.1 → A.3 → A.4 → C.3 → D.5 → D.7 → D.8 → F.2 → G.1 (9 tasks).

## Branch naming

- Integration branch: `feature/v2-10-wave-0-carrier-swap`
- Per-task branches: `task/wave-0/<task-id>` (e.g. `task/wave-0/A.3`, `task/wave-0/E.3a`)
- All task branches base off the integration branch; merge back via the standard delegate flow.

## Risks called out by the design that this plan addresses

- **MCP SDK `outputSchema` argument shape** (design §10): D.4 verifies against the pinned SDK.
- **Per-call validation overhead** (design §10): F.6 adds a benchmark assertion.
- **CLI breaking change reception** (design §10): D.3 ships the opt-out flag.
- **Action-count migration cost** (design §10): Phase E ships LCD-per-action; data-shape tightening is explicitly follow-up work.

## Out of scope for this plan (deferred to follow-up issues)

- Per-action `dataSchema` tightening for actions that ship with `EnvelopeSchema(z.unknown())`.
- Roots (#1290), operationId (#1291), SDK pin (#1292) — preview.4.
- Per-action annotations on the wire (currently aggregated per-tool by D.6); design §5 notes describe-time surface as the per-action discoverability path.
- Removal of the `EXARCHOS_CLI_ENVELOPE=0` opt-out flag — design §6 commits to dropping it in v2.11.0 once external CLI consumers have migrated. File the v2.11.0 cleanup issue after preview.3 ships.
