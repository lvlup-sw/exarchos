# Implementation Plan: Dual-Facade Skill Rendering

## Source Design

- Design: [`docs/designs/2026-04-14-cli-vs-mcp-facade-analysis.md`](../designs/2026-04-14-cli-vs-mcp-facade-analysis.md)
- Tracking issue (DR-6, aspirational): [lvlup-sw/exarchos#1081](https://github.com/lvlup-sw/exarchos/issues/1081)

## Scope

**Target:** DR-1, DR-2, DR-3, DR-4, DR-5, DR-7, DR-8 implemented as real work.
**Partial (skeleton only):** DR-6 — `RemoteMcpAdapter` interface stub, `docs/designs/future/remote-mcp-deployment.md` placeholder, `CLAUDE.md` pointer. No remote-MCP behavior is implemented; the tracking issue captures future work.

**Excluded:**
- No changes to handlers, event store, state-store semantics, or the composite tool surface.
- No implementation of remote-MCP transport, authn/authz, or multi-tenancy.
- No replacement of the existing `mcp__…` raw reference form during the migration window — detection is warning-only; the hard-fail lint rule is deferred to a follow-up PR after the transition window closes.

## Summary

- Total tasks: 32
- Parallel groups: 5 (A foundation, B parity, C rendering, D hardening, E docs/migration)
- Estimated test count: ~25 new/updated tests (1 acceptance, 18 integration, 4 unit, 1 property, 1 benchmark)
- Design coverage: 8 of 8 DRs traced (DR-6 covered by skeletal tasks 29–31 only)

## Spec Traceability

| DR    | Requirement                                 | Tasks              | Test layer (primary)       |
|-------|---------------------------------------------|--------------------|----------------------------|
| DR-1  | Runtime facade preference declaration       | 001, 002, 003      | integration                |
| DR-2  | Unified `{{CALL}}` placeholder macro        | 004–014            | acceptance + integration + unit + property |
| DR-3  | CLI output parity with MCP                  | 015–018            | integration                |
| DR-4  | End-to-end parity harness                   | 019, 020           | acceptance                 |
| DR-5  | Error handling, edge cases, failure modes   | 021–028            | integration + benchmark    |
| DR-6  | Remote MCP deployment axis (SKELETON ONLY)  | 029, 030, 031      | unit (type shape only)     |
| DR-7  | Documentation and positioning               | 032                | content (no tests)         |
| DR-8  | Migration and backward compatibility        | 028, 029, 030      | integration                |
| Architecture (current)                         | Deferred — explanatory diagram, no implementation | Deferred — diagram-only | Deferred |
| Architecture (target)                          | Deferred — explanatory diagram, no implementation | Deferred — diagram-only | Deferred |
| Placeholder macro semantics                    | 005 (parser implements the semantics described in the design subsection) | unit + property | Covered |

## Task Breakdown

### Group A — Foundation (DR-1)

### Task 001: Add `preferredFacade` to `RuntimeMapSchema`

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write tests in `src/runtimes/types.test.ts`:
   - `RuntimeMapSchema_MissingPreferredFacade_ThrowsValidationError`
   - `RuntimeMapSchema_InvalidPreferredFacade_ThrowsValidationError` (e.g. `"grpc"`)
   - `RuntimeMapSchema_ValidPreferredFacade_ParsesSuccessfully` (for both `"mcp"` and `"cli"`)
   - Expected failure: field does not exist; Zod does not reject missing/invalid values.
2. [GREEN] Add `preferredFacade: z.enum(['mcp', 'cli'])` as required field to `RuntimeMapSchema` in `src/runtimes/types.ts`. Export `PreferredFacade` type.
3. [REFACTOR] Group new field with `capabilities` block via comment header.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Verification:** Witnessed failure for each of three test cases; all pass after schema change.
**Dependencies:** None
**Parallelizable:** No (root dependency for tasks 002, 004+)

### Task 002: Populate `preferredFacade` across all six runtime YAMLs

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test `src/runtimes/load.test.ts::LoadAllRuntimes_PreferredFacadeAssignments_MatchCapabilityMatrix`:
   - Loads all six runtime YAMLs.
   - Asserts: `claude.yaml` → `mcp`; `cursor.yaml` → `mcp`; `codex.yaml` → `mcp`; `opencode.yaml` → `cli`; `copilot.yaml` → `cli`; `generic.yaml` → `cli`.
   - Expected failure: YAMLs do not yet declare the field; loader raises `ZodError`.
2. [GREEN] Add `preferredFacade` field to each of the six YAML files under `runtimes/`, with the value per the assertion above and a two-line header comment justifying the choice (referencing the host's MCP support maturity).
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Verification:** All six load assertions pass; re-running `npm run skills:guard` stays green.
**Dependencies:** 001
**Parallelizable:** No

### Task 003: Renderer surfaces `preferredFacade` on `RuntimeMap` consumers

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test `src/build-skills.test.ts::Renderer_RuntimeMap_ExposesPreferredFacade`:
   - Loads a runtime, asserts `runtime.preferredFacade` is accessible with the expected narrow type (`'mcp' | 'cli'`).
   - Expected failure: consumers may be destructuring only legacy fields; compile-time check enforces new field is read by downstream code.
2. [GREEN] Thread `preferredFacade` through the loader return shape so `buildAllSkills` can branch on it in later tasks. Purely a type-propagation change.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Dependencies:** 001, 002
**Parallelizable:** No

---

### Group B — CLI parity (DR-3) — parallel-safe with Group A/C

### Task 004 (parent ACCEPTANCE): `{{CALL}}` macro produces facade-appropriate output

**Phase:** RED (stays red until inner tasks complete)
**Test Layer:** acceptance
**Implements:** DR-2

**TDD Steps:**
1. [RED] Write acceptance test `src/build-skills.acceptance.test.ts::RenderSkill_CallMacroWithTwoRuntimes_ProducesFacadeAppropriateInvocations`:
   - Given a fixture skill source containing `{{CALL exarchos_workflow set {"featureId":"X","phase":"plan"}}}`
   - When rendered under a runtime with `preferredFacade: "mcp"` (claude fixture)
   - Then the output contains a valid MCP tool_use invocation including `mcp__plugin_exarchos_exarchos__exarchos_workflow`
   - And given the same source under a runtime with `preferredFacade: "cli"` (generic fixture)
   - Then the output contains a `Bash(exarchos workflow set --feature-id X --phase plan --json)` invocation
   - Expected failure: macro parser not yet present; renderer leaves token unresolved.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "acceptance" }`
**Dependencies:** 003
**Parallelizable:** No (gates Group C)

### Task 005: `parseCallMacro` — unit parser

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Acceptance Test Ref:** 004
**Implements:** DR-2

**Description:** Implements the placeholder macro semantics described in the design's Technical Design section. Parses `{{CALL tool action <args>}}` into a typed AST, validates argument JSON, and exposes the macro regex for reuse by the placeholder-lint vocabulary check.

**TDD Steps:**
1. [RED] Tests in `src/build-skills.test.ts`:
   - `ParseCallMacro_ValidInput_ReturnsTypedAst` (returns `{ tool, action, args }`)
   - `ParseCallMacro_MalformedJson_ThrowsDescriptiveError`
   - `ParseCallMacro_UnknownTool_ThrowsReferencingRegistry`
   - Expected failure: parser does not exist.
2. [GREEN] Implement `parseCallMacro(raw: string)` in `src/build-skills.ts`. Inputs: text matched by a new `CALL_MACRO_REGEX`. Outputs: typed AST or throw.
3. [REFACTOR] Extract `CALL_MACRO_REGEX` alongside `PLACEHOLDER_REGEX`; export for lint reuse.

**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, testLayer: "unit", properties: ["parse(serialize(ast)) === ast for all valid asts"] }`
**Dependencies:** 003
**Parallelizable:** Yes (with Group B parity tasks)

### Task 006: Validate parsed macro against `TOOL_REGISTRY`

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** 004
**Implements:** DR-2

**TDD Steps:**
1. [RED] Tests:
   - `ValidateCallMacro_UnknownAction_FailsAtBuildTime`
   - `ValidateCallMacro_InvalidArgs_FailsWithZodError` (e.g. wrong type for `featureId`)
   - `ValidateCallMacro_ValidCall_Passes`
   - Expected failure: validation not wired; unknown action silently passes.
2. [GREEN] Import the composite tool registry from `servers/exarchos-mcp/src/registry.ts` (via a cross-package helper). Resolve `(tool, action)` to its Zod schema; call `schema.safeParse(args)`; throw on failure with file+line context.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 005
**Parallelizable:** No

### Task 007: MCP rendering branch

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** 004
**Implements:** DR-2

**TDD Steps:**
1. [RED] Test `RenderCallMacro_McpFacade_EmitsToolUseBlockWithPrefix`:
   - Fixture runtime with `preferredFacade: "mcp"`, `mcpPrefix: "mcp__plugin_exarchos_exarchos__"`.
   - Asserts rendered output includes `mcp__plugin_exarchos_exarchos__exarchos_workflow` and a JSON argument block exactly matching the parsed args (plus `action` field).
   - Expected failure: renderer still emits raw `{{CALL}}` token or empty string.
2. [GREEN] In `src/build-skills.ts`, when `runtime.preferredFacade === 'mcp'`, emit the tool_use form using `runtime.capabilities.mcpPrefix`.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 006
**Parallelizable:** No (shares `src/build-skills.ts` with task 008; serialize)

### Task 008: CLI rendering branch with kebab-case arg mapping

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** 004
**Implements:** DR-2

**TDD Steps:**
1. [RED] Tests:
   - `RenderCallMacro_CliFacade_EmitsBashCommand` (asserts shape `Bash(exarchos workflow set --feature-id X --phase plan --json)`).
   - `RenderCallMacro_CliFacade_CamelCaseArgsBecomeKebabFlags` (verifies `featureId` → `--feature-id`).
   - `RenderCallMacro_CliFacade_BooleanArgsEmitNoArgumentFlag` (e.g. `dryRun: true` → `--dry-run`).
   - Expected failure: CLI branch not implemented.
2. [GREEN] Implement CLI branch. Import existing `toKebab` helper from `servers/exarchos-mcp/src/adapters/schema-to-flags.ts` to avoid drift. Always append `--json`.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 006, 007
**Parallelizable:** No (serialize after task 007; both write `src/build-skills.ts`)

### Task 009: Render-time failure for malformed or unknown calls

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** 004
**Implements:** DR-2

**TDD Steps:**
1. [RED] Tests:
   - `BuildAllSkills_CallMacroWithUnknownAction_FailsFast` (asserts `npm run build:skills` equivalent fails with a message naming the skill file and line).
   - `BuildAllSkills_CallMacroArgsFailSchema_FailsFast`.
   - Expected failure: renderer silently writes broken output.
2. [GREEN] Aggregate macro validation failures into a batched error from `buildAllSkills`; fail before any write.
3. [REFACTOR] Reuse the existing `assertNoUnresolvedPlaceholders` error shape.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 007, 008
**Parallelizable:** No

### Task 010: Placeholder-lint warns on raw `mcp__…` in skill sources

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-2, DR-8 (migration)

**TDD Steps:**
1. [RED] Tests in `src/placeholder-lint.test.ts`:
   - `LintSkillSource_RawMcpPrefix_EmitsDeprecationWarning` (warning-only; exit code still 0 during transition).
   - `LintSkillSource_CallMacro_NoWarning`.
   - Expected failure: lint has no rule for raw references.
2. [GREEN] Add deprecation detector: any `mcp__[a-z0-9_]+__[a-z_]+` in a `SKILL.md` source emits a warning with file path and line number. Controlled by `EXARCHOS_LINT_STRICT=1` env var to flip warning → error after the transition window.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 009
**Parallelizable:** Yes (with 011)

### Task 011: `skills:guard` tolerance for `{{CALL}}` rendered output

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-2

**TDD Steps:**
1. [RED] Test in `src/skills-guard.test.ts`:
   - `SkillsGuard_AfterCallMacroRender_NoDrift` — runs the renderer over a fixture, then runs guard; asserts zero diff.
   - Expected failure: guard may flag newly rendered strings as unexpected.
2. [GREEN] Update guard to ignore synthesized invocation blocks (they are content, not drift).
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 009
**Parallelizable:** Yes (with 010)

### Task 012: Acceptance test 004 goes GREEN

**Phase:** GREEN (verification only)
**Implements:** DR-2

**Verification:** After tasks 005–011 merge, the parent acceptance test `RenderSkill_CallMacroWithTwoRuntimes_ProducesFacadeAppropriateInvocations` passes end-to-end. No new code; this is the provenance closing task.

**Dependencies:** 005, 006, 007, 008, 009, 010, 011
**Parallelizable:** No

---

### Group C — CLI parity (DR-3) — parallelizable with Group A

### Task 013: Exit-code mapping + error-shape alignment in CLI adapter

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-3
**Forward-compatible with:** v3.0 P1 #1096 (rich exit codes) — adopt the v3.0 domain-specific exit code scheme from day one so P1 inherits this work rather than re-doing it.

**TDD Steps:**
1. [RED] Tests in `servers/exarchos-mcp/src/adapters/cli.test.ts`:
   - `CliInvocation_SuccessCase_Returns0AndStructuredPayload`.
   - `CliInvocation_InvalidInput_Returns3WithInvalidInputCode`.
   - `CliInvocation_HandlerReportedError_Returns2WithErrorCode`.
   - `CliInvocation_GateFailure_Returns2`.
   - `CliInvocation_NotFound_Returns4`.
   - `CliInvocation_UncaughtException_Returns1`.
   - Expected failure: exit codes are unmapped or inconsistent.
2. [GREEN] Add exit-code constants module in `adapters/cli.ts` with domain-specific codes (0=Success, 1=GeneralError, 2=GateFailed, 3=InvalidInput, 4=NotFound, 5=PhaseViolation, 10=StorageError, 15=ConfigError, 17=WaitTimeout, 18=WaitFailed, 20=ExportFailed). Normalize error payload shape to `{ error: { code, message } }` matching MCP `ToolResult.error`. Codes 17/18/20 are placeholders for v3.0 P4 lifecycle verbs — defined now for forward-compatibility.
3. [REFACTOR] Extract exit code constants to a named export for reuse by parity tests and v3.0 work.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** None (parallel with Group A)
**Parallelizable:** Yes

### Task 014: Parity test — `exarchos_workflow` actions

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-3
**Design note (v3.0 compatibility):** Parity assertions compare at the **`ToolResult` dispatch level** (the output of `dispatch()`) before any adapter-level envelope wrapping. This ensures v3.0 P2's HATEOAS envelope (#1088), which wraps `ToolResult` at the adapter layer, does not break these tests. Assert on `result.success`, `result.data`, `result.error` — not on the full adapter response shape.

**TDD Steps:**
1. [RED] Tests in `servers/exarchos-mcp/src/workflow/parity.test.ts`:
   - `WorkflowParity_Init_CliAndMcp_ReturnEqualPayload`.
   - `WorkflowParity_Get_CliAndMcp_ReturnEqualPayload`.
   - `WorkflowParity_Set_CliAndMcp_ReturnEqualPayload`.
   - Shared helper: invoke each action via MCP adapter and CLI adapter `--json`; assert deep-equal on `ToolResult` fields (`success`, `data`, `error`, `warnings`) modulo timestamps/UUIDs (normalize before compare). Do not assert on adapter-layer envelope fields.
   - Expected failure: adapters diverge in payload shape (e.g. CLI prettyPrint sneaks in).
2. [GREEN] Ensure CLI `--json` mode emits exactly the `ToolResult` payload.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 013
**Parallelizable:** Yes (parallel with 015, 016, 017)

### Task 015: Parity test — `exarchos_event`

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-3

Same shape as 014, over `event` composite tool. Files: `servers/exarchos-mcp/src/event-store/parity.test.ts`.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 013
**Parallelizable:** Yes

### Task 016: Parity test — `exarchos_orchestrate`

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-3

Same shape as 014, over `orchestrate` composite tool. Subset of fastest-running actions to keep CI time bounded: `check_design_completeness`, `check_plan_coverage`, `task_claim`, `task_complete`.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 013
**Parallelizable:** Yes

### Task 017: Parity test — `exarchos_view`

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-3

Same shape as 014, over `view` composite tool. Files: `servers/exarchos-mcp/src/views/parity.test.ts`.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 013
**Parallelizable:** Yes

---

### Group D — Parity harness (DR-4) + Hardening (DR-5)

### Task 018: Acceptance test — canonical workflow parity harness

**Phase:** RED
**Test Layer:** acceptance
**Implements:** DR-4

**TDD Steps:**
1. [RED] Test `servers/exarchos-mcp/src/__tests__/facade-parity.acceptance.test.ts::CanonicalWorkflow_CliVsMcp_IdenticalEventStore`:
   - Create two temporary state directories (CLI-sandbox, MCP-sandbox).
   - Run the canonical `ideate → plan → delegate → review → synthesize` sequence (using a minimal fixture design) via CLI-rendered commands into sandbox A and MCP-rendered tool calls into sandbox B.
   - Normalize timestamps and UUIDs; assert event-store JSONL files are equal and SQLite user-facing columns match.
   - Expected failure: harness not yet wired.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "acceptance" }`
**Dependencies:** 012, 013, 014, 015, 016, 017
**Parallelizable:** No

### Task 019: Implement parity harness

**Phase:** GREEN → REFACTOR
**Test Layer:** acceptance (drives 018 to green)
**Acceptance Test Ref:** 018
**Implements:** DR-4

**TDD Steps:**
1. [GREEN] Build the harness: a helper that spawns `exarchos <tool> <action> …` processes for the CLI arm and calls `dispatch()` in-process for the MCP arm. Timestamp/UUID normalizer; diff reporter that surfaces the first diverging event with a rendered diff.
2. [REFACTOR] Extract fixture builder so follow-up tests can reuse.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "acceptance" }`
**Dependencies:** 018
**Parallelizable:** No

