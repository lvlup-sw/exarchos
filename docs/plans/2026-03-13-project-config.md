# Implementation Plan: Per-Project Configuration via `.exarchos.yml`

**Design:** `docs/designs/2026-03-13-project-config.md`
**Issues:** #1024

## Architecture Notes

This feature adds a **new** `ProjectConfig` type (YAML-driven declarative overrides) alongside the existing `ExarchosConfig` (TypeScript-driven programmatic extensions). They are complementary:

- `.exarchos.yml` → `ProjectConfig` → overrides built-in defaults (review criteria, VCS, workflow behavior, tools, hooks)
- `exarchos.config.ts` → `ExarchosConfig` → adds new workflow types, events, views, tools

Loading order: YAML overrides applied to defaults first, then TypeScript extensions registered on top.

The existing `DispatchContext` already has a `config` field for `ExarchosConfig`. We add `projectConfig: ResolvedProjectConfig` alongside it.

## Task Summary

| Task | Description | Layer | Implements | Dependencies |
|------|-------------|-------|-----------|--------------|
| 001 | ProjectConfig Zod schema | MCP | R1 | None |
| 002 | YAML loader + project root discovery | MCP | R1 | 001 |
| 003 | Config resolution (deep merge + defaults) | MCP | R2 | 001 |
| 004 | DispatchContext integration | MCP | R2 | 002, 003 |
| 005 | Gate severity resolution | MCP | R3 | 003 |
| 006 | Gate handler integration | MCP | R3 | 004, 005 |
| 007 | VCS provider interface | MCP | R4 | None |
| 008 | GitHub VCS provider | MCP | R4 | 007 |
| 009 | VCS provider factory + config wiring | MCP | R4 | 004, 008 |
| 010 | Workflow phase skipping | MCP | R5 | 003 |
| 011 | Phase skip HSM integration | MCP | R5 | 004, 010 |
| 012 | Tools config surface | MCP | R6 | 004 |
| 013 | Event hook runner | MCP | R7 | 003 |
| 014 | Event hook wiring to EventStore | MCP | R7 | 004, 013 |
| 015 | Config describe action | MCP | R8 | 004 |

## Parallelization Groups

```
Group A (sequential):  001 → 002 → 003 → 004   [Core config pipeline]
Group B (sequential):  007 → 008                 [VCS provider — independent of config]
Group C (independent): 005                        [Gate severity — needs 003 only]
Group D (independent): 010                        [Phase skip logic — needs 003 only]
Group E (independent): 013                        [Event hook runner — needs 003 only]

After Group A:
  Group F: 006 (gate handler integration — needs 004 + 005)
  Group G: 009 (VCS factory wiring — needs 004 + 008)
  Group H: 011 (phase skip HSM — needs 004 + 010)
  Group I: 012 (tools config — needs 004)
  Group J: 014 (hook wiring — needs 004 + 013)
  Group K: 015 (config describe — needs 004)
```

Recommended agent assignment:
- **Agent 1:** Tasks 001-004 (Core config pipeline — sequential chain)
- **Agent 2:** Tasks 007-008, 009 (VCS provider interface + GitHub impl + factory)
- **Agent 3:** Tasks 005, 006 (Gate severity resolution + handler integration)
- **Agent 4:** Tasks 010, 011 (Phase skipping logic + HSM integration)
- **Agent 5:** Tasks 013, 014 (Event hook runner + EventStore wiring)
- **Agent 6:** Tasks 012, 015 (Tools config surface + config describe)

---

## Task Details

### Task 001: ProjectConfig Zod Schema
**Phase:** RED → GREEN → REFACTOR
**Implements:** R1

