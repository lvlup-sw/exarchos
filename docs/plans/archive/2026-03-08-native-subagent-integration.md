# Implementation Plan: Native Subagent Integration

**Design:** [`docs/designs/2026-03-08-native-subagent-integration.md`](../designs/2026-03-08-native-subagent-integration.md)
**Base branch:** `feat/lazy-schema-runbook-protocol` ([PR #972](https://github.com/lvlup-sw/exarchos/pull/972))
**Dependency:** Builds on the lazy schema + runbook protocol implementation. `RunbookDefinition` type, `describe` action, gate metadata, and slim registration are all available from PR #972.

## Prerequisites

PR #972 has two CI failures that must be resolved before branching:
1. `index.test.ts:144` — drift test assertion failure (needs update after runbook changes)
2. `index.test.ts:280` — `toolRegistrations.get('exarchos_sync')` returns undefined (tool registration issue)

These should be fixed on the PR #972 branch first (via `/exarchos:shepherd`) or as the first commit on our feature branch.

## Task Overview

| Phase | Tasks | Parallelizable | Description |
|-------|-------|----------------|-------------|
| 1 — Agent Spec Registry | 1-5 | Tasks 1-2 parallel, then 3, then 4-5 parallel | Foundation types, definitions, handler, tests |
| 2 — CC Agent Generation | 6-9 | Tasks 6-7 parallel, then 8, then 9 | Build script, plugin manifest, drift tests, skill update |
| 3 — Resume + Hooks | 10-14 | Tasks 10-12 parallel, then 13-14 | State extension, hook handler, TASK_FIX runbook, skill update |
| 4 — Platform Capability | 15-17 | Tasks 15-16 parallel, then 17 | prepare_delegation narrowing, platformHint, docs |

**Total: 17 tasks across 4 phases**

---

## Phase 1: Agent Spec Registry (Foundation)

### Task 1: Define AgentSpec Types
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `AgentSpecTypes_ValidateShape_AcceptsCompleteSpec`
   - File: `servers/exarchos-mcp/src/agents/agents.test.ts`
   - Test that `AgentSpec` type accepts a well-formed spec with all required fields
   - Test that `AgentSkill` and `AgentValidationRule` types are properly constrained
   - Expected failure: Module `./types.js` does not exist

2. [GREEN] Implement types
   - File: `servers/exarchos-mcp/src/agents/types.ts`
   - Define `AgentSkill`, `AgentValidationRule`, `AgentSpec` interfaces per design §1.1
   - Export `ALL_VALID_AGENT_TOOLS` constant for tool validation
   - Export `AgentSpecId` type union: `'implementer' | 'fixer' | 'reviewer'`

3. [REFACTOR] Extract shared types if overlap with existing `ToolAction` interface

**Dependencies:** None
**Parallelizable:** Yes (with Task 2)

---

### Task 2: Define Agent Spec Definitions
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `ImplementerSpec_HasRequiredFields_Complete` — validates implementer spec has systemPrompt, tools, model, isolation
   - `FixerSpec_IsNotResumable_ReturnsTrue` — fixer.resumable === false
   - `ReviewerSpec_HasReadOnlyTools_NoWriteEdit` — reviewer tools exclude Write/Edit
   - `AllSpecs_HaveUniqueIds_NoDuplicates` — ALL_AGENT_SPECS IDs are unique
   - `AllSpecs_ToolsAreValid_KnownToolNames` — all tool names are from known CC tool set
   - File: `servers/exarchos-mcp/src/agents/agents.test.ts`
   - Expected failure: Module `./definitions.js` does not exist

2. [GREEN] Implement definitions
   - File: `servers/exarchos-mcp/src/agents/definitions.ts`
   - Define `IMPLEMENTER`, `FIXER`, `REVIEWER` constants per design §1.2
   - Export `ALL_AGENT_SPECS` array
   - System prompts use `{{templateVar}}` interpolation syntax

3. [REFACTOR] Extract shared prompt fragments (worktree verification, completion report format) into constants

**Dependencies:** Task 1 (types)
**Parallelizable:** Yes (with Task 1 — types can be written inline first, imported after)

---

### Task 3: Implement `agent_spec` Action Handler
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `AgentSpec_ValidAgent_ReturnsFullSpec` — returns complete spec for "implementer"
   - `AgentSpec_UnknownAgent_ReturnsError` — returns UNKNOWN_AGENT with validAgents list
   - `AgentSpec_WithContext_InterpolatesTemplateVars` — `{{taskDescription}}` replaced with provided value
   - `AgentSpec_UnresolvedVars_ReportsUnresolved` — returns unresolvedVars array for missing template vars
   - `AgentSpec_PromptOnlyFormat_ReturnsJustPrompt` — format: "prompt-only" returns only systemPrompt
   - `AgentSpec_FullFormat_ResolvesSkillContent` — skills[].content populated from skill files
   - File: `servers/exarchos-mcp/src/agents/handler.test.ts`
   - Expected failure: Module `./handler.js` does not exist

2. [GREEN] Implement handler
   - File: `servers/exarchos-mcp/src/agents/handler.ts`
   - `handleAgentSpec()` function per design §2.2
   - Zod schema: `agentSpecSchema` per design §2.1
   - Template variable interpolation via `String.replaceAll()`
   - Skill content resolution via `resolveSkillContent()` helper (reads from skills/ directory)

3. [REFACTOR] Extract template interpolation into shared utility (may be reused by runbook protocol)

**Dependencies:** Tasks 1, 2
**Parallelizable:** No

---

### Task 4: Register `agent_spec` in Orchestrate Composite
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `OrchestrateComposite_AgentSpecAction_RoutesToHandler` — action: "agent_spec" dispatches correctly
   - `OrchestrateRegistry_IncludesAgentSpec_InActionList` — agent_spec appears in orchestrateActions
   - File: `servers/exarchos-mcp/src/orchestrate/composite.test.ts` (extend existing)
   - Expected failure: Unknown action "agent_spec"

2. [GREEN] Wire into orchestrate composite
   - File: `servers/exarchos-mcp/src/orchestrate/composite.ts`
   - Add `agent_spec` to `ACTION_HANDLERS` map
   - File: `servers/exarchos-mcp/src/registry.ts`
   - Add `agent_spec` action definition to `orchestrateActions` array with schema, description, phases, roles

3. [REFACTOR] Ensure existing bidirectional sync test (`OrchestrateActions_MatchCompositeHandlers_InSync`) passes with new action

**Dependencies:** Task 3
**Parallelizable:** Yes (with Task 5)

---

### Task 5: Agent Spec Anti-Drift Tests
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write drift prevention tests per design §Anti-Drift:
   - `AllAgentSpecs_ReferencedInRunbooks_HaveRegistrySpec` — every `params.agent` in runbooks maps to a spec (if runbook definitions exist)
   - `AllAgentSpecs_ReferenceValidSkills_SkillFilesExist` — skill names map to actual skill files
   - `AllAgentSpecs_ReferenceValidTools_KnownToolNames` — tools are valid CC tool names
   - `AllAgentSpecs_UniqueIds_NoDuplicates` — id uniqueness
   - `AllAgentSpecs_TemplateVars_AreDocumented` — {{vars}} in prompts are catalogued
   - File: `servers/exarchos-mcp/src/agents/drift.test.ts`
   - Expected failure: Some tests may pass immediately (uniqueness already tested in Task 2); skill file resolution may fail if skills don't exist yet

2. [GREEN] Implement test helpers
   - `getAvailableSkillNames()` — reads skill directories from `skills/` path
   - `getValidToolNames()` — returns set of known Claude Code tool names
   - Make all tests pass with current agent spec definitions

3. [REFACTOR] Consolidate with existing registry drift test patterns

**Dependencies:** Tasks 1, 2 (spec definitions must exist)
**Parallelizable:** Yes (with Task 4)

---

## Phase 2: Claude Code Agent Generation (Native Integration)

### Task 6: Implement CC Agent File Generator
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `GenerateAgentMarkdown_Implementer_HasCorrectFrontmatter` — name, description, tools, model, isolation, memory, maxTurns in YAML
   - `GenerateAgentMarkdown_Implementer_HasHooksFromRules` — PreToolUse/PostToolUse hooks generated from validationRules
   - `GenerateAgentMarkdown_Reviewer_OmitsOptionalFields` — no isolation, no maxTurns when not set
   - `GenerateAgentMarkdown_Fixer_DisallowedToolsPresent` — disallowedTools: Agent in frontmatter
   - `GenerateAllAgentFiles_CreatesAllFiles_MatchesSpecCount` — generates N files for N specs
   - `BuildHooksFromRules_PreWrite_MapsToWriteEditMatcher` — trigger mapping is correct
   - File: `servers/exarchos-mcp/src/agents/generate-cc-agents.test.ts`
   - Expected failure: Module does not exist

2. [GREEN] Implement generator
   - File: `servers/exarchos-mcp/src/agents/generate-cc-agents.ts`
   - `generateAgentMarkdown(spec)` — returns markdown string with YAML frontmatter + system prompt body
   - `buildHooksFromRules(rules)` — maps AgentValidationRule[] to CC hook format
   - `generateAllAgentFiles(outDir)` — writes all agent files to directory
   - Use `yaml` package for YAML serialization (or lightweight hand-rolled serializer)

3. [REFACTOR] Ensure generated YAML is deterministic (sorted keys) for stable diffs

**Dependencies:** Phase 1 complete (needs agent spec definitions)
**Parallelizable:** Yes (with Task 7)

---

### Task 7: Update Plugin Manifest and Build Pipeline
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test:
   - `PluginManifest_IncludesAgentsDirectory_InComponents` — plugin.json lists agents/ as a component
   - File: `servers/exarchos-mcp/src/agents/plugin.test.ts`
   - Expected failure: plugin.json does not include agents/

2. [GREEN] Implement changes
   - File: `.claude-plugin/plugin.json` — add `"agents": "agents/"` to plugin components
   - File: `servers/exarchos-mcp/package.json` — add `generate:agents` script that calls `generateAllAgentFiles()`
   - File: `package.json` (root) — wire `generate:agents` into build pipeline (post-build step)
   - Create `agents/` directory with `.gitkeep` (files generated at build time)

3. [REFACTOR] Ensure `npm run build` produces both `dist/` and `agents/` outputs

**Dependencies:** Task 6 (generator must exist)
**Parallelizable:** Yes (with Task 6 — manifest update is independent of generator implementation)

---

### Task 8: Generated File Drift Tests
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests per design §Generated File Drift Tests:
   - `GeneratedAgentFiles_MatchRegistrySpecs_NameCorrect` — parsed frontmatter.name matches `exarchos-${spec.id}`
   - `GeneratedAgentFiles_MatchRegistrySpecs_ModelCorrect` — parsed frontmatter.model matches spec.model
   - `GeneratedAgentFiles_MatchRegistrySpecs_DescriptionCorrect` — parsed frontmatter.description matches
   - `GeneratedAgentFiles_MatchRegistrySpecs_IsolationCorrect` — isolation field present when spec has it
   - `GeneratedAgentFiles_MatchRegistrySpecs_MemoryCorrect` — memory field matches memoryScope
   - `GeneratedAgentFiles_AllSpecsHaveFiles_NoneSkipped` — every spec has a corresponding .md file
   - File: `servers/exarchos-mcp/src/agents/generated-drift.test.ts`
   - Expected failure: Agent files don't exist or are stale

2. [GREEN] Implement frontmatter parser for tests
   - Parse YAML frontmatter from generated .md files
   - Compare against ALL_AGENT_SPECS registry
   - Generate files in test setup if needed (or require pre-built)

3. [REFACTOR] Use existing YAML parsing if available in project; consider snapshot testing as alternative

**Dependencies:** Tasks 6, 7 (generator and generated files must exist)
**Parallelizable:** No

---

### Task 9: Update Delegation Skill for Native Agents
**Phase:** RED → GREEN → REFACTOR

This is a **skill prose update**, not a code change. No TDD cycle — verified by manual review.

1. Update `skills/delegation/SKILL.md`:
   - Replace inline prompt template references with `subagent_type: "exarchos-implementer"`
   - Remove `model: "opus"` from Task() calls (defined by agent spec)
   - Simplify dispatch prompt to task-specific context only
   - Add note that agent's system prompt, model, isolation, skills, hooks, and memory are defined by the agent specification

2. Update `skills/delegation/references/implementer-prompt.md`:
   - Add header noting this is the **source template** that feeds the agent spec registry
   - Reference `servers/exarchos-mcp/src/agents/definitions.ts` as the compiled location
   - Keep as documentation reference (not used at runtime when native agents are available)

3. Verify no other skills reference `subagent_type: "general-purpose"` for delegation tasks

**Dependencies:** Phase 1 complete, Tasks 6-8 complete
**Parallelizable:** No (final integration step of Phase 2)

---

## Phase 3: Resume + Hooks (Agent Continuity)

### Task 10: Extend Workflow State with `agentId`
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `TaskSchema_AgentId_AcceptsOptionalString` — TaskSchema.parse succeeds with agentId field
   - `TaskSchema_AgentResumed_AcceptsOptionalBoolean` — agentResumed field works
   - `TaskSchema_LastExitReason_AcceptsOptionalString` — lastExitReason field works
   - `WorkflowSet_AgentId_PersistsOnTask` — setting `tasks.task-001.agentId` via workflow set action persists
   - File: `servers/exarchos-mcp/src/workflow/schemas.test.ts` (extend existing)
   - Expected failure: Unknown key "agentId" in TaskSchema

2. [GREEN] Extend TaskSchema
   - File: `servers/exarchos-mcp/src/workflow/schemas.ts`
   - Add to `TaskSchema`: `agentId: z.string().optional()`, `agentResumed: z.boolean().optional()`, `lastExitReason: z.string().optional()`
   - Ensure backward compatibility (all new fields optional, `.passthrough()` already present)

3. [REFACTOR] Group agent-related fields with JSDoc comment

**Dependencies:** None (can start independently)
**Parallelizable:** Yes (with Tasks 11, 12)

---

### Task 11: Implement `subagent-stop` CLI Hook Handler
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `HandleSubagentStop_ValidInput_UpdatesWorkflowState` — agentId and exitReason written to workflow task
   - `HandleSubagentStop_ValidInput_EmitsAgentStoppedEvent` — agent.stopped event appended to stream
   - `HandleSubagentStop_MissingContext_ReturnsError` — graceful error when featureId/taskId not resolvable
   - `HandleSubagentStop_NonExarchosAgent_NoOp` — ignores agents without exarchos- prefix
   - File: `servers/exarchos-mcp/src/cli-commands/subagent-stop.test.ts`
   - Expected failure: Module does not exist

2. [GREEN] Implement handler
   - File: `servers/exarchos-mcp/src/cli-commands/subagent-stop.ts`
   - Parse `SubagentStopInput` from stdin JSON
   - Extract featureId + taskId from agent description or environment variables
   - Call workflow set action to update task's agentId + lastExitReason
   - Call event append to emit `agent.stopped` event
   - File: `servers/exarchos-mcp/src/adapters/cli.ts`
   - Add `'subagent-stop'` to `HOOK_COMMANDS` set
   - Add handler mapping in `commandHandlers`

3. [REFACTOR] Extract context resolution (featureId/taskId from agent metadata) into shared utility

**Dependencies:** Task 10 (agentId field must exist in schema)
**Parallelizable:** Yes (with Tasks 10, 12 — can stub schema dependency)

---

### Task 12: Add SubagentStop Hook to Plugin Configuration
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test:
   - `HooksJson_SubagentStop_DefinedForExarchosAgents` — hooks.json includes SubagentStop entry with matcher for exarchos-implementer|exarchos-fixer
   - File: `servers/exarchos-mcp/src/agents/plugin.test.ts` (extend from Task 7)
   - Expected failure: No SubagentStop hook in hooks.json

2. [GREEN] Update hooks configuration
   - File: `hooks/hooks.json`
   - Add SubagentStop entry per design §5.1:
     ```json
     "SubagentStop": [
       {
         "matcher": "exarchos-implementer|exarchos-fixer",
         "hooks": [
           { "type": "command", "command": "node dist/exarchos.js subagent-stop" }
         ]
       }
     ]
     ```

3. [REFACTOR] Verify hook command path is consistent with existing hook entries

**Dependencies:** None (configuration change)
**Parallelizable:** Yes (with Tasks 10, 11)

---

### Task 13: Define TASK_FIX Runbook
**Phase:** RED → GREEN → REFACTOR

Uses `RunbookDefinition` type and `ALL_RUNBOOKS` array from PR #972's runbook protocol implementation (`servers/exarchos-mcp/src/runbooks/`).

1. [RED] Write tests:
   - `TaskFixRunbook_HasCorrectPhase_Delegate` — phase is "delegate"
   - `TaskFixRunbook_FirstStepIsResumeOrSpawn_NativeTask` — step[0].tool is "native:Task"
   - `TaskFixRunbook_IncludesGateChain_TddThenStatic` — steps include check_tdd_compliance then check_static_analysis
   - `TaskFixRunbook_TemplateVarsIncludeAgentId_ForResume` — templateVars includes "agentId"
   - `TaskFixRunbook_ReferencesValidActions_InRegistry` — all non-native steps map to real registry actions (existing anti-drift pattern)
   - File: `servers/exarchos-mcp/src/runbooks/task-fix.test.ts`
   - Expected failure: TASK_FIX constant does not exist

2. [GREEN] Define TASK_FIX runbook
   - File: `servers/exarchos-mcp/src/runbooks/definitions.ts` — add TASK_FIX alongside existing TASK_COMPLETION, QUALITY_EVALUATION, etc.
   - Per design §4.4: resume_or_spawn → check_tdd_compliance → check_static_analysis → task_complete
   - Add to `ALL_RUNBOOKS` array
   - Existing anti-drift tests (`runbooks.test.ts`) should automatically validate the new runbook's action references

3. [REFACTOR] Verify existing "every runbook step references a valid registry action" test covers TASK_FIX

**Dependencies:** Task 10 (agentId in state)
**Parallelizable:** No (sequential within Phase 3)

---

### Task 14: Update Delegation Skill with Resume-Aware Fixer Flow
**Phase:** RED → GREEN → REFACTOR

This is a **skill prose update** — verified by manual review, not automated tests.

1. Update `skills/delegation/SKILL.md`:
   - Add "Fix Failed Tasks" section per design §7.2
   - Document resume decision flow: agentId available → resume; otherwise → fresh fixer dispatch
   - Reference TASK_FIX runbook for gate chain

2. Update `skills/delegation/references/fix-mode.md`:
   - Add resume-first strategy documentation
   - Document agentId capture from Task() completion
   - Explain adversarial context injection on resume

3. Update `skills/delegation/references/fixer-prompt.md`:
   - Add note that this template is used for fresh fixer dispatch (non-resume case)
   - Reference agent spec registry as the source for fixer agent configuration

**Dependencies:** Tasks 10-13 complete
**Parallelizable:** No (final integration step of Phase 3)

---

## Phase 4: Platform Capability + Polish

### Task 15: Add `nativeIsolation` to `prepare_delegation`
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `PrepareDelegation_NativeIsolationTrue_SkipsWorktreeCreation` — no `git worktree add` called when nativeIsolation: true
   - `PrepareDelegation_NativeIsolationFalse_CreatesWorktrees` — existing behavior preserved (default)
   - `PrepareDelegation_NativeIsolationTrue_StillTracksState` — workflow state updated even without worktree creation
   - `PrepareDelegation_NativeIsolationTrue_StillRunsPreChecks` — quality pre-checks still execute
   - File: `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts` (extend existing)
   - Expected failure: Unknown parameter "nativeIsolation"

2. [GREEN] Extend prepare_delegation
   - File: `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`
   - Add `nativeIsolation` to input schema (z.boolean().default(false))
   - When true: skip worktree creation + npm install, but still validate phase and run quality checks
   - Return same readiness verdict shape with `isolation: 'native'` flag
   - File: `servers/exarchos-mcp/src/registry.ts`
   - Update prepare_delegation action schema with nativeIsolation parameter

3. [REFACTOR] Extract worktree creation into separate function for clarity

**Dependencies:** Phase 1 complete (for context)
**Parallelizable:** Yes (with Task 16)

---

### Task 16: Add `platformHint` to Runbook Step Resolution
**Phase:** RED → GREEN → REFACTOR

Extends the runbook handler from PR #972 (`servers/exarchos-mcp/src/runbooks/handler.ts`).

1. [RED] Write tests:
   - `RunbookResolve_NativeTaskStep_IncludesPlatformHint` — resolved step has platformHint object
   - `RunbookResolve_NativeTaskWithAgent_HintReferencesAgentSpec` — generic hint mentions agent_spec()
   - `RunbookResolve_McpStep_NoPlatformHint` — non-native steps don't get hints
   - File: `servers/exarchos-mcp/src/runbooks/handler.test.ts` (extend existing)
   - Expected failure: No platformHint field on resolved steps

2. [GREEN] Extend runbook resolution
   - File: `servers/exarchos-mcp/src/runbooks/handler.ts`
   - In `handleRunbook()` detail mode, when resolving `native:Task` steps with `params.agent`, add:
     ```typescript
     platformHint: {
       claudeCode: `Uses native agent definition exarchos-${agent}`,
       generic: `Call agent_spec("${agent}") to get system prompt and tool restrictions`,
     }
     ```

3. [REFACTOR] Consider making platformHint generation configurable

**Dependencies:** None (runbook handler exists from PR #972)
**Parallelizable:** Yes (with Task 15)

---

### Task 17: Update Skill Reference Documentation
**Phase:** Documentation only — no TDD cycle

1. Update `skills/delegation/references/implementer-prompt.md`:
   - Add deprecation notice for inline usage
   - Document that agent spec registry in `servers/exarchos-mcp/src/agents/definitions.ts` is now the source of truth
   - Keep as reference documentation for prompt evolution

2. Update `skills/delegation/references/worktree-enforcement.md`:
   - Document native worktree isolation via `isolation: "worktree"` on agent definition
   - Note that `prepare_delegation` with `nativeIsolation: true` skips manual worktree creation
   - Keep worktree verification in agent system prompt as defense-in-depth

3. Update `skills/delegation/references/state-management.md`:
   - Document agentId tracking in workflow state
   - Document SubagentStop hook for automatic state updates
   - Reference TASK_FIX runbook for resume-aware fixer flow

4. Update `CHANGELOG.md` or release notes with native subagent integration summary

**Dependencies:** All previous tasks complete
**Parallelizable:** No (final documentation pass)

---

## Parallelization Map

```
Phase 1:
  ┌─────────┐  ┌─────────┐
  │ Task 1  │  │ Task 2  │   ← parallel
  │ Types   │  │ Defs    │
  └────┬────┘  └────┬────┘
       └──────┬─────┘
              │
        ┌─────┴─────┐
        │  Task 3   │   ← sequential
        │  Handler  │
        └─────┬─────┘
              │
    ┌─────────┼─────────┐
    │                    │
┌───┴───┐          ┌────┴────┐
│Task 4 │          │ Task 5  │   ← parallel
│Registry│         │ Drift   │
└───┬───┘          └────┬────┘
    └─────────┬─────────┘
              │
Phase 2:      │
    ┌─────────┼─────────┐
    │                    │
┌───┴───┐          ┌────┴────┐
│Task 6 │          │ Task 7  │   ← parallel
│Gen CC │          │ Plugin  │
└───┬───┘          └────┬────┘
    └─────────┬─────────┘
              │
        ┌─────┴─────┐
        │  Task 8   │   ← sequential
        │  Drift    │
        └─────┬─────┘
              │
        ┌─────┴─────┐
        │  Task 9   │   ← sequential
        │  Skill    │
        └─────┬─────┘
              │
Phase 3:      │
    ┌─────────┼──────────────────┐
    │         │                  │
┌───┴───┐ ┌──┴────┐       ┌────┴────┐
│Task 10│ │Task 11│       │ Task 12 │   ← parallel
│Schema │ │Hook   │       │ Config  │
└───┬───┘ └──┬────┘       └────┬────┘
    └─────────┼────────────────┘
              │
        ┌─────┴─────┐
        │  Task 13  │   ← sequential (cross-dep: runbook protocol)
        │  Runbook  │
        └─────┬─────┘
              │
        ┌─────┴─────┐
        │  Task 14  │   ← sequential
        │  Skill    │
        └─────┬─────┘
              │
Phase 4:      │
    ┌─────────┼─────────┐
    │                    │
┌───┴───┐          ┌────┴────┐
│Task 15│          │ Task 16 │   ← parallel (cross-dep: runbook protocol)
│Isolat │          │ Hint    │
└───┬───┘          └────┬────┘
    └─────────┬─────────┘
              │
        ┌─────┴─────┐
        │  Task 17  │   ← sequential
        │  Docs     │
        └───────────┘
```

## Maximum Parallelism per Phase

| Phase | Max Parallel Tasks | Agents Needed |
|-------|-------------------|---------------|
| 1 | 2 (Tasks 1+2, then Tasks 4+5) | 2 |
| 2 | 2 (Tasks 6+7) | 2 |
| 3 | 3 (Tasks 10+11+12) | 3 |
| 4 | 2 (Tasks 15+16) | 2 |

## Base Branch Dependencies (PR #972)

Building on `feat/lazy-schema-runbook-protocol` provides:

| Available From PR #972 | Used By Tasks |
|---|---|
| `RunbookDefinition` type + `ALL_RUNBOOKS` array | Task 13 (TASK_FIX added directly) |
| `handleRunbook()` detail mode resolver | Task 16 (platformHint extension) |
| `describe` action on all composite tools | N/A (already available) |
| Gate metadata on `ToolAction` | Task 5 (drift tests can validate gate-agent relationships) |
| Slim registration mode | N/A (already available) |
| Bidirectional sync test patterns for runbooks | Task 13 (TASK_FIX inherits existing drift tests) |

## Key Files Created

| File | Task | Purpose |
|------|------|---------|
| `servers/exarchos-mcp/src/agents/types.ts` | 1 | AgentSpec, AgentSkill, AgentValidationRule types |
| `servers/exarchos-mcp/src/agents/definitions.ts` | 2 | IMPLEMENTER, FIXER, REVIEWER spec constants |
| `servers/exarchos-mcp/src/agents/handler.ts` | 3 | handleAgentSpec() action handler |
| `servers/exarchos-mcp/src/agents/generate-cc-agents.ts` | 6 | CC agent file generator |
| `servers/exarchos-mcp/src/cli-commands/subagent-stop.ts` | 11 | SubagentStop hook handler |
| `agents/exarchos-implementer.md` | 7 | Generated CC agent definition |
| `agents/exarchos-fixer.md` | 7 | Generated CC agent definition |
| `agents/exarchos-reviewer.md` | 7 | Generated CC agent definition |

## Key Files Modified

| File | Tasks | Changes |
|------|-------|---------|
| `servers/exarchos-mcp/src/registry.ts` | 4 | Add agent_spec action to orchestrateActions |
| `servers/exarchos-mcp/src/orchestrate/composite.ts` | 4 | Route agent_spec to handler |
| `servers/exarchos-mcp/src/workflow/schemas.ts` | 10 | Add agentId, agentResumed, lastExitReason to TaskSchema |
| `servers/exarchos-mcp/src/adapters/cli.ts` | 11 | Add subagent-stop to HOOK_COMMANDS |
| `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts` | 15 | Add nativeIsolation parameter |
| `hooks/hooks.json` | 12 | Add SubagentStop hook entry |
| `.claude-plugin/plugin.json` | 7 | Add agents/ to plugin components |
| `skills/delegation/SKILL.md` | 9, 14 | Native agent dispatch, resume-aware fixer flow |
