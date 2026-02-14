# Implementation Plan: Progressive Disclosure & Hook-Driven Lifecycle

## Source Design
Link: `docs/designs/2026-02-12-progressive-disclosure-hooks.md`

## Scope
**Target:** Full design — all 5 sections (Composite Tools, Hook Architecture, Tool Registry, CLI Entry Point, Hook Configuration)
**Excluded:** None. Prompt migration (56 files) included as a mechanical transformation task.

## Summary
- Total tasks: 18
- Parallel groups: 4
- Estimated test count: ~85
- Design coverage: 5 of 5 sections covered

## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|---|---|---|---|
| Technical Design > 1. Composite Tool Architecture > Schema Design | Discriminated union schemas for 5 composites | A1, A2 | Covered |
| Technical Design > 1. Composite Tool Architecture > Routing | Composite handlers dispatch to existing handlers | B1, B2, B3, B4 | Covered |
| Technical Design > 1. Composite Tool Architecture > Registration | index.ts registers 5 composites, removes 27 individual tools | B5 | Covered |
| Technical Design > 1. Eliminated Tools | 6 tools removed from MCP, logic preserved for CLI | B5, C2, C3 | Covered |
| Technical Design > 2. Hook Architecture > 2.1 Never-Compact | PreCompact hook → checkpoint → stop | C2 | Covered |
| Technical Design > 2. Hook Architecture > 2.1 SessionStart resume | SessionStart hook → detect checkpoint → inject context | C3 | Covered |
| Technical Design > 2. Hook Architecture > 2.2 Phase Guardrails | PreToolUse hook → validate action against phase | C4 | Covered |
| Technical Design > 2. Hook Architecture > 2.3 Quality Gates | TaskCompleted + TeammateIdle hooks | C5 | Covered |
| Technical Design > 2. Hook Architecture > 2.4 Subagent Guidance | SubagentStart hook → phase-specific tool manifest | C6 | Covered |
| Technical Design > 3. Tool Registry | Single source of truth: types, data, phase mappings, roles | A1, A2 | Covered |
| Technical Design > 3. Tool Registry > Generated artifacts | Build script generates mcp-tool-guidance.md | D2 | Covered |
| Technical Design > 3. Tool Registry > Migration path | 56 files updated to new composite tool names | D3 | Covered |
| Technical Design > 4. CLI Entry Point | Shared CLI for all hooks, imports existing logic | C1 | Covered |
| Technical Design > 5. Hook Configuration | Plugin hooks/hooks.json with all 6 hooks | D1 | Covered |
| Integration Points > Installer Changes | Hooks registration, remove auto-resume rule | D1 | Covered |
| Integration Points > Existing Patterns Preserved | ToolResult, CAS, fast-path, _meta unchanged | B1-B4 | Covered |
| Testing Strategy > Registry tests | Validate actions have schemas, phases, roles | A2 | Covered |
| Testing Strategy > Composite routing | Each composite routes to correct handler | B1-B4 | Covered |
| Testing Strategy > CLI command tests | CLI produces correct output for inputs | C2-C6 | Covered |
| Testing Strategy > Phase guard logic | Allow/deny for every phase × action | C4 | Covered |
| Testing Strategy > Schema compatibility | Composites accept old parameter combinations | B1-B4 | Covered |
| Testing Strategy > Reference audit | Scan for remaining old-style tool names | D3 | Covered |
| Open Questions > Manual compaction | PreCompact(manual) also checkpoints | C2 | Covered |
| Open Questions > Multi-workflow | Checkpoint all active workflows | C2 | Covered |

---

## Task Breakdown

### Group A: Registry Foundation (Sequential)

---