1. **[RED]** Write tests for the YAML config validation schema.
   - File: `servers/exarchos-mcp/src/config/yaml-schema.test.ts`
   - Tests:
     - `ProjectConfigSchema_EmptyObject_Passes` — `{}` validates successfully
     - `ProjectConfigSchema_FullConfig_Passes` — complete config with all sections validates
     - `ProjectConfigSchema_DimensionShorthand_Passes` — `D3: "warning"` accepted
     - `ProjectConfigSchema_DimensionLongform_Passes` — `D3: { severity: "warning" }` accepted
     - `ProjectConfigSchema_InvalidDimensionKey_Fails` — `D6` rejected with error
     - `ProjectConfigSchema_GateConfig_ValidatesParams` — gate with params passes
     - `ProjectConfigSchema_RiskWeights_MustSumToOne` — weights summing to 0.85 rejected
     - `ProjectConfigSchema_RiskWeights_SumToOne_Passes` — weights summing to 1.0 passes
     - `ProjectConfigSchema_UnknownTopLevelKey_Fails` — `{ foo: 1 }` rejected (strict mode)
     - `ProjectConfigSchema_VcsProvider_ValidatesEnum` — only github/gitlab/azure-devops accepted
     - `ProjectConfigSchema_SkipPhases_AcceptsStringArray` — `["plan-review"]` passes
     - `ProjectConfigSchema_MaxFixCycles_ValidatesRange` — 0 rejected, 1-10 accepted, 11 rejected
     - `ProjectConfigSchema_HookAction_RequiresCommand` — hook without command rejected
     - `ProjectConfigSchema_HookTimeout_ValidatesRange` — timeout 500 rejected (min 1000), 300001 rejected (max 300000)
     - `ProjectConfigSchema_ToolsSection_ValidatesEnums` — commit-style and pr-strategy enum validation
   - Expected failure: `ProjectConfigSchema` does not exist

2. **[GREEN]** Implement the Zod schema.
   - File: `servers/exarchos-mcp/src/config/yaml-schema.ts`
   - Export: `ProjectConfigSchema`, `ProjectConfig` type, dimension/gate/routing/vcs/workflow/tools/hooks sub-schemas
   - Use `z.union()` for dimension shorthand/longform
   - Use `.strict()` on top-level object
   - Use `.refine()` for risk-weights sum validation

3. **[REFACTOR]** Extract shared dimension severity enum if reused elsewhere.

**Dependencies:** None

---

### Task 002: YAML Loader + Project Root Discovery
**Phase:** RED → GREEN → REFACTOR
**Implements:** R1

1. **[RED]** Write tests for YAML file loading and project root discovery.
   - File: `servers/exarchos-mcp/src/config/yaml-loader.test.ts`
   - Tests:
     - `loadProjectConfig_NoFile_ReturnsEmptyConfig` — missing `.exarchos.yml` returns `{}`
     - `loadProjectConfig_ValidYaml_ParsesAllSections` — full YAML file parsed correctly
     - `loadProjectConfig_YmlExtension_Loaded` — `.exarchos.yml` discovered
     - `loadProjectConfig_YamlExtension_Loaded` — `.exarchos.yaml` also discovered
     - `loadProjectConfig_MalformedYaml_ThrowsWithMessage` — syntax error produces helpful error
     - `loadProjectConfig_InvalidSchema_ReturnsPartialWithWarnings` — invalid section falls back to default, valid sections preserved
     - `discoverProjectRoot_EnvVar_TakesPrecedence` — `$EXARCHOS_PROJECT_ROOT` used first
     - `discoverProjectRoot_WalksUpForYml_FindsRoot` — walks up directories to find `.exarchos.yml`
     - `discoverProjectRoot_FallsBackToGitRoot` — uses git root when no config file found
     - `discoverProjectRoot_NothingFound_UsesCwd` — returns CWD as last resort
   - Expected failure: `loadProjectConfig` and `discoverProjectRoot` do not exist

2. **[GREEN]** Implement YAML loader and project root discovery.
   - File: `servers/exarchos-mcp/src/config/yaml-loader.ts`
   - Export: `loadProjectConfig(projectRoot: string): ProjectConfig`
   - Export: `discoverProjectRoot(cwd?: string): string`
   - Use `yaml` npm package for parsing
   - Validate against `ProjectConfigSchema` from task 001
   - Partial failure: catch per-section Zod errors, log warnings, return valid sections

3. **[REFACTOR]** Ensure error messages include file path and line numbers where possible.

**Dependencies:** 001

---

### Task 003: Config Resolution (Deep Merge + Defaults)
**Phase:** RED → GREEN → REFACTOR
**Implements:** R2