### Task 020: Missing-facade actionable errors

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-5

**TDD Steps:**
1. [RED] Tests:
   - `McpMissingAtRuntime_RenderedSkillEmitsActionableError` — host lacks MCP; rendered skill body includes a remediation pointer and avoids silent failure.
   - `BashMissingAtRuntime_RenderedSkillEmitsActionableError` — equivalent for the CLI path.
2. [GREEN] In the renderer, when a runtime declares a facade but the skill authoring hints detection is impossible, emit a conditional "if <facade> is unavailable, <remediation>" line in the rendered output.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 012
**Parallelizable:** Yes (with 021, 022, 023)

### Task 021: CLI cold-start benchmark

**Phase:** RED → GREEN
**Test Layer:** unit (benchmark)
**Implements:** DR-5

**TDD Steps:**
1. [RED] Benchmark fixture `servers/exarchos-mcp/src/bench/cli-startup.bench.ts`:
   - Invokes `exarchos workflow get --feature-id X --json` via child_process 50 times, collects p50/p95/p99.
   - Asserts p95 < 250ms.
   - Expected failure: benchmark does not exist or budget is tight.
2. [GREEN] Add the benchmark; document actual p95 in the test output. If budget is exceeded, add targeted laziness (defer SQLite init when the action does not touch state).
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: true, testLayer: "unit", performanceSLAs: [{ "operation": "cli-cold-start", "metric": "p95_ms", "threshold": 250 }] }`
**Dependencies:** 013
**Parallelizable:** Yes

### Task 022: Concurrent CLI invocation safety

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-5

**TDD Steps:**
1. [RED] Test `servers/exarchos-mcp/src/event-store/cli-concurrency.test.ts::ConcurrentCliEventAppend_SameFeatureId_ProducesConsistentStore`:
   - Spawns two `exarchos event append` processes against the same featureId concurrently; asserts the resulting event-store has no interleaved half-writes, no duplicate sequences, and equals the sequential-append outcome.
   - Expected failure: today's CLI path has no lock; parallel invocations race.
2. [GREEN] Add an advisory file lock (e.g. `proper-lockfile`) or rely on SQLite transaction discipline — whichever is simpler given the storage backend.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 013
**Parallelizable:** Yes (with 021, 023)

### Task 023: Long-running operation progress discipline

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-5

**TDD Steps:**
1. [RED] Tests:
   - `LongRunningOrchestrateAction_CliInvocation_EmitsLineBufferedProgressOrExitsQuickly` — flagged actions either stream stderr or complete fast enough to not need progress.
   - `OrchestrateActionRegistry_LongRunningFlagPresent` — the registry correctly flags at least one action (e.g. `prepare_synthesis`) as `longRunning: true`.
   - Expected failure: neither the flag nor the discipline exists.
2. [GREEN] Add `longRunning?: boolean` to action metadata in `servers/exarchos-mcp/src/registry.ts`. Flag two candidate actions. In the CLI adapter, if the action is long-running, stream stderr heartbeats every 2s; if not, no change.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 013
**Parallelizable:** Yes

### Task 024: Argument coercion failure parity

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-5

**TDD Steps:**
1. [RED] Test `servers/exarchos-mcp/src/adapters/schema-to-flags.parity.test.ts::MalformedArgs_BothFacades_RejectWithSameErrorCode`:
   - Feeds malformed arguments (missing required field, wrong type) through both adapters.
   - Asserts the returned `error.code` is identical and the message is equivalent.
2. [GREEN] If divergent, unify error emission through a shared helper.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Dependencies:** 013
**Parallelizable:** Yes

---

### Group E — Skeleton + Docs + Migration (DR-6, DR-7, DR-8)

### Task 025: `RemoteMcpAdapter` interface skeleton

**Phase:** RED → GREEN
**Test Layer:** unit (type-shape only)
**Implements:** DR-6 (SKELETON ONLY)

**TDD Steps:**
1. [RED] Test `servers/exarchos-mcp/src/adapters/remote-mcp.test.ts::RemoteMcpAdapter_Interface_CompilesAsTypeShape`:
   - Imports the interface and asserts its exported shape (e.g. via a type assertion that any attempt to implement it requires the declared methods). Runtime test that calling any method throws `NotImplementedError`.
   - Expected failure: file does not exist.
2. [GREEN] Create `servers/exarchos-mcp/src/adapters/remote-mcp.ts`:
   ```ts
   export interface RemoteMcpAdapter {
     dispatch(tool: string, args: unknown): Promise<unknown>;
     close(): Promise<void>;
   }
   export class NotImplementedRemoteMcpAdapter implements RemoteMcpAdapter {
     async dispatch(): Promise<never> { throw new NotImplementedError('remote-mcp not implemented'); }
     async close(): Promise<void> { /* noop */ }
   }
   ```
   Gate usage behind `process.env.EXARCHOS_REMOTE_MCP === '1'`.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Dependencies:** None
**Parallelizable:** Yes (with any Group A/B/C/D task)

### Task 026: Stub design doc and `CLAUDE.md` pointer

**Phase:** N/A (content)
**Test Layer:** n/a
**Implements:** DR-6 (SKELETON ONLY)

**Steps:**
- Create `docs/designs/future/remote-mcp-deployment.md` with placeholder sections: Problem Statement, Deployment Model, Authn/Authz, Multi-Tenancy, State Storage, Migration Path, Open Questions. Each marked `TODO`.
- Add one line to `CLAUDE.md` under Architecture: `Remote MCP is a future deployment axis — see \`docs/designs/future/remote-mcp-deployment.md\` (tracking: #1081).`