### Task A1: Tool Registry Types & Schema Generation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `buildCompositeSchema_TwoActions_ReturnsDiscriminatedUnion`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/registry.test.ts`
   - Test that `buildCompositeSchema()` creates a valid Zod discriminated union from action definitions
   - Test that parsing `{ action: "init", featureId: "test" }` succeeds against generated schema
   - Test that parsing `{ action: "invalid" }` fails
   - Expected failure: `registry.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement registry types and schema generation
   - File: `plugins/exarchos/servers/exarchos-mcp/src/registry.ts`
   - Create `ToolAction`, `CompositeTool` interfaces
   - Implement `buildCompositeSchema(actions: ToolAction[])` that generates `z.discriminatedUnion('action', [...])`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract Zod helpers if needed
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail (module not found)
- [ ] Schema generation produces valid discriminated union
- [ ] Invalid actions rejected by generated schema

**Dependencies:** None
**Parallelizable:** No (foundation)
**Branch:** `feat/progressive-disclosure/a1-registry-types`

---

### Task A2: Tool Registry Data — All 5 Composites

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests validating registry completeness
   - File: `plugins/exarchos/servers/exarchos-mcp/src/registry.test.ts`
   - `TOOL_REGISTRY_HasFiveComposites`: Registry length is 5
   - `TOOL_REGISTRY_WorkflowHasFourActions`: workflow composite has init, get, set, cancel
   - `TOOL_REGISTRY_OrchestrateHasEightActions`: orchestrate has all 8 team+task actions
   - `TOOL_REGISTRY_AllActionsHavePhases`: Every action has non-empty phases set
   - `TOOL_REGISTRY_AllActionsHaveRoles`: Every action has non-empty roles set
   - `TOOL_REGISTRY_AllActionsHaveSchemas`: Every action has a Zod schema that parses valid input
   - `TOOL_REGISTRY_PhaseMappingsAreExhaustive`: All workflow phases appear in at least one action's phase set
   - Expected failure: `TOOL_REGISTRY` not yet populated
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Populate registry with all 5 composite tools
   - File: `plugins/exarchos/servers/exarchos-mcp/src/registry.ts`
   - `exarchos_workflow`: init (ideate/lead), get (all/any), set (all/lead), cancel (all/lead)
   - `exarchos_event`: append (all/any), query (all/any)
   - `exarchos_orchestrate`: team_spawn, team_message, team_broadcast, team_shutdown, team_status (delegate/lead), task_claim, task_complete, task_fail (delegate/teammate)
   - `exarchos_view`: pipeline, tasks, workflow_status, team_status (all/any), stack_status, stack_place (synthesize+delegate/any)
   - `exarchos_sync`: now (all/lead)
   - Import existing Zod schemas from each module's registration code
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Ensure schema imports are clean, no circular dependencies
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] All 5 composites defined with correct action counts (4, 2, 8, 6, 1 = 21 actions)
- [ ] All phases covered by at least one action
- [ ] All schemas validate their expected inputs

**Dependencies:** A1
**Parallelizable:** No (extends A1's file)
**Branch:** `feat/progressive-disclosure/a2-registry-data`

---

### Group B: Composite Handlers (Parallel after A)

---

### Task B1: Composite Handler — exarchos_workflow

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write routing tests
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/composite.test.ts`
   - `handleWorkflow_InitAction_DelegatesToHandleInit`: Mock handleInit, verify called with correct args
   - `handleWorkflow_GetAction_DelegatesToHandleGet`: Mock handleGet, verify called
   - `handleWorkflow_SetAction_DelegatesToHandleSet`: Mock handleSet, verify called
   - `handleWorkflow_CancelAction_DelegatesToHandleCancel`: Mock handleCancel, verify called
   - `handleWorkflow_UnknownAction_ReturnsError`: Verify error for unrecognized action
   - Expected failure: `composite.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement composite handler
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/composite.ts`
   - Switch on `args.action`, delegate to existing handlers
   - Pass through `stateDir` unchanged
   - Return handler result directly (no transformation)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract common routing pattern if useful across composites
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Each action routes to correct handler
- [ ] Args forwarded correctly (featureId, query, etc.)
- [ ] Unknown action returns structured error

**Dependencies:** A2
**Parallelizable:** Yes (worktree)
**Branch:** `feat/progressive-disclosure/b1-composite-workflow`

---