1. **[RED]** Write tests for config resolution.
   - File: `servers/exarchos-mcp/src/config/resolve.test.ts`
   - Tests:
     - `resolveConfig_EmptyProject_ReturnsAllDefaults` — `{}` produces full `ResolvedProjectConfig` with all defaults
     - `resolveConfig_DimensionOverride_MergesOntoDefaults` — `D3: "warning"` overrides only D3, others remain "blocking"
     - `resolveConfig_DimensionShorthand_NormalizesToObject` — `"warning"` normalized to `{ severity: "warning", enabled: true }`
     - `resolveConfig_GateOverride_MergedOntoEmptyDefault` — gate config added to empty default gates map
     - `resolveConfig_RoutingThreshold_OverridesDefault` — threshold 0.6 overrides default 0.4
     - `resolveConfig_RiskWeights_FullReplace` — custom weights fully replace defaults (not merged)
     - `resolveConfig_VcsProvider_OverridesDefault` — `gitlab` overrides default `github`
     - `resolveConfig_SkipPhases_AddedToEmptyDefault` — skip phases added to empty default array
     - `resolveConfig_MaxFixCycles_OverridesDefault` — custom value overrides default 3
     - `resolveConfig_ToolsPartial_MergesWithDefaults` — setting only `auto-merge: false` preserves other tool defaults
     - `resolveConfig_HooksOn_MergedByEventType` — hook handlers merged by event type key
     - `resolveConfig_Result_IsFrozen` — returned object is deeply frozen (immutable)
     - `resolveConfig_DefaultBranch_UndefinedByDefault` — defaults to undefined (auto-detect)
   - Expected failure: `resolveConfig` and `ResolvedProjectConfig` do not exist

2. **[GREEN]** Implement config resolution.
   - File: `servers/exarchos-mcp/src/config/resolve.ts`
   - Export: `resolveConfig(project: ProjectConfig): ResolvedProjectConfig`
   - Export: `ResolvedProjectConfig` interface (all fields required, no optionals)
   - Export: `DEFAULTS` constant
   - Implement `normalize()` to convert shorthand forms to canonical
   - Implement `deepMerge()` for overlay semantics
   - Freeze the result with `Object.freeze()` recursively

3. **[REFACTOR]** Extract `deepFreeze` utility if useful elsewhere.

**Dependencies:** 001

---

### Task 004: DispatchContext Integration
**Phase:** RED → GREEN → REFACTOR
**Implements:** R2

1. **[RED]** Write tests for project config flowing through dispatch context.
   - File: `servers/exarchos-mcp/src/core/context.test.ts` (extend existing or create)
   - Tests:
     - `initializeContext_WithProjectRoot_LoadsProjectConfig` — resolved config available on ctx
     - `initializeContext_NoYml_ProjectConfigIsDefaults` — missing YAML → all defaults
     - `initializeContext_ProjectConfigBeforeExarchosConfig` — YAML loaded before `.config.ts`
     - `dispatch_ProjectConfig_PassedToHandlers` — handlers receive `ctx.projectConfig`
   - Expected failure: `projectConfig` not on `DispatchContext`

2. **[GREEN]** Add `projectConfig` to DispatchContext and wire loading.
   - File: `servers/exarchos-mcp/src/core/dispatch.ts` — add `projectConfig?: ResolvedProjectConfig` to interface
   - File: `servers/exarchos-mcp/src/core/context.ts` — call `loadProjectConfig()` + `resolveConfig()` before existing config loading
   - Ensure `projectConfig` is available on the context passed to composite handlers

3. **[REFACTOR]** Clean up context initialization ordering if needed.

**Dependencies:** 002, 003

---

### Task 005: Gate Severity Resolution
**Phase:** RED → GREEN → REFACTOR
**Implements:** R3

1. **[RED]** Write tests for gate severity resolution logic.
   - File: `servers/exarchos-mcp/src/orchestrate/gate-severity.test.ts`
   - Tests:
     - `resolveGateSeverity_NoOverrides_ReturnsBlocking` — default dimension blocking, no gate override → blocking
     - `resolveGateSeverity_DimensionWarning_ReturnsWarning` — D3 set to warning → warning
     - `resolveGateSeverity_DimensionDisabled_ReturnsDisabled` — D5 disabled → disabled
     - `resolveGateSeverity_GateBlockingTrue_OverridesDimension` — gate blocking=true even when dimension is warning → blocking
     - `resolveGateSeverity_GateBlockingFalse_OverridesDimension` — gate blocking=false even when dimension is blocking → warning
     - `resolveGateSeverity_GateDisabled_OverridesDimension` — gate enabled=false even when dimension is blocking → disabled
     - `resolveGateSeverity_GateEnabled_DimensionDisabled_RespectsGate` — gate enabled + dimension disabled → gate wins (blocking)
     - `resolveGateSeverity_UnknownGate_FallsBackToDimension` — gate not in overrides → dimension severity
     - `resolveGateSeverity_UnknownDimension_DefaultsBlocking` — unknown dimension key → blocking
   - Expected failure: `resolveGateSeverity` does not exist