**Verification:** `npm run docs:build` succeeds (link check). `CLAUDE.md` reads cleanly.
**Dependencies:** None
**Parallelizable:** Yes

### Task 027: Documentation — "Facade and Deployment Choices" page

**Phase:** N/A (content + link check)
**Test Layer:** n/a
**Implements:** DR-7

**Description:** Documentation and positioning work for the dual-facade architecture. Creates a user-facing VitePress page explaining the three orthogonal axes (local CLI invocation, local MCP invocation, hosted MCP deployment) and the positioning of each for readers choosing an install profile.

**Steps:**
- Create `documentation/facade-and-deployment.md` with the 3x3 decision matrix (rows: host capability — MCP-native / CLI-only / unknown; columns: local CLI invocation / local MCP invocation / hosted MCP deployment; cells: recommended configuration).
- Add the page to `documentation/.vitepress/config.ts` sidebar.
- Add header comments referencing the page in all six `runtimes/*.yaml` files.
- Add a one-line mention in top-level `README.md` under "How it works."

**Verification:** `npm run docs:build` and `npm run docs:preview` render without broken links.
**Dependencies:** 002 (YAMLs already updated with the field), 003
**Parallelizable:** Yes

### Task 028: Migration — no-regression integration test

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-8

**Description:** Migration and backward compatibility verification for existing Claude Code plugin installs. Ensures the dual-facade rendering change preserves pre-migration output for MCP-native runtimes so no user action is required to stay functional.