### Task B2: Composite Handler — exarchos_event

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write routing tests
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/composite.test.ts`
   - `handleEvent_AppendAction_DelegatesToHandleEventAppend`
   - `handleEvent_QueryAction_DelegatesToHandleEventQuery`
   - Expected failure: `composite.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement composite handler
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/composite.ts`
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Both actions route correctly
- [ ] EventStore dependency threaded through

**Dependencies:** A2
**Parallelizable:** Yes (worktree)
**Branch:** `feat/progressive-disclosure/b2-composite-event`

---

### Task B3: Composite Handler — exarchos_orchestrate

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write routing tests for all 8 actions
   - File: `plugins/exarchos/servers/exarchos-mcp/src/orchestrate/composite.test.ts`
   - `handleOrchestrate_TeamSpawn_DelegatesToHandleTeamSpawn`
   - `handleOrchestrate_TeamMessage_DelegatesToHandleTeamMessage`
   - `handleOrchestrate_TeamBroadcast_DelegatesToHandleTeamBroadcast`
   - `handleOrchestrate_TeamShutdown_DelegatesToHandleTeamShutdown`
   - `handleOrchestrate_TeamStatus_DelegatesToHandleTeamStatus`
   - `handleOrchestrate_TaskClaim_DelegatesToHandleTaskClaim`
   - `handleOrchestrate_TaskComplete_DelegatesToHandleTaskComplete`
   - `handleOrchestrate_TaskFail_DelegatesToHandleTaskFail`
   - Expected failure: `composite.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement composite handler
   - File: `plugins/exarchos/servers/exarchos-mcp/src/orchestrate/composite.ts`
   - Import handlers from `team/tools.ts` and `tasks/tools.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Consider grouping team_* and task_* into sub-switches for clarity
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] All 8 actions route correctly
- [ ] Team and task handlers both accessible from single composite
- [ ] EventStore + stateDir threaded to both team and task handlers

**Dependencies:** A2
**Parallelizable:** Yes (worktree)
**Branch:** `feat/progressive-disclosure/b3-composite-orchestrate`

---

### Task B4: Composite Handler — exarchos_view

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write routing tests for all 6 actions
   - File: `plugins/exarchos/servers/exarchos-mcp/src/views/composite.test.ts`
   - `handleView_Pipeline_DelegatesToHandleViewPipeline`
   - `handleView_Tasks_DelegatesToHandleViewTasks`
   - `handleView_WorkflowStatus_DelegatesToHandleViewWorkflowStatus`
   - `handleView_TeamStatus_DelegatesToHandleViewTeamStatus`
   - `handleView_StackStatus_DelegatesToHandleStackStatus`
   - `handleView_StackPlace_DelegatesToHandleStackPlace`
   - Expected failure: `composite.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement composite handler
   - File: `plugins/exarchos/servers/exarchos-mcp/src/views/composite.ts`
   - Import handlers from `views/tools.ts` and `stack/tools.ts`
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] All 6 actions route correctly (4 view + 2 stack)
- [ ] ViewMaterializer and EventStore dependencies threaded through

**Dependencies:** A2
**Parallelizable:** Yes (worktree)
**Branch:** `feat/progressive-disclosure/b4-composite-view`

---

### Task B5: Update index.ts — Register Composites

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `createServer_RegistersFiveTools`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/index.test.ts`
   - Mock `McpServer.tool()` to count registrations
   - Assert exactly 5 `server.tool()` calls (one per composite)
   - Assert tool names match: `exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`, `exarchos_sync`
   - Expected failure: `createServer` still registers 27 tools
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Replace registration in `createServer()`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/index.ts`
   - Import `TOOL_REGISTRY` and `buildCompositeSchema` from registry
   - Import composite handlers from each module's `composite.ts`
   - Replace 9 `registerXTools` calls with registry-driven loop
   - Preserve EventStore configuration (still needed by handlers)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Remove unused `registerXTools` imports, clean up
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Exactly 5 tools registered
- [ ] EventStore configured for all modules that need it
- [ ] Old individual tool names no longer registered
- [ ] Existing handler functions NOT deleted (used by CLI and composites)

