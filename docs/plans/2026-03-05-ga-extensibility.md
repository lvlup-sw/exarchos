# Implementation Plan: GA Extensibility — Dual-Channel CLI + Config-Driven Custom Workflows

**Design:** [docs/designs/2026-03-05-ga-extensibility.md](../designs/2026-03-05-ga-extensibility.md)
**Date:** 2026-03-05

## Overview

Four implementation phases, each building on the previous:

1. **Handler Extraction** — Extract dispatch layer from `createServer()`, refactor telemetry return type (Phase 1)
2. **CLI Generator** — Build CLI from registry with Zod-to-flags, pretty printer, schema introspection, MCP mode (Phase 2)
3. **Config-Driven Workflows** — Config loading, HSM registration, dynamic WorkflowType enum (Phase 3)
4. **CLI Polish** — Aliases, flag shortcuts, formatting hints (Phase 4)

```
Phase 1 (Tasks 1-5) ──→ Phase 2 (Tasks 6-14) ──→ Phase 3 (Tasks 15-22) ──→ Phase 4 (Tasks 23-25)
     │                        │
     │ sequential              │ partially parallelizable
     └─────────────────────────┘
```

## Dependency Graph

```
T1 ──→ T2 ──→ T3 ──→ T4 ──→ T5   (Phase 1: Handler Extraction)
                               │
                               ▼
                         T6 ──→ T7 ──→ T8    (Phase 2a: Zod-to-flags)
                         T9 (parallel)        (Phase 2b: Pretty printer — independent)
                               │
                               ▼
                        T10 ──→ T11 ──→ T12 ──→ T13 ──→ T14  (Phase 2c: CLI assembly)
                                                          │
                                                          ▼
                                                   T15 ──→ T16 ──→ T17 ──→ T18  (Phase 3a: Config)
                                                   T19 ──→ T20 ──→ T21 ──→ T22  (Phase 3b: HSM registration)
                                                                                  │
                                                                                  ▼
                                                                           T23 ──→ T24 ──→ T25  (Phase 4: Polish)
```

## Parallel Groups

| Group | Tasks | Can Run Concurrently |
|-------|-------|---------------------|
| A | T1-T5 | Sequential (foundational refactor) |
| B | T6-T8, T9 | T9 parallel with T6-T8 |
| C | T10-T14 | Sequential (depends on B) |
| D | T15-T18, T19-T22 | T15-T18 parallel with T19-T22 (both depend on C) |
| E | T23-T25 | Sequential (depends on D) |

---

## Phase 1: Handler Extraction

### Task 1: Extract ToolResult from McpToolResult in withTelemetry

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `WithTelemetry_ReturnsToolResult_NotMcpToolResult`
   - File: `servers/exarchos-mcp/src/telemetry/middleware.test.ts`
   - Assert: `withTelemetry()` return type is `ToolResult` (has `success`, `data`, `_perf` — no `content` wrapper)
   - Expected failure: `withTelemetry` currently returns `McpToolResult` with `content[0].text`

2. [GREEN] Refactor `withTelemetry()` to return `ToolResult`
   - File: `servers/exarchos-mcp/src/telemetry/middleware.ts`
   - Change `ToolHandler` type: `(args) => Promise<ToolResult>` instead of `Promise<McpToolResult>`
   - Change `injectPerf` to set `_perf` on `ToolResult` directly instead of parsing/re-stringifying JSON
   - Change `injectEventHints` similarly
   - Change `injectAutoCorrection` similarly

3. [REFACTOR] Remove JSON parse/stringify dance from inject functions

**Dependencies:** None
**Parallelizable:** No (foundational)

---

### Task 2: Create dispatch function

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `Dispatch_KnownTool_CallsHandler`
   - File: `servers/exarchos-mcp/src/core/dispatch.test.ts`
   - Assert: `dispatch('exarchos_workflow', { action: 'get', featureId: 'test' }, ctx)` calls `handleWorkflow` and returns `ToolResult`
   - Expected failure: `dispatch` doesn't exist

2. [RED] Write test: `Dispatch_UnknownTool_ReturnsError`
   - File: `servers/exarchos-mcp/src/core/dispatch.test.ts`
   - Assert: `dispatch('unknown_tool', {}, ctx)` returns `{ success: false, error: { code: 'UNKNOWN_TOOL' } }`