2. **[GREEN]** Implement gate severity resolution.
   - File: `servers/exarchos-mcp/src/orchestrate/gate-severity.ts`
   - Export: `resolveGateSeverity(gateName: string, dimension: string, config: ResolvedProjectConfig): 'blocking' | 'warning' | 'disabled'`
   - Gate-level overrides take precedence over dimension-level
   - Unknown gates fall back to dimension; unknown dimensions default to blocking

3. **[REFACTOR]** None expected.

**Dependencies:** 003

---

### Task 006: Gate Handler Integration
**Phase:** RED → GREEN → REFACTOR
**Implements:** R3

1. **[RED]** Write tests for config-aware gate handler behavior.
   - File: `servers/exarchos-mcp/src/orchestrate/config-gate-integration.test.ts`
   - Tests:
     - `GateHandler_DisabledGate_SkipsExecution` — gate with severity=disabled returns `{ skipped: true }` without running check
     - `GateHandler_WarningGate_ExecutesButDoesNotBlock` — gate fails but severity=warning → success=true with warning message
     - `GateHandler_BlockingGate_FailureBlocks` — gate fails with severity=blocking → standard failure behavior
     - `GateHandler_NoProjectConfig_DefaultBehavior` — when `projectConfig` is undefined, all gates behave as blocking (backwards compat)
     - `GateHandler_GateParams_PassedToHandler` — gate params from config flow into handler logic
   - Expected failure: gate handlers don't read `projectConfig`

2. **[GREEN]** Update gate handler pattern to be config-aware.
   - File: `servers/exarchos-mcp/src/orchestrate/gate-utils.ts` — add `withConfigSeverity()` wrapper
   - The wrapper:
     1. Reads severity from `resolveGateSeverity()`
     2. If disabled: return skip result
     3. If warning/blocking: run handler, then adjust result based on severity
   - Update 2-3 representative gate handlers to use the wrapper (e.g., `static-analysis.ts`, `tdd-compliance.ts`, `security-scan.ts`)

3. **[REFACTOR]** Ensure all gate handlers can be incrementally migrated to the wrapper pattern.

**Dependencies:** 004, 005

---

### Task 007: VCS Provider Interface
**Phase:** RED → GREEN → REFACTOR
**Implements:** R4

1. **[RED]** Write tests for the VCS provider interface contract.
   - File: `servers/exarchos-mcp/src/vcs/provider.test.ts`
   - Tests:
     - `VcsProvider_Interface_DefinesRequiredMethods` — type-level test that all methods exist on interface
     - `GitLabProvider_CreatePr_ThrowsNotImplemented` — stub provider returns clear error
     - `AzureDevOpsProvider_CreatePr_ThrowsNotImplemented` — stub provider returns clear error
   - Expected failure: `VcsProvider` interface does not exist

2. **[GREEN]** Define the VCS provider interface and stub implementations.
   - File: `servers/exarchos-mcp/src/vcs/provider.ts`
   - Export: `VcsProvider` interface with methods: `createPr`, `checkCi`, `mergePr`, `addComment`, `getReviewStatus`
   - Export: supporting types: `CreatePrOpts`, `PrResult`, `CiStatus`, `MergeResult`, `ReviewStatus`
   - File: `servers/exarchos-mcp/src/vcs/gitlab.ts` — stub with "not yet implemented" errors
   - File: `servers/exarchos-mcp/src/vcs/azure-devops.ts` — stub with "not yet implemented" errors

3. **[REFACTOR]** None expected.

**Dependencies:** None

---

### Task 008: GitHub VCS Provider
**Phase:** RED → GREEN → REFACTOR
**Implements:** R4