**TDD Steps:**
1. [RED] Test `src/build-skills.migration.test.ts::ExistingClaudeCodeInstall_AfterMigration_RendersIdenticalOutput`:
   - Snapshot fixture: a pre-migration rendered Claude skill directory tree.
   - After renderer runs on current `skills-src/`, the Claude variant matches the pre-migration fixture modulo the new `{{CALL}}` expansions (which resolve to MCP form on Claude).
   - Expected failure: subtle rendering drift may slip in.
2. [GREEN] Resolve drift. If any drift is intentional (e.g. new skills), update the fixture with a justification comment in the test.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: true }`
**Dependencies:** 012
**Parallelizable:** No

### Task 029: CHANGELOG + transition window docs

**Phase:** N/A (content)
**Implements:** DR-8

**Steps:**
- Add `CHANGELOG.md` entry under an `## [Unreleased]` section: describe `preferredFacade` runtime field, `{{CALL}}` macro, CLI rendering path for generic/opencode/copilot runtimes, and the `EXARCHOS_LINT_STRICT=1` escape hatch for the transition window.
- Add a short "Migrating to `{{CALL}}`" note to `documentation/` (link-check from the facade-and-deployment page).
- File a follow-up issue: "Close `mcp__…` raw-reference transition window — flip lint to error by default" (tracked separately; one minor version after this lands).