3. [RED] Write test: `Dispatch_WithTelemetry_EnrichesResult`
   - File: `servers/exarchos-mcp/src/core/dispatch.test.ts`
   - Assert: result contains `_perf` when `enableTelemetry: true`

4. [GREEN] Implement `dispatch()` function
   - File: `servers/exarchos-mcp/src/core/dispatch.ts`
   - Export `DispatchContext` interface with `stateDir`, `eventStore`, `enableTelemetry`
   - Route to `COMPOSITE_HANDLERS[tool]`, wrap with `withTelemetry()` if enabled

5. [REFACTOR] Extract `COMPOSITE_HANDLERS` map to `core/dispatch.ts`

**Dependencies:** Task 1 (withTelemetry returns ToolResult)
**Parallelizable:** No

---

### Task 3: Create DispatchContext initialization

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `InitializeContext_CreatesEventStore_ConfiguresModules`
   - File: `servers/exarchos-mcp/src/core/context.test.ts`
   - Assert: `initializeContext(stateDir)` returns a `DispatchContext` with `eventStore`, `stateDir`, `enableTelemetry`
   - Assert: module-level EventStore configurations are applied (configureWorkflowEventStore, etc.)

2. [GREEN] Extract initialization logic from `createServer()` into `initializeContext()`
   - File: `servers/exarchos-mcp/src/core/context.ts`
   - Move EventStore creation, module configuration, backend setup out of `createServer()`
   - Return `DispatchContext`

3. [REFACTOR] Clean up imports

**Dependencies:** Task 2 (DispatchContext type exists)
**Parallelizable:** No

---

### Task 4: Rewire MCP server to use dispatch

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `CreateMcpServer_RegistersAllTools_FromRegistry`
   - File: `servers/exarchos-mcp/src/adapters/mcp.test.ts`
   - Assert: `createMcpServer(ctx)` registers all tools from `TOOL_REGISTRY`
   - Assert: calling a registered tool returns `McpToolResult` (with `content[0].text` JSON wrapping)

2. [GREEN] Implement `createMcpServer(ctx: DispatchContext)` adapter
   - File: `servers/exarchos-mcp/src/adapters/mcp.ts`
   - Loop over `TOOL_REGISTRY`, register each tool with handler: `async (args) => formatResult(await dispatch(tool.name, args, ctx))`

3. [REFACTOR] Remove old wiring from `createServer()` in `index.ts`, replace with `createMcpServer()`

**Dependencies:** Task 3 (DispatchContext initialization)
**Parallelizable:** No

---

### Task 5: Rewire main() entry point and verify existing tests pass

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `Main_StartsStdioTransport_WithMcpServer`
   - File: `servers/exarchos-mcp/src/index.test.ts` (update existing)
   - Assert: `main()` creates context via `initializeContext()`, creates server via `createMcpServer()`, connects transport

2. [GREEN] Update `main()` in `index.ts`
   - Call `initializeContext(stateDir)` then `createMcpServer(ctx)`
   - Keep backend initialization, hydration, lifecycle management unchanged

3. [REFACTOR] Remove dead code from old `createServer()` if fully replaced

4. Verify: Run full test suite `npm run test:run` — all existing tests pass

**Dependencies:** Task 4 (MCP adapter)
**Parallelizable:** No

---

## Phase 2: CLI Generator

### Task 6: Zod schema shape extraction utility

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `ExtractShape_SimpleObject_ReturnsFieldMetadata`
   - File: `servers/exarchos-mcp/src/adapters/schema-to-flags.test.ts`
   - Assert: given `z.object({ featureId: z.string(), limit: z.number().optional() })`, returns metadata for each field (name, type, required, description)

2. [RED] Write test: `ExtractShape_EnumField_ReturnsValues`
   - Assert: enum fields return their valid values

3. [RED] Write test: `ExtractShape_PreprocessedField_UnwrapsCorrectly`
   - Assert: `coercedPositiveInt()` is recognized as a number field

4. [RED] Write test: `ExtractShape_ArrayField_DetectsArray`
   - Assert: `z.array(z.string())` is recognized as an array field

