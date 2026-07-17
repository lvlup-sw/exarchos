# Implementation Plan: Copilot CLI Support (Revised)

**Design:** `docs/designs/2026-03-07-copilot-cli-support.md`
**Issue:** #966
**Date:** 2026-03-07
**Revision:** 2 — updated after official docs verification

## Summary

Validate-first approach with dual-format plugin artifacts. The gap is larger than originally estimated: MCP server registration, hooks format, and plugin root resolution all differ between runtimes. Skills are highly compatible. The MCP server code itself needs minimal changes — most work is in plugin packaging and configuration.

## Task Inventory

### Phase 1: Validation (Manual, Prerequisite)

#### Task 0: Execute Validation Protocol on Copilot CLI
**Type:** Manual (not delegatable)

1. Install Exarchos on Copilot CLI: `copilot plugin install lvlup-sw/exarchos`
2. Record: Does inline `mcpServers` in `plugin.json` work or error?
3. Record: Does `${CLAUDE_PLUGIN_ROOT}` resolve in MCP env and hook commands?
4. Record: What `cwd` do hook scripts execute with?
5. Record: Does our `hooks/hooks.json` (PascalCase, `command` field) load or error?
6. Record: Do skills load? Are `metadata.*` frontmatter fields ignored?
7. Record: Do `commands/*.md` load as slash commands?
8. Record: What prefix does Copilot CLI use for MCP tool names?
9. Record: Does `settings.json` cause errors?
10. Produce validation report: `docs/validation/copilot-cli-validation.md`

**Dependencies:** None
**Parallelizable:** No — gates all subsequent tasks
**Deliverable:** Validation report with pass/fail matrix

---

### Phase 2: Plugin Packaging (TDD, Parallel-Safe)

#### Task 1: Runtime Detection Module
**Phase:** RED -> GREEN -> REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/runtime.test.ts`:
   - `detectRuntime_WhenExarchosRuntimeSet_ReturnsOverrideValue`
   - `detectRuntime_WhenClaudePluginRootSet_ReturnsClaudeCode`
   - `detectRuntime_WhenCopilotCliVersionSet_ReturnsCopilotCli`
   - `detectRuntime_WhenNoEnvVars_ReturnsUnknown`
   - Expected failure: Module does not exist

2. [GREEN] Implement `servers/exarchos-mcp/src/runtime.ts`:
   - `Runtime` type: `'claude-code' | 'copilot-cli' | 'unknown'`
   - `detectRuntime()`: env var detection with explicit override
   - Detection env vars updated after Task 0 validation

3. [REFACTOR] Extract env var names to constants

**Dependencies:** None (detection heuristics refined after Task 0)
**Parallelizable:** Yes

---

#### Task 2: Plugin Root Resolution Fallback
**Phase:** RED -> GREEN -> REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/utils/paths.test.ts`:
   - `resolvePluginRoot_WhenExarchosPluginRootSet_ReturnsIt`
   - `resolvePluginRoot_WhenClaudePluginRootSet_ReturnsFallback`
   - `resolvePluginRoot_WhenNoEnvVars_ReturnsDirnameBasedPath`
   - Expected failure: Function does not exist

2. [GREEN] Add `resolvePluginRoot()` to `servers/exarchos-mcp/src/utils/paths.ts`:
   ```typescript
   export function resolvePluginRoot(): string | undefined {
     return process.env.EXARCHOS_PLUGIN_ROOT
       || process.env.CLAUDE_PLUGIN_ROOT
       || dirnameBasedFallback(); // path.resolve(__dirname, '..')
   }
   ```

3. [REFACTOR] Update existing consumers of `process.env.EXARCHOS_PLUGIN_ROOT`:
   - `session-start.ts:readSafetyRules()` (line 414)
   - `orchestrate/run-script.ts:resolveScript()`

**Dependencies:** None
**Parallelizable:** Yes (with Task 1)

---

#### Task 3: Add `.mcp.json` for Copilot CLI MCP Discovery
**Phase:** RED -> GREEN -> REFACTOR
**Condition:** Execute if Task 0 confirms inline `mcpServers` doesn't work on Copilot CLI

1. [RED] Write test in `src/plugin-validation.test.ts` (extend existing):
   - `mcpJson_ExistsAlongsidePluginJson`
   - `mcpJson_DeclaresExarchosMcpServer`
   - `mcpJson_ServerCommandMatchesPluginJson`
   - Expected failure: `.mcp.json` file does not exist

2. [GREEN] Create `.claude-plugin/.mcp.json`:
   ```json
   {
     "mcpServers": {
       "exarchos": {
         "command": "node",
         "args": ["dist/exarchos.js", "mcp"],
         "env": {
           "WORKFLOW_STATE_DIR": "~/.claude/workflow-state"
         }
       }
     }
   }
   ```
   - Path resolution depends on Task 0 findings (relative? absolute? env var?)

3. [REFACTOR] Ensure build step keeps `.mcp.json` in sync with `plugin.json` mcpServers

**Dependencies:** Task 0 (need to know if this is required)
**Parallelizable:** Yes (with Tasks 1, 2, 4)

---

#### Task 4: Generate Copilot CLI-Compatible Hooks
**Phase:** RED -> GREEN -> REFACTOR