1. **[RED]** Write tests for GitHub provider methods.
   - File: `servers/exarchos-mcp/src/vcs/github.test.ts`
   - Tests:
     - `GitHubProvider_CreatePr_CallsGhWithCorrectArgs` — verifies `gh pr create` CLI invocation
     - `GitHubProvider_CheckCi_ParsesGhOutput` — parses `gh pr checks` output to `CiStatus`
     - `GitHubProvider_MergePr_UsesConfigStrategy` — merge strategy from settings used
     - `GitHubProvider_AddComment_CallsGhPrComment` — correct `gh pr comment` invocation
     - `GitHubProvider_GetReviewStatus_ParsesReviewState` — parses `gh pr view` review status
     - `GitHubProvider_Settings_DefaultSquash` — no settings → squash merge
   - Expected failure: `GitHubProvider` does not exist
   - Note: tests should mock `child_process.execFile` to avoid real CLI calls

2. **[GREEN]** Implement GitHubProvider.
   - File: `servers/exarchos-mcp/src/vcs/github.ts`
   - Wraps `gh` CLI for each method
   - Reads `auto-merge-strategy` from settings (default: squash)

3. **[REFACTOR]** Extract common CLI execution pattern if GitHub provider methods share boilerplate.

**Dependencies:** 007

---

### Task 009: VCS Provider Factory + Config Wiring
**Phase:** RED → GREEN → REFACTOR
**Implements:** R4

1. **[RED]** Write tests for provider factory and config wiring.
   - File: `servers/exarchos-mcp/src/vcs/factory.test.ts`
   - Tests:
     - `createVcsProvider_GitHub_ReturnsGitHubProvider` — default config creates GitHub provider
     - `createVcsProvider_GitLab_ReturnsGitLabProvider` — gitlab config creates GitLab provider
     - `createVcsProvider_AzureDevOps_ReturnsAzureProvider` — azure-devops config creates Azure provider
     - `createVcsProvider_PassesSettings_ToProvider` — settings from config forwarded to provider
     - `createVcsProvider_NoProjectConfig_DefaultsToGitHub` — undefined config → GitHub
   - Expected failure: `createVcsProvider` does not exist

2. **[GREEN]** Implement factory and wire to DispatchContext.
   - File: `servers/exarchos-mcp/src/vcs/factory.ts`
   - Export: `createVcsProvider(config: ResolvedProjectConfig): VcsProvider`
   - Wire into context initialization so `ctx.vcsProvider` is available

3. **[REFACTOR]** None expected.

**Dependencies:** 004, 008

---

### Task 010: Workflow Phase Skipping
**Phase:** RED → GREEN → REFACTOR
**Implements:** R5

1. **[RED]** Write tests for phase skip transition rerouting.
   - File: `servers/exarchos-mcp/src/workflow/phase-skip.test.ts`
   - Tests:
     - `applyPhaseSkips_EmptyList_ReturnsUnmodifiedHSM` — no skips → original HSM unchanged
     - `applyPhaseSkips_SkipMiddlePhase_ReroutesTransitions` — skipping B in A→B→C produces A→C
     - `applyPhaseSkips_SkipMultiplePhases_ReroutesAll` — skipping B,C in A→B→C→D produces A→D
     - `applyPhaseSkips_SkippedPhaseGuard_InheritedByPredecessor` — guard from B→C transferred to A→C when B skipped
     - `applyPhaseSkips_InitialPhase_RejectedWithError` — cannot skip initial phase (ideate)
     - `applyPhaseSkips_FinalPhase_RejectedWithError` — cannot skip final phase (completed/cancelled)
     - `applyPhaseSkips_NonexistentPhase_IgnoredSilently` — skipping unknown phase is a no-op
     - `applyPhaseSkips_CompoundState_ChildrenSkipped` — skipping a compound state removes it and children
   - Expected failure: `applyPhaseSkips` does not exist

2. **[GREEN]** Implement phase skip logic.
   - File: `servers/exarchos-mcp/src/workflow/phase-skip.ts`
   - Export: `applyPhaseSkips(hsm: HSMDefinition, skipPhases: readonly string[]): HSMDefinition`
   - Validate: reject initial/final phases with descriptive error
   - Reroute: for each skipped phase, connect incoming transitions to outgoing target
   - Guard inheritance: outgoing guard of skipped phase transferred to rerouted transition