5. [GREEN] Implement `extractSchemaFields(schema: ZodObject)` utility
   - File: `servers/exarchos-mcp/src/adapters/schema-to-flags.ts`
   - Returns field metadata: `{ name, type, required, enumValues?, description? }`
   - Handles: string, number, boolean, enum, array, preprocess-wrapped types

6. [REFACTOR] Share `unwrapPreprocess` logic with `registry.ts`

**Dependencies:** Task 5 (Phase 1 complete)
**Parallelizable:** Yes (with Task 9)

---

### Task 7: Zod-to-commander flag generation

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `AddFlags_RequiredString_CreatesRequiredOption`
   - File: `servers/exarchos-mcp/src/adapters/schema-to-flags.test.ts`
   - Assert: required string field produces `--feature-id <value>` (camelCase → kebab-case)

2. [RED] Write test: `AddFlags_OptionalNumber_CreatesOptionalOption`
   - Assert: optional number field produces `--limit <value>` (not required)

3. [RED] Write test: `AddFlags_EnumField_ShowsChoices`
   - Assert: enum field produces `--workflow-type <value> (feature|debug|refactor)`

4. [RED] Write test: `AddFlags_BooleanField_CreatesSwitch`
   - Assert: boolean field produces `--dry-run` (no `<value>`)

5. [RED] Write test: `AddFlags_WithOverrides_UsesAliasAndDescription`
   - Assert: override `{ featureId: { alias: 'f' } }` produces `-f, --feature-id <value>`

6. [RED] Write test: `AddFlags_AlwaysAddsJsonFlag`
   - Assert: `--json` flag is always added

7. [GREEN] Implement `addFlagsFromSchema(cmd, schema, overrides?)` and `coerceFlags(opts, schema)`
   - File: `servers/exarchos-mcp/src/adapters/schema-to-flags.ts`
   - `coerceFlags` converts kebab-case CLI opts back to camelCase args for handler

8. [REFACTOR] Extract `toKebab()` and `toCamel()` to shared utility

**Dependencies:** Task 6 (schema extraction)
**Parallelizable:** No

---

### Task 8: JSON Schema export from Zod (for `exarchos schema`)

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `ResolveSchemaRef_ValidRef_ReturnsJsonSchema`
   - File: `servers/exarchos-mcp/src/adapters/schema-introspection.test.ts`
   - Assert: `resolveSchemaRef('workflow.init')` returns valid JSON Schema matching the Zod schema

2. [RED] Write test: `ResolveSchemaRef_InvalidRef_ReturnsError`
   - Assert: `resolveSchemaRef('invalid.action')` throws or returns error

3. [RED] Write test: `ListSchemas_ReturnsAllToolsAndActions`
   - Assert: `listSchemas()` returns summary of all tools with their actions

4. [GREEN] Implement `resolveSchemaRef()` and `listSchemas()`
   - File: `servers/exarchos-mcp/src/adapters/schema-introspection.ts`
   - Use `zodToJsonSchema` (already available as zod utility or add lightweight converter)
   - Parse `tool.action` ref format, find in `TOOL_REGISTRY`

5. [REFACTOR] Clean up

**Dependencies:** Task 6 (schema extraction utility)
**Parallelizable:** Yes (with Task 7)

---

### Task 9: CLI pretty printer

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `PrettyPrint_SuccessResult_PrintsData`
   - File: `servers/exarchos-mcp/src/adapters/cli-format.test.ts`
   - Assert: success result prints data to stdout

2. [RED] Write test: `PrettyPrint_ErrorResult_PrintsError`
   - Assert: error result prints error code and message to stderr

3. [RED] Write test: `PrettyPrint_WithPerf_PrintsFooter`
   - Assert: result with `_perf` prints `Xms | XB | ~X tokens` to stderr

4. [RED] Write test: `PrettyPrint_WithEventHints_PrintsAdvisory`
   - Assert: result with `_eventHints` prints missing event advisory

5. [RED] Write test: `PrettyPrint_WithCheckpointAdvised_PrintsWarning`
   - Assert: result with `_meta.checkpointAdvised: true` prints checkpoint advisory

6. [RED] Write test: `PrettyPrint_WithCorrections_PrintsNotice`
   - Assert: result with `_corrections` prints auto-correction notices