**Dependencies:** B1, B2, B3, B4
**Parallelizable:** No (integration point)
**Branch:** `feat/progressive-disclosure/b5-index-registration`

---

### Group C: CLI Entry Point (Parallel with B, after A)

---

### Task C1: CLI Framework

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write framework tests
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli.test.ts`
   - `parseStdinJson_ValidJson_ReturnsParsed`: Pipe JSON to stdin helper, verify parse
   - `parseStdinJson_EmptyStdin_ReturnsEmptyObject`: Handle no-input gracefully
   - `outputJson_Object_WritesToStdout`: Verify JSON serialization to stdout
   - `routeCommand_KnownCommand_ExecutesHandler`: Verify command routing
   - `routeCommand_UnknownCommand_ExitsWithError`: Verify error exit for unknown commands
   - Expected failure: `cli.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement CLI skeleton
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli.ts`
   - `parseStdinJson()`: Read stdin, parse JSON, return object
   - `outputJson(obj)`: JSON.stringify to stdout
   - `main()`: Read `process.argv[2]`, dispatch to command handlers
   - Stub command handlers that return errors
   - Add shebang: `#!/usr/bin/env node`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract stdin/stdout helpers to `cli-helpers.ts` if file grows
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] stdin JSON parsing works for all hook input shapes
- [ ] stdout JSON output is valid JSON
- [ ] Unknown commands exit with non-zero code
- [ ] Known commands dispatch correctly

**Dependencies:** A1 (imports registry types)
**Parallelizable:** Yes (worktree, parallel with Group B)
**Branch:** `feat/progressive-disclosure/c1-cli-framework`

---

### Task C2: CLI — pre-compact Command

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write checkpoint + stop tests
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/pre-compact.test.ts`
   - `preCompact_ActiveWorkflow_WritesCheckpointFile`: Create temp state file, run command, verify `.checkpoint.json` created
   - `preCompact_ActiveWorkflow_OutputsContinueFalse`: Verify stdout contains `{ "continue": false }`
   - `preCompact_ActiveWorkflow_CheckpointContainsSummary`: Verify checkpoint has phase, tasks, nextAction
   - `preCompact_NoActiveWorkflows_OutputsContinueTrue`: No active workflows → don't stop Claude
   - `preCompact_MultipleWorkflows_CheckpointsAll`: Verify all active workflows get checkpoint files
   - `preCompact_ManualTrigger_AlsoCheckpoints`: Verify manual compaction also triggers checkpoint
   - Expected failure: `pre-compact.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement pre-compact command
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/pre-compact.ts`
   - `listStateFiles()` to find active workflows
   - For each: read state, compute summary, compute next action, write `.checkpoint.json`
   - Output `{ "continue": false, "stopReason": "Checkpoint saved. Run /resume to continue." }`
   - Import `handleNextAction` logic for next-action computation (configure EventStore optionally)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract checkpoint file read/write into reusable module
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Checkpoint files created alongside state files
- [ ] `continue: false` prevents compaction
- [ ] Multiple active workflows all checkpointed
- [ ] Checkpoint includes enough data for full resume

**Dependencies:** C1, A2
**Parallelizable:** Yes (after C1)
**Branch:** `feat/progressive-disclosure/c2-pre-compact`

---

### Task C3: CLI — session-start Command

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write resume context tests
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/session-start.test.ts`
   - `sessionStart_CheckpointExists_OutputsResumeContext`: Create checkpoint file, verify stdout has summary + nextAction
   - `sessionStart_CheckpointExists_IncludesAutoDirective`: Verify `AUTO:delegate` (or similar) in output
   - `sessionStart_CheckpointExists_CleansUpCheckpointFile`: Verify checkpoint file deleted after read
   - `sessionStart_NoCheckpoint_OutputsNothing`: No checkpoint → empty stdout (silent)
   - `sessionStart_ActiveWorkflowNoCheckpoint_OutputsWorkflowContext`: Active workflow without checkpoint still outputs discovery info
   - Expected failure: `session-start.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement session-start command
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/session-start.ts`
   - Scan for `.checkpoint.json` files in stateDir
   - If found: read, format human-readable resume context, output to stdout, clean up checkpoint
   - If not found: scan for active workflows, output brief discovery info
   - Include `AUTO:<next-action>` directive in resume output
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Resume context includes phase, task progress, artifact paths
- [ ] AUTO directive enables auto-continue without tool calls
- [ ] Checkpoint cleanup prevents stale checkpoints
- [ ] Silent when no active workflow (per brainstorming skill requirement)