**Verification:** `npm run docs:build` succeeds.
**Dependencies:** 010, 027
**Parallelizable:** Yes (parallel with 028)

### Task 030: Sync version numbers

**Phase:** N/A (hygiene)
**Implements:** DR-8

**Steps:**
- Run `npm run version:check`; if a bump is warranted by the scope of changes, apply `npm run version:sync` to align `package.json` entries.

**Dependencies:** 028, 029
**Parallelizable:** No

---

### Group F — Verification gates

### Task 031: TDD compliance verification

**Phase:** N/A (verification)
**Implements:** all DRs

**Steps:**
- After all branches merge into the integration branch, run:
  ```typescript
  exarchos_orchestrate({
    action: "check_tdd_compliance",
    featureId: "cli-vs-mcp-facade-analysis",
    branch: "feature/dual-facade-skill-rendering"
  })
  ```
- Resolve any flagged commits that added implementation without a failing test.

**Dependencies:** all earlier tasks
**Parallelizable:** No

### Task 032: Pre-synthesis check

**Phase:** N/A (verification)
**Implements:** all DRs

**Steps:**
- `npm run test:run` — all suites green.
- `npm run typecheck` — clean.
- `npm run skills:guard` — no drift.
- `npm run build` — success.
- `npm run docs:build` — success.
- Run `exarchos_orchestrate({ action: "pre_synthesis_check", featureId: "cli-vs-mcp-facade-analysis" })`.