7. [GREEN] Implement `prettyPrint(result, format?)` and `printError(error)`
   - File: `servers/exarchos-mcp/src/adapters/cli-format.ts`
   - Formats: JSON (default), table (for list data), tree (for hierarchical data)
   - Metadata (_perf, _eventHints, _corrections, _meta) printed to stderr

8. [REFACTOR] Extract format inference logic

**Dependencies:** Task 1 (ToolResult shape — but only needs the type, not the implementation)
**Parallelizable:** Yes (with Tasks 6-8)

---

### Task 10: CLI ToolAction interface extension

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `ToolAction_AcceptsCliHints`
   - File: `servers/exarchos-mcp/src/core/registry.test.ts` (or update `registry.test.ts`)
   - Assert: `ToolAction` with `cli: { alias: 'ls', flags: { featureId: { alias: 'f' } } }` type-checks correctly

2. [RED] Write test: `CompositeTool_AcceptsCliHints`
   - Assert: `CompositeTool` with `cli: { alias: 'wf' }` type-checks correctly

3. [GREEN] Extend `ToolAction` and `CompositeTool` interfaces in `registry.ts`
   - Add optional `cli?: CliHints` field to both interfaces
   - Define `CliHints` type with `alias`, `group`, `examples`, `flags`, `format`

4. [REFACTOR] Ensure all existing registry entries still type-check (no `cli` field = no change)

**Dependencies:** Task 5 (Phase 1 complete)
**Parallelizable:** Yes (after Phase 1, parallel with T6-T9)

---

### Task 11: CLI command tree generator

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `BuildCli_RegistersAllToolGroups`
   - File: `servers/exarchos-mcp/src/adapters/cli.test.ts`
   - Assert: `buildCli(ctx)` creates a commander program with subcommands for each tool in `TOOL_REGISTRY`

2. [RED] Write test: `BuildCli_GeneratesActionSubcommands`
   - Assert: `workflow` group has subcommands `init`, `get`, `set`, `cancel`, `cleanup`, `reconcile`

3. [RED] Write test: `BuildCli_UsesCliAlias_WhenProvided`
   - Assert: tool with `cli: { alias: 'wf' }` registers as `wf` command (in addition to full name)

4. [GREEN] Implement `buildCli(ctx: DispatchContext)` using commander
   - File: `servers/exarchos-mcp/src/adapters/cli.ts`
   - Iterate `TOOL_REGISTRY`, create command group per tool, subcommand per action
   - Wire each action's handler to call `dispatch()` then format output

5. [REFACTOR] Extract command group builder function

**Dependencies:** Tasks 7 (flag generation), 9 (pretty printer), 10 (CLI hints on ToolAction)
**Parallelizable:** No

---

### Task 12: `exarchos schema` command

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `SchemaCommand_NoArgs_ListsAllActions`
   - File: `servers/exarchos-mcp/src/adapters/cli.test.ts`
   - Assert: `exarchos schema` prints summary of all tools and actions

2. [RED] Write test: `SchemaCommand_WithRef_PrintsJsonSchema`
   - Assert: `exarchos schema workflow.init` prints JSON Schema for the init action

3. [GREEN] Add `schema` command to `buildCli()`
   - Uses `listSchemas()` and `resolveSchemaRef()` from Task 8

4. [REFACTOR] Clean up

**Dependencies:** Tasks 8 (schema introspection), 11 (CLI builder)
**Parallelizable:** No

---

### Task 13: `exarchos mcp` command

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `McpCommand_StartsStdioServer`
   - File: `servers/exarchos-mcp/src/adapters/cli.test.ts`
   - Assert: `exarchos mcp` creates MCP server and connects stdio transport

2. [GREEN] Add `mcp` command to `buildCli()`
   - Creates `createMcpServer(ctx)` and connects `StdioServerTransport`

3. [REFACTOR] Clean up

**Dependencies:** Tasks 4 (MCP adapter), 11 (CLI builder)
**Parallelizable:** Yes (with Task 12)

---

### Task 14: Unified entry point

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `EntryPoint_NoArgs_ShowsHelp`
   - File: `servers/exarchos-mcp/src/index.test.ts`
   - Assert: running without args shows help text

2. [RED] Write test: `EntryPoint_McpArg_StartsMcpServer`
   - Assert: `exarchos mcp` starts MCP server