**Dependencies:** C1, C2 (shares checkpoint file format)
**Parallelizable:** Yes (after C1)
**Branch:** `feat/progressive-disclosure/c3-session-start`

---

### Task C4: CLI — guard Command (Phase Guardrails)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write phase validation tests
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/guard.test.ts`
   - `guard_WorkflowSetInIdeate_Allows`: workflow:set is valid in ideate phase
   - `guard_OrchestrateInIdeate_Denies`: orchestrate:team_spawn is invalid in ideate
   - `guard_ViewInDelegate_Allows`: view:tasks is valid in delegate
   - `guard_OrchestrateInDelegate_Allows`: orchestrate:task_claim is valid in delegate
   - `guard_OrchestrateInReview_Denies`: orchestrate:team_spawn is invalid in review
   - `guard_NoActiveWorkflow_Allows`: If no workflow active, allow all (graceful degradation)
   - `guard_DenyReturnsPermissionDecision`: Verify JSON output format matches PreToolUse schema
   - Expected failure: `guard.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement guard command
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/guard.ts`
   - Read `tool_name` and `tool_input.action` from stdin JSON
   - Extract composite tool name from MCP tool name (`mcp__exarchos__exarchos_workflow` → `exarchos_workflow`)
   - Find active workflow, read current phase
   - Look up action in `TOOL_REGISTRY`, check if current phase is in `action.phases`
   - Output `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }` or `"deny"` with reason
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract phase lookup into registry helper function
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Correct allow/deny for every phase × tool combination
- [ ] JSON output matches PreToolUse hookSpecificOutput schema exactly
- [ ] Graceful degradation when no active workflow

**Dependencies:** C1, A2
**Parallelizable:** Yes (after C1)
**Branch:** `feat/progressive-disclosure/c4-guard`

---

### Task C5: CLI — Quality Gate Commands

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write gate tests
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/gates.test.ts`
   - `taskGate_InputHasTaskSubject_ParsesCorrectly`: Verify stdin parsing of TaskCompleted schema
   - `taskGate_ConfiguredChecksPass_ExitsZero`: Mock passing checks, verify exit 0
   - `taskGate_TypecheckFails_ExitsTwo`: Mock failing typecheck, verify exit 2 + stderr message
   - `teammateGate_InputHasTeammateName_ParsesCorrectly`: Verify TeammateIdle schema parsing
   - `teammateGate_AllGatesPass_ExitsZero`: Mock passing, verify exit 0
   - Expected failure: `gates.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement task-gate and teammate-gate commands
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/gates.ts`
   - `taskGate`: Read stdin, extract task context, run configurable checks (typecheck, test, clean worktree)
   - `teammateGate`: Similar but with teammate-specific checks
   - Use `child_process.execSync` for running npm commands with timeout
   - Exit 2 with descriptive stderr on failure
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Gate failures produce actionable stderr messages
- [ ] Exit codes correct (0 = pass, 2 = block)
- [ ] Timeout handling for slow test suites

**Dependencies:** C1
**Parallelizable:** Yes (after C1)
**Branch:** `feat/progressive-disclosure/c5-gates`

---