**Dependencies:** 031
**Parallelizable:** No

---

## Parallelization Strategy

```
Group A (Foundation, DR-1)           Group B (CLI adapter, DR-3)
  001 → 002 → 003                      013 → (014 ∥ 015 ∥ 016 ∥ 017)
         │
         ▼
Group C (CALL macro, DR-2)
  004 (acceptance parent, stays RED)
    ↓
  005 → 006 → (007 ∥ 008) → 009 → (010 ∥ 011) → 012 (acceptance closes GREEN)

Group D (Harness + Hardening, DR-4/5)
  (after 012 and 017)
  018 → 019        Parallel-safe with each other (independent concerns):
                    020 ∥ 021 ∥ 022 ∥ 023 ∥ 024

Group E (Skeleton + Docs + Migration, DR-6/7/8)
  025 (standalone)          ∥  026 (standalone)
  027 (after 002, 003)
  028 (after 012)
  029 (after 010, 027)
  030 (after 028, 029)

Group F — final verification (031 → 032)
```

**Worktree assignment (proposed):**
- Worktree α — Group A (foundation)
- Worktree β — Group B (CLI parity) — runs in parallel with α
- Worktree γ — Group C (macro) — serial after α (needs `preferredFacade` types)
- Worktree δ — Group D (harness + hardening) — after γ merges; spawn sub-worktrees for 020/021/022/023/024 since each touches disjoint files
- Worktree ε — Group E (skeleton + docs + migration) — can start early (025, 026) and finish after γ (028, 029)