3. [RED] Write test: `EntryPoint_WorkflowInit_DispatchesCommand`
   - Assert: `exarchos workflow init --feature-id test --workflow-type feature` dispatches correctly

4. [GREEN] Update `main()` in `index.ts`
   - Initialize backend + context
   - Build CLI with `buildCli(ctx)`
   - Parse args

5. [REFACTOR] Remove old `main()` path, update `cli.ts` hook entry point to remain separate

**Dependencies:** Tasks 11, 12, 13 (all CLI commands)
**Parallelizable:** No

---

## Phase 3: Config-Driven Custom Workflows

### Task 15: defineConfig helper and config types

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `DefineConfig_PassesThrough_ReturnsSameObject`
   - File: `servers/exarchos-mcp/src/config/define.test.ts`
   - Assert: `defineConfig({ workflows: { ... } })` returns the same object unchanged

2. [RED] Write test: `DefineConfig_TypeChecks_ValidConfig`
   - Assert: valid config with workflows and guards type-checks

3. [GREEN] Implement `defineConfig()` and export types
   - File: `servers/exarchos-mcp/src/config/define.ts`
   - Types: `ExarchosConfig`, `WorkflowDefinition`, `TransitionDefinition`, `GuardDefinition`

4. [REFACTOR] Clean up

**Dependencies:** Task 14 (Phase 2 complete)
**Parallelizable:** Yes (with Task 19)

---

### Task 16: Config file loader

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `LoadConfig_FileExists_ReturnsConfig`
   - File: `servers/exarchos-mcp/src/config/loader.test.ts`
   - Assert: `loadConfig(projectRoot)` loads and returns parsed config from `exarchos.config.ts`

2. [RED] Write test: `LoadConfig_NoFile_ReturnsEmptyConfig`
   - Assert: `loadConfig('/nonexistent')` returns `{}`

3. [RED] Write test: `LoadConfig_InvalidConfig_ThrowsValidationError`
   - Assert: config with invalid workflow definition throws descriptive error

4. [GREEN] Implement `loadConfig(projectRoot)` with config validation
   - File: `servers/exarchos-mcp/src/config/loader.ts`
   - Use dynamic import or jiti for TypeScript config files
   - Validate with Zod schema for config structure

5. [REFACTOR] Extract validation schema

**Dependencies:** Task 15 (config types)
**Parallelizable:** No

---

### Task 17: Config validation with Zod

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `ConfigSchema_ValidWorkflow_Passes`
   - File: `servers/exarchos-mcp/src/config/loader.test.ts`
   - Assert: config with valid phases, transitions, guards passes validation

2. [RED] Write test: `ConfigSchema_TransitionRefsInvalidPhase_Fails`
   - Assert: transition referencing phase not in `phases` array fails validation

3. [RED] Write test: `ConfigSchema_DuplicateWorkflowName_Fails`
   - Assert: config with workflow name matching built-in type fails

4. [RED] Write test: `ConfigSchema_CircularTransitions_Detected`
   - Assert: transitions forming an unreachable graph produce warnings

5. [GREEN] Implement config validation schema and cross-reference checks
   - File: `servers/exarchos-mcp/src/config/loader.ts`

6. [REFACTOR] Improve error messages

**Dependencies:** Task 16 (loader exists)
**Parallelizable:** No

---

### Task 18: Config integration into DispatchContext

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `InitializeContext_WithConfig_LoadsConfig`
   - File: `servers/exarchos-mcp/src/core/context.test.ts`
   - Assert: `initializeContext(stateDir, { projectRoot })` loads config from project root

2. [GREEN] Extend `initializeContext()` to accept optional `projectRoot`
   - Load config via `loadConfig(projectRoot)` if provided
   - Store config on `DispatchContext`

3. [REFACTOR] Clean up

**Dependencies:** Task 16 (config loader)
**Parallelizable:** No

---

### Task 19: HSM registry extension for custom workflows

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `RegisterWorkflowType_AddsToHsmRegistry`
   - File: `servers/exarchos-mcp/src/workflow/state-machine.test.ts` (extend existing)
   - Assert: after `registerWorkflowType('frontend-feature', definition)`, `getHSMDefinition('frontend-feature')` returns valid HSM

2. [RED] Write test: `RegisterWorkflowType_ExtendsBuiltIn_InheritsTransitions`
   - Assert: `extends: 'feature'` inherits feature workflow transitions, with custom overrides applied