1. [RED] Write tests:
   - In `src/plugin-validation.test.ts` (extend):
     - `copilotHooksJson_HasVersionField`
     - `copilotHooksJson_UsesCamelCaseEventNames`
     - `copilotHooksJson_UsesBashFieldNotCommand`
     - `copilotHooksJson_UsesTimeoutSecNotTimeout`
     - `copilotHooksJson_HasNoMatcherField`
     - `copilotHooksJson_HasNoStatusMessageField`
     - `copilotHooksJson_OmitsPreCompactEvent`
     - `copilotHooksJson_OmitsTaskCompletedEvent`
   - Expected failure: Copilot CLI hooks file does not exist

2. [GREEN] Create `hooks/copilot-hooks.json`:
   ```json
   {
     "version": 1,
     "hooks": {
       "sessionStart": [{
         "type": "command",
         "bash": "node dist/exarchos.js session-start",
         "timeoutSec": 10
       }],
       "preToolUse": [{
         "type": "command",
         "bash": "node dist/exarchos.js guard",
         "timeoutSec": 5
       }],
       "sessionEnd": [{
         "type": "command",
         "bash": "node dist/exarchos.js session-end",
         "timeoutSec": 30
       }]
     }
   }
   ```
   - Hook command paths depend on Task 0 findings (relative? need plugin root?)
   - Only include events that exist in Copilot CLI
   - Update `plugin.json` to reference hooks file if needed: `"hooks": "hooks/copilot-hooks.json"`

3. [REFACTOR] Add validation that Claude Code and Copilot CLI hooks stay in sync (same CLI commands, different format)

**Dependencies:** Task 0 (need to know hook path resolution and which `plugin.json` hooks field format works)
**Parallelizable:** Yes (with Tasks 1, 2, 3)

---

### Phase 3: Hook Compensation + Integration (Sequential)

#### Task 5: Hook Compensation — Checkpoint Self-Sufficiency
**Condition:** Execute if Copilot CLI does NOT fire `PreCompact` (confirmed by docs — yes)
**Phase:** RED -> GREEN -> REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/workflow/checkpoint.test.ts`:
   - `phaseTransition_WritesCheckpointFile_WhenPreCompactUnavailable`
   - `phaseTransition_SkipsCheckpoint_WhenPreCompactAvailable`
   - Expected failure: No checkpoint-on-transition logic

2. [GREEN] Add checkpoint call to `exarchos_workflow` `set` handler when phase changes:
   - Check runtime capabilities
   - If PreCompact unavailable, write checkpoint after phase transition
   - Reuse existing checkpoint logic from `pre-compact.ts`

3. [REFACTOR] Extract shared checkpoint logic if needed

**Dependencies:** Task 1 (runtime detection)
**Parallelizable:** No (depends on Task 1)

---

#### Task 6: Wire Runtime Detection into Server Startup
**Phase:** RED -> GREEN -> REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/index.test.ts`:
   - `serverStartup_DetectsRuntime_LogsToStderr`
   - `serverStartup_UsesResolvedPluginRoot`
   - Expected failure: No runtime detection in startup path

2. [GREEN] Modify `servers/exarchos-mcp/src/index.ts`:
   - Call `detectRuntime()` early in `main()`
   - Use `resolvePluginRoot()` instead of direct env var access
   - Log detected runtime to stderr

3. [REFACTOR] Clean up

**Dependencies:** Tasks 1, 2, and all Phase 2 tasks
**Parallelizable:** No

---

#### Task 7: CI Smoke Test for Copilot CLI
**Phase:** GREEN (configuration, not TDD)

1. Add Copilot CLI job to `.github/workflows/test.yml`
2. Install plugin, verify it loads, verify MCP server starts
3. Ensure existing Claude Code tests still pass

**Dependencies:** Task 6
**Parallelizable:** No

---

#### Task 8: Documentation
**Phase:** GREEN (content)

1. `README.md` — Copilot CLI installation section
2. `docs/compatibility.md` — Runtime-specific behavior matrix
3. Update issue #966 with final feature matrix

**Dependencies:** All previous tasks
**Parallelizable:** No

---

## Parallelization Map

```
Task 0 (validation) ──────────────────────────────────────────────┐
                                                                   │
  ┌─── Task 1 (runtime detection) ───┐                            │
  │                                   │                            │
  ├─── Task 2 (plugin root) ─────────┤                            │
  │                                   ├── Task 5 (checkpoint) ──┐ │
  ├─── Task 3 (.mcp.json) ───────────┤                          │ │
  │                                   │                          ├── Task 6 (wiring) ── Task 7 (CI) ── Task 8 (docs)
  └─── Task 4 (copilot hooks) ───────┘                          │
                                                                 │
```

**Group A (parallel):** Tasks 1, 2, 3, 4
**Group B (sequential, after A):** Task 5
**Group C (sequential, after B):** Tasks 6, 7, 8

## Delegation Strategy

- **Task 0:** Not delegatable — requires manual Copilot CLI interaction
- **Tasks 1-4:** Delegate to parallel worktrees (independent modules)
- **Tasks 5-8:** Sequential, main branch

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Inline `mcpServers` errors on Copilot CLI | High | Medium | Task 3 adds `.mcp.json` as fallback |
| `${CLAUDE_PLUGIN_ROOT}` doesn't resolve | High | High | Task 2 provides `__dirname` fallback; Task 4 uses relative paths |
| Claude Code hooks.json format rejected | High | Medium | Task 4 produces separate Copilot CLI hooks file |
| Plugin root `cwd` differs between runtimes | Medium | Medium | Task 0 determines actual behavior; Task 2 handles resolution |
| `commands/*.md` not supported on Copilot CLI | Medium | Low | Commands are convenience aliases for skills; skills are the primary interface |
| Validation reveals more gaps than expected | Medium | Medium | Design allows iterative remediation |