## Deferred Items

- **Hard-fail lint rule for raw `mcp__…` references** — deferred to a follow-up PR one minor version after this ships. Task 010 lands the warning-only detector; the escape-hatch env var exists for early adopters who want to enforce today.
- **Structured `--progress-fd` protocol for long-running CLI ops** — deferred. Task 023 lands line-buffered stderr heartbeats; a richer protocol awaits first concrete consumer need.
- **Per-(runtime × action) facade overrides** — deferred. Starting with per-runtime preference; revisit if we observe a runtime that wants MCP for short ops but CLI for long ones.
- **Remote MCP implementation (DR-6 body)** — deferred to [lvlup-sw/exarchos#1081](https://github.com/lvlup-sw/exarchos/issues/1081). Only the skeleton interface + stub doc + `CLAUDE.md` pointer ship in this effort.

## Relationship to v3.0 Roadmap

This plan is a **foundation** for the v3.0 CLI roadmap pillars ([cross-cutting constraints: #1109](https://github.com/lvlup-sw/exarchos/issues/1109)). The dual-facade work establishes the skill rendering and CLI parity infrastructure that v3.0 pillars build on.

**Dependency graph:**
```
cli-vs-mcp-facade-analysis (this plan)
  │
  ├── prerequisite for ──→ P1 #1087 (CLI Ergonomic Infrastructure)
  │     IInteractionService builds on the CLI adapter work from DR-3/DR-5.
  │     Exit code constants (Task 013) adopted by P1 #1096.
  │
  ├── prerequisite for ──→ P2 #1088 (Agent Output Contract)
  │     HATEOAS envelope wraps ToolResult that DR-3 validates.
  │     Parity tests (Tasks 014-017) designed at ToolResult level to survive envelope.
  │
  ├── independent of ───→ P3 #1089 (doctor) — new dispatch action
  ├── independent of ───→ P4 #1090 (lifecycle verbs) — new dispatch actions
  └── independent of ───→ P5 #1091 (init enhancement) — installer scope

**Forward-compatibility commitments in this plan:**
- Task 013 adopts v3.0's domain-specific exit code scheme (13+ codes, not 4)
- Tasks 014-017 assert at `ToolResult` dispatch level, not adapter envelope level
- Task 023's stderr heartbeats are a stepping stone to P2's NDJSON streaming

## Completion Checklist

- [ ] All tests written before implementation (TDD order verified via `check_tdd_compliance`)
- [ ] All tests pass (`npm run test:run`)
- [ ] Typecheck clean (`npm run typecheck`)
- [ ] Skills build + guard clean (`npm run build:skills && npm run skills:guard`)
- [ ] Docs build clean (`npm run docs:build`)
- [ ] Coverage thresholds met (line 80, branch 70, function 100)
- [ ] Plan-coverage check passes
- [ ] Provenance chain passes (every DR-N traces to ≥1 task)
- [ ] Pre-synthesis check passes
- [ ] Issue #1081 referenced from both design and plan
- [ ] Ready for review