### Task C6: CLI — subagent-context Command

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write context injection tests
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/subagent-context.test.ts`
   - `subagentContext_DelegatePhase_OutputsOrchestrateGuidance`: Verify output mentions task_claim, task_complete
   - `subagentContext_ReviewPhase_OutputsViewGuidance`: Verify output mentions view tools only
   - `subagentContext_NoWorkflow_OutputsGenericGuidance`: Graceful fallback
   - `subagentContext_OutputIncludesDoNotCall`: Verify negative guidance (tools to avoid)
   - Expected failure: `subagent-context.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement subagent-context command
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/subagent-context.ts`
   - Read current phase from active workflow
   - Filter `TOOL_REGISTRY` actions by phase + role (teammate)
   - Format as human-readable guidance: available tools, actions, and what to avoid
   - Output as JSON with `additionalContext` field (or plain text for SubagentStart)
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Phase-specific tool lists are correct
- [ ] Negative guidance (do-not-call) lists included
- [ ] Output format matches SubagentStart hook expectations

**Dependencies:** C1, A2
**Parallelizable:** Yes (after C1)
**Branch:** `feat/progressive-disclosure/c6-subagent-context`

---

### Group D: Integration (After B and C)

---

### Task D1: Hook Configuration & Installer

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write installer tests
   - File: `src/install.test.ts`
   - `install_CreatesHooksSymlink`: Verify `~/.claude/plugins/exarchos/hooks/hooks.json` symlink exists after install
   - `install_HooksJsonIsValidJson`: Verify hooks.json parses as valid JSON
   - `install_HooksJsonHasSixHookEvents`: Verify PreCompact, SessionStart, PreToolUse, TaskCompleted, TeammateIdle, SubagentStart
   - `install_RemovesAutoResumeRule`: Verify `~/.claude/rules/workflow-auto-resume.md` is removed (or not created)
   - Expected failure: hooks.json doesn't exist, auto-resume still installed
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create hooks.json and update installer
   - File: `plugins/exarchos/hooks/hooks.json` — Create with all 6 hook definitions per design
   - File: `src/install.ts` — Add hooks symlink creation, remove auto-resume rule symlinking
   - Hook commands reference `${CLAUDE_PLUGIN_ROOT}/servers/exarchos-mcp/dist/cli.js`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Ensure hook timeouts and statusMessages are consistent
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] hooks.json is valid and complete
- [ ] Installer creates correct symlinks
- [ ] Auto-resume rule no longer installed
- [ ] Hook commands use `${CLAUDE_PLUGIN_ROOT}` correctly

**Dependencies:** B5 (index.ts updated), C1-C6 (CLI commands exist)
**Parallelizable:** No (integration)
**Branch:** `feat/progressive-disclosure/d1-hooks-installer`

---

### Task D2: Generate Docs Script

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write generation tests
   - File: `plugins/exarchos/servers/exarchos-mcp/scripts/generate-docs.test.ts`
   - `generateDocs_ProducesMarkdownTable`: Verify output contains | Tool | Actions | table
   - `generateDocs_AllCompositesPresent`: Verify all 5 composite names appear
   - `generateDocs_AllActionsListed`: Verify all 21 actions appear
   - `generateDocs_IncludesPhaseMapping`: Verify phase affinity column populated
   - Expected failure: `generate-docs.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement doc generation script
   - File: `plugins/exarchos/servers/exarchos-mcp/scripts/generate-docs.ts`
   - Import `TOOL_REGISTRY`
   - Generate Markdown with: tool table, action details, phase mappings, usage examples
   - Output to stdout (can be redirected to `rules/mcp-tool-guidance.md`)
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Generated Markdown is well-formed
- [ ] All registry data reflected in output
- [ ] Can replace hand-maintained `rules/mcp-tool-guidance.md`

**Dependencies:** A2
**Parallelizable:** Yes (parallel with D1)
**Branch:** `feat/progressive-disclosure/d2-generate-docs`

---

### Task D3: Prompt Migration — Update 56 Files

**Phase:** Mechanical transformation (no TDD — validated by reference audit)

**Steps:**

1. Run `generate-docs.ts` to produce updated `rules/mcp-tool-guidance.md`

2. Update all command files (`commands/*.md`):
   - Replace `mcp__exarchos__exarchos_workflow_init` → `exarchos_workflow` with `action: "init"`
   - Replace `mcp__exarchos__exarchos_workflow_set` → `exarchos_workflow` with `action: "set"`
   - Replace `mcp__exarchos__exarchos_workflow_get` → `exarchos_workflow` with `action: "get"`
   - (and so on for all 21 action mappings)