3. **[REFACTOR]** None expected.

**Dependencies:** 003 (needs ResolvedProjectConfig type for the skipPhases field)

---

### Task 011: Phase Skip HSM Integration
**Phase:** RED → GREEN → REFACTOR
**Implements:** R5

1. **[RED]** Write tests for phase skipping applied during workflow initialization.
   - File: `servers/exarchos-mcp/src/workflow/phase-skip-integration.test.ts`
   - Tests:
     - `WorkflowInit_WithSkipPhases_AppliesSkips` — initializing workflow with config that skips plan-review → plan transitions directly to delegate
     - `WorkflowTransition_SkippedPhase_Bypassed` — transitioning from plan goes to delegate (not plan-review)
     - `WorkflowStartedEvent_IncludesOriginalPhases` — `workflow.started` event data includes the full phase list (before skips) for audit trail
     - `WorkflowInit_NoProjectConfig_NoSkips` — undefined projectConfig → standard phase progression
   - Expected failure: workflow init doesn't apply phase skips

2. **[GREEN]** Wire phase skipping into workflow initialization.
   - File: `servers/exarchos-mcp/src/workflow/` — update workflow init handler to call `applyPhaseSkips` when `projectConfig.workflow.skipPhases` is non-empty
   - Store original phase list in `workflow.started` event data

3. **[REFACTOR]** None expected.

**Dependencies:** 004, 010

---

### Task 012: Tools Config Surface
**Phase:** RED → GREEN → REFACTOR
**Implements:** R6

1. **[RED]** Write tests for tools config being read by handlers.
   - File: `servers/exarchos-mcp/src/orchestrate/tools-config.test.ts`
   - Tests:
     - `PrepareSynthesis_AutoMergeFalse_OmitsAutoMergeFlag` — config `auto-merge: false` → synthesis handler doesn't set auto-merge
     - `PrepareSynthesis_CommitStyleConventional_EnforcesPrefix` — conventional commit style enforced
     - `PrepareSynthesis_PrStrategyGithubNative_UsesBaseTargeting` — stacked PR strategy read from config
     - `PrepareSynthesis_PrStrategySingle_NoStacking` — single strategy → one PR per feature
     - `PrepareSynthesis_DefaultBranch_UsedAsPrTarget` — configured default branch used instead of auto-detect
     - `PrepareSynthesis_NoProjectConfig_UsesHardcodedDefaults` — undefined config → current behavior preserved
   - Expected failure: handlers don't read tools config from projectConfig

2. **[GREEN]** Update synthesis/shepherd orchestrate handlers to read from resolved config.
   - Files: relevant handlers in `servers/exarchos-mcp/src/orchestrate/` (prepare-synthesis, assess-stack, etc.)
   - Read `ctx.projectConfig.tools.*` instead of hardcoded values
   - Fall back to defaults when `projectConfig` is undefined

3. **[REFACTOR]** Extract tool defaults to a constant to avoid duplication with resolve.ts defaults.

**Dependencies:** 004

---

### Task 013: Event Hook Runner
**Phase:** RED → GREEN → REFACTOR
**Implements:** R7

1. **[RED]** Write tests for the event hook runner.
   - File: `servers/exarchos-mcp/src/hooks/config-hooks.test.ts`
   - Tests:
     - `ConfigHookRunner_MatchingEvent_ExecutesCommand` — hook for `workflow.transition` fires when that event type occurs
     - `ConfigHookRunner_NoMatchingHooks_Noop` — event type with no registered hooks does nothing
     - `ConfigHookRunner_StdinReceivesEventJson` — hook command receives event data as JSON on stdin
     - `ConfigHookRunner_EnvVarsSet_Correctly` — `EXARCHOS_FEATURE_ID`, `EXARCHOS_PHASE`, `EXARCHOS_EVENT_TYPE`, `EXARCHOS_WORKFLOW_TYPE` set
     - `ConfigHookRunner_Timeout_KillsProcess` — process killed after timeout
     - `ConfigHookRunner_CommandFailure_DoesNotThrow` — hook failure logged but doesn't propagate
     - `ConfigHookRunner_MultipleHooks_AllFired` — multiple hooks for same event type all execute
     - `ConfigHookRunner_TestEnv_SkipsExecution` — hooks not fired when `NODE_ENV=test` or `EXARCHOS_SKIP_HOOKS=true`
   - Expected failure: `createConfigHookRunner` does not exist