3. [RED] Write test: `RegisterWorkflowType_CustomPhases_ValidTransitions`
   - Assert: custom phases and transitions produce a valid state machine

4. [RED] Write test: `RegisterWorkflowType_DuplicateName_Throws`
   - Assert: registering `'feature'` (built-in name) throws error

5. [GREEN] Implement `registerWorkflowType(name, definition)` function
   - File: `servers/exarchos-mcp/src/workflow/state-machine.ts`
   - Builds HSM from config definition (phases → states, transitions → Transition[])
   - Adds to `hsmRegistry`
   - Handles `extends` by cloning parent HSM and merging

6. [REFACTOR] Extract HSM builder helper from hardcoded `createFeatureHSM()` pattern

**Dependencies:** Task 14 (Phase 2 complete)
**Parallelizable:** Yes (with Task 15-18)

---

### Task 20: Dynamic WorkflowType enum extension

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `ExtendWorkflowTypeEnum_AddsCustomType`
   - File: `servers/exarchos-mcp/src/workflow/schemas.test.ts` (extend existing)
   - Assert: after `extendWorkflowTypeEnum('frontend-feature')`, the `WorkflowTypeSchema` accepts `'frontend-feature'`

2. [RED] Write test: `ExtendWorkflowTypeEnum_BuiltInsPreserved`
   - Assert: `'feature'`, `'debug'`, `'refactor'` still pass validation

3. [RED] Write test: `ExtendWorkflowTypeEnum_RegistrySchemaUpdated`
   - Assert: `buildRegistrationSchema()` includes the extended type in the `workflowType` enum

4. [GREEN] Implement `extendWorkflowTypeEnum(name)`
   - File: `servers/exarchos-mcp/src/workflow/schemas.ts`
   - Change `WorkflowTypeSchema` from static `z.enum()` to a mutable schema that can be extended
   - Update all references to use the extensible version

5. [REFACTOR] Ensure backward compatibility — existing hardcoded `z.enum(['feature', 'debug', 'refactor'])` references updated

**Dependencies:** Task 19 (HSM registration)
**Parallelizable:** No

---

### Task 21: Custom guard execution

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `ExecuteGuard_CommandSucceeds_GuardPasses`
   - File: `servers/exarchos-mcp/src/config/guards.test.ts`
   - Assert: guard with `command: 'exit 0'` returns `{ passed: true }`

2. [RED] Write test: `ExecuteGuard_CommandFails_GuardFails`
   - Assert: guard with `command: 'exit 1'` returns `{ passed: false }`

3. [RED] Write test: `ExecuteGuard_Timeout_GuardFails`
   - Assert: guard exceeding timeout returns `{ passed: false, error: 'timeout' }`

4. [RED] Write test: `ExecuteGuard_CommandNotFound_GuardFailsGracefully`
   - Assert: guard with nonexistent command fails with descriptive error

5. [GREEN] Implement `executeGuard(guard: GuardDefinition)` function
   - File: `servers/exarchos-mcp/src/config/guards.ts`
   - Executes shell command with timeout via `child_process.execSync` or `spawn`
   - Returns structured result

6. [REFACTOR] Clean up error handling

**Dependencies:** Task 15 (GuardDefinition type)
**Parallelizable:** Yes (with Tasks 19-20)

---

### Task 22: Wire custom workflows into registration pipeline

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `RegisterCustomWorkflows_FromConfig_WorkflowAvailable`
   - File: `servers/exarchos-mcp/src/config/register.test.ts`
   - Assert: given config with `frontend-feature` workflow, after `registerCustomWorkflows()`:
     - `getHSMDefinition('frontend-feature')` works
     - `WorkflowTypeSchema.parse('frontend-feature')` succeeds
     - Registry `workflowType` enum includes `'frontend-feature'`

2. [RED] Write test: `RegisterCustomWorkflows_WithGuards_GuardsRegistered`
   - Assert: custom guards from config are available for transition validation

3. [RED] Write test: `RegisterCustomWorkflows_NoConfig_Noop`
   - Assert: empty config or no workflows key is a no-op