3. Update all skill files (`skills/**/*.md`):
   - Same transformation as commands
   - Remove references to eliminated tools (workflow_checkpoint, workflow_summary, workflow_next_action, workflow_list, workflow_reconcile, workflow_transitions)
   - Replace eliminated tool instructions with hook behavior descriptions

4. Update all rule files (`rules/*.md`):
   - Regenerate `mcp-tool-guidance.md` from script
   - Remove `workflow-auto-resume.md` (replaced by SessionStart hook)
   - Update any remaining tool name references

5. Run reference audit: `grep -r 'exarchos_workflow_init\|exarchos_workflow_list\|exarchos_workflow_checkpoint\|exarchos_workflow_summary\|exarchos_workflow_next_action\|exarchos_workflow_reconcile\|exarchos_workflow_transitions' commands/ skills/ rules/`
   - Must return zero results (all old names eliminated)

**Verification:**
- [ ] Zero references to old-style individual tool names
- [ ] Zero references to eliminated tools
- [ ] All skills reference composite tool names with action parameters
- [ ] Generated mcp-tool-guidance.md replaces hand-maintained version

**Dependencies:** D2 (generate-docs for reference table), B5 (final tool names confirmed)
**Parallelizable:** No (touches many files, risk of conflicts)
**Branch:** `feat/progressive-disclosure/d3-prompt-migration`

---

## Parallelization Strategy

### Execution Diagram

```
Group A (Sequential Foundation):
  A1 ──→ A2
             ╲
              ╲
Group B (Parallel Composites):        Group C (Parallel CLI):
  A2 ──→ B1 ──╲                        A2 ──→ C1 ──→ C2
  A2 ──→ B2 ───╲                              C1 ──→ C3
  A2 ──→ B3 ────→ B5                          C1 ──→ C4
  A2 ──→ B4 ──╱                               C1 ──→ C5
                                               C1 ──→ C6
                    ╲                           ╱
                     ╲                         ╱
Group D (Integration):
  B5 + C* ──→ D1
  A2 ──────→ D2 ──→ D3
```

### Parallel Groups for Worktrees

| Group | Tasks | Worktree | Prerequisites |
|---|---|---|---|
| Foundation | A1 → A2 | main | None |
| Composites-1 | B1 (workflow) | worktree-b1 | A2 merged |
| Composites-2 | B2 (event) | worktree-b2 | A2 merged |
| Composites-3 | B3 (orchestrate) | worktree-b3 | A2 merged |
| Composites-4 | B4 (view) | worktree-b4 | A2 merged |
| CLI-Framework | C1 | worktree-c1 | A2 merged |
| CLI-Commands | C2, C3, C4, C5, C6 | worktree-c* | C1 merged |
| Integration | B5 → D1 | main | B1-B4 merged |
| Docs + Migration | D2 → D3 | worktree-d | A2 merged (D2), B5 merged (D3) |

**Maximum parallelism:** 5 worktrees (B1-B4 + C1) after A2 completes.

---

## Deferred Items

| Item | Rationale |
|---|---|
| Auto-restart wrapper | Design Open Question #1: Thin shell wrapper to auto-restart Claude after PreCompact stop. Low priority — manual `/resume` is acceptable. |
| Async quality gates | Design Open Question #4: task-gate with `async: true` for slow test suites. Can be toggled later by changing hooks.json. |
| `continue: false` verification | Design Open Question #5: Need to empirically verify PreCompact + `continue: false` prevents compaction. Fallback (SessionStart compact handler) trivial to add. |
| Per-skill tool manifest generation | Design mentions optional `skills/*/references/tool-manifest.md`. Defer until prompt migration reveals whether inline fragments are needed. |

---

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] 5 composite tools registered (27 individual tools removed)
- [ ] 6 CLI commands implemented and tested
- [ ] hooks.json created with all 6 hook definitions
- [ ] Installer updated (hooks symlink, auto-resume rule removed)
- [ ] Generated docs replace hand-maintained reference
- [ ] Zero old-style tool name references in prompts
- [ ] Ready for review