2. **[GREEN]** Implement the config hook runner.
   - File: `servers/exarchos-mcp/src/hooks/config-hooks.ts`
   - Export: `createConfigHookRunner(config: ResolvedProjectConfig): (event: WorkflowEvent) => Promise<void>`
   - Fire-and-forget: hooks don't block event processing
   - Spawn with timeout, pipe event JSON to stdin, set env vars
   - Guard: skip if `NODE_ENV=test` or `EXARCHOS_SKIP_HOOKS=true`

3. **[REFACTOR]** None expected.

**Dependencies:** 003

---

### Task 014: Event Hook Wiring to EventStore
**Phase:** RED → GREEN → REFACTOR
**Implements:** R7

1. **[RED]** Write tests for hooks being triggered on event append.
   - File: `servers/exarchos-mcp/src/hooks/config-hooks-integration.test.ts`
   - Tests:
     - `EventStore_Append_TriggersConfigHook` — appending a `workflow.transition` event triggers the hook runner
     - `EventStore_Append_NoProjectConfig_NoHooks` — no projectConfig → no hook execution
     - `EventStore_BatchAppend_TriggersHooksForEach` — batch append triggers hooks for each event
   - Expected failure: EventStore doesn't call hook runner

2. **[GREEN]** Wire hook runner into EventStore or context initialization.
   - File: `servers/exarchos-mcp/src/core/context.ts` — register hook runner as post-append callback
   - File: `servers/exarchos-mcp/src/event-store/store.ts` — add optional `onAppend` callback support if not already present
   - Alternative: wire at the handler level (after `emitGateEvent` calls) if EventStore callback is too invasive

3. **[REFACTOR]** Choose between EventStore callback vs handler-level wiring based on implementation complexity.

**Dependencies:** 004, 013

---

### Task 015: Config Describe Action
**Phase:** RED → GREEN → REFACTOR
**Implements:** R8

1. **[RED]** Write tests for the config describe extension.
   - File: `servers/exarchos-mcp/src/workflow/describe-config.test.ts`
   - Tests:
     - `DescribeConfig_NoYml_AllDefaults` — no `.exarchos.yml` → all values annotated with `source: "default"`
     - `DescribeConfig_WithOverrides_SourceAnnotated` — overridden values show `source: ".exarchos.yml"`, others show `source: "default"`
     - `DescribeConfig_AllSectionsPresent` — response includes review, vcs, workflow, tools, hooks sections
     - `DescribeConfig_GateOverride_ShowsGateAndDimension` — gate override annotated distinctly from dimension default
     - `DescribeConfig_DescribeAction_AcceptsConfigFlag` — `describe` action with `config: true` returns config section
   - Expected failure: describe action doesn't support `config` flag

2. **[GREEN]** Extend the describe action handler.
   - File: `servers/exarchos-mcp/src/workflow/` — update describe handler to accept `config?: boolean` flag
   - When `config: true`, return resolved config with source annotations
   - Build annotation by comparing resolved config against `DEFAULTS` — matching values are "default", others are ".exarchos.yml"

3. **[REFACTOR]** None expected.

**Dependencies:** 004

---

## Dependency Graph

```
001 ─────┬─── 002 ──┬── 004 ──┬── 006 (needs 005)
         │          │         ├── 009 (needs 008)
         ├── 003 ──┤         ├── 011 (needs 010)
         │          │         ├── 012
         │          │         ├── 014 (needs 013)
         │          │         └── 015
         │          │
         ├── 005 ──┘ (via 003)
         ├── 010 ──┘ (via 003)
         └── 013 ──┘ (via 003)

007 ─── 008 ──── 009 (needs 004)
```

## Package Dependency

Add `yaml` as an explicit dependency to `servers/exarchos-mcp/package.json`:
```json
"yaml": "^2.7.0"
```

This is currently available as a transitive dependency but must be explicit for production reliability.

## Backwards Compatibility

Every task must preserve this invariant: **all existing tests pass with no `.exarchos.yml` present**. When `projectConfig` is undefined on `DispatchContext`, all behavior must be identical to the current codebase.