4. [GREEN] Implement `registerCustomWorkflows(config, registry)` orchestrator
   - File: `servers/exarchos-mcp/src/config/register.ts`
   - Calls `registerWorkflowType()` for each workflow
   - Calls `extendWorkflowTypeEnum()` for each workflow
   - Registers custom guards

5. [GREEN] Call `registerCustomWorkflows()` during context initialization (Task 18 integration)

6. [REFACTOR] Clean up

**Dependencies:** Tasks 18 (config integration), 19 (HSM registration), 20 (enum extension), 21 (guard execution)
**Parallelizable:** No (integration task)

---

## Phase 4: CLI Polish

### Task 23: Add CLI hints to core workflow actions

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `WorkflowActions_HaveCliHints`
   - File: `servers/exarchos-mcp/src/core/registry.test.ts`
   - Assert: `exarchos_workflow` tool has `cli.alias === 'wf'`
   - Assert: `init` action has flag aliases for `featureId` (`-f`) and `workflowType` (`-t`)

2. [GREEN] Add `cli` hints to `workflowActions` in `registry.ts`
   - Tool alias: `wf`
   - Action aliases: `status` for `get`
   - Flag aliases: `-f` (featureId), `-t` (workflowType), `-q` (query)

3. [GREEN] Add `cli` hints to `viewActions`
   - Tool alias: `vw`
   - Flag aliases: `-w` (workflowId), `-l` (limit)

4. [GREEN] Add `cli` hints to `eventActions`
   - Tool alias: `ev`

5. [REFACTOR] Clean up

**Dependencies:** Task 22 (Phase 3 complete)
**Parallelizable:** No

---

### Task 24: Add examples to common actions

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `CliHints_ExamplesPresent_ForCommonActions`
   - File: `servers/exarchos-mcp/src/core/registry.test.ts`
   - Assert: `init`, `get`, `set`, `pipeline`, `append` actions have non-empty `cli.examples` arrays

2. [GREEN] Add `examples` arrays to common action `cli` hints

3. [REFACTOR] Verify examples appear in `--help` output

**Dependencies:** Task 23 (hints structure exists)
**Parallelizable:** No

---

### Task 25: `exarchos init` scaffolding command

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `InitCommand_CreatesConfigFile`
   - File: `servers/exarchos-mcp/src/adapters/cli.test.ts`
   - Assert: `exarchos init` creates `exarchos.config.ts` in current directory with template content

2. [RED] Write test: `InitCommand_ConfigExists_DoesNotOverwrite`
   - Assert: `exarchos init` when config already exists prints warning and does not overwrite

3. [GREEN] Add `init` command to `buildCli()`
   - Writes template `exarchos.config.ts` with commented example workflows
   - Prints getting-started instructions

4. [REFACTOR] Clean up template content

**Dependencies:** Task 15 (defineConfig types for template)
**Parallelizable:** No

---

## New Dependencies

| Package | Purpose | Justification |
|---------|---------|---------------|
| `commander` | CLI framework | Lightweight, well-established, good TypeScript support. Needed for arg parsing, help generation, subcommands. |
| `zod-to-json-schema` | Schema introspection | Convert Zod schemas to JSON Schema for `exarchos schema`. Small, focused utility. |

---

## Task Summary

| Phase | Tasks | Count | Parallelizable Groups |
|-------|-------|-------|-----------------------|
| 1: Handler Extraction | T1-T5 | 5 | Sequential |
| 2: CLI Generator | T6-T14 | 9 | T6-T8 + T9 parallel; rest sequential |
| 3: Config Workflows | T15-T22 | 8 | T15-T18 + T19-T22 parallel |
| 4: CLI Polish | T23-T25 | 3 | Sequential |
| **Total** | | **25** | |

## Risk Notes

1. **`withTelemetry` refactor (Task 1)** is the highest-risk change — it touches every MCP tool response. The existing test suite is comprehensive; run it after every step.
2. **Dynamic WorkflowType enum (Task 20)** requires changing multiple hardcoded `z.enum()` references across the codebase. Search for all `z.enum(['feature', 'debug', 'refactor'])` occurrences.
3. **Config loading (Task 16)** needs a TypeScript loader. Evaluate `jiti` (lightweight, synchronous) vs `tsx` (already a devDep) vs bundling configs at init time.
4. **Commander dependency** — evaluate `citty` as a lighter alternative if bundle size is a concern for MCP distribution.
