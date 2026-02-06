# Implementation Plan: Audit Fixes

**Date:** 2026-02-06
**Source:** docs/bugs/2026-02-05-workflow-state-mcp-issues.md + codebase audit findings

## Summary

Fix 4 MCP server bugs that break workflow state management, migrate 23 skill/command files from non-existent bash script references to MCP tools, and fix 3 config gaps.

## Task Dependency Graph

```
Task 1 (passthrough schema) ─┬─→ Task 3 (handleSet reads raw JSON)
                              │
Task 2 (dot-path merge)  ────┘
                              │
                              ├─→ Task 4 (markdown migration - skills)
                              ├─→ Task 5 (markdown migration - commands)
                              └─→ Task 6 (config fixes)
```

Tasks 1-2 are independent. Task 3 depends on both. Tasks 4-6 depend on Task 3 (for correctness verification) and are parallelizable with each other.

---

## Task 1: Add `.passthrough()` to Zod Schemas

**Phase:** RED → GREEN → REFACTOR
**Fixes:** Bug 2 (P0), Bug 3 (P1)

### Problem

`WorkflowStateSchema.safeParse()` strips unknown fields (like `track`, `explore`, `brief`, `planReview`) because Zod's default behavior removes keys not in the schema. Guards that check these dynamic fields always fail.

### Approach

Add `.passthrough()` to all three workflow-type-specific schemas AND the base schema so that dynamic fields survive parsing. The discriminated union itself must also use passthrough variants.

1. **[RED]** Write tests proving dynamic fields are stripped

   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/schemas.test.ts`
   - Test: `WorkflowStateSchema_DynamicFields_PreservedAfterParse` — Create a valid feature state with an extra `planReview` field. Parse it. Assert `planReview` is present in `result.data`.
   - Test: `RefactorWorkflowStateSchema_DynamicFields_PreservedAfterParse` — Create a valid refactor state with `track` and `explore` fields. Parse it. Assert both are present.
   - Expected failure: Dynamic fields will be stripped (absent in `result.data`)

2. **[GREEN]** Add `.passthrough()` to schemas

   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/schemas.ts`
   - Change `BaseWorkflowStateSchema` to use `.passthrough()` on the `z.object({...})` call
   - This propagates to all extended schemas (`FeatureWorkflowStateSchema`, etc.)
   - Note: `.passthrough()` must be on the base, then `.extend()` preserves it

3. **[REFACTOR]** Verify no existing tests break

**Dependencies:** None
**Parallelizable:** Yes (with Task 2)

---

## Task 2: Fix Shallow Merge in `applyDotPath` for Object Updates

**Phase:** RED → GREEN → REFACTOR
**Fixes:** Bug 1 (P1), Bug 4 (P2)

### Problem

When `workflow_set` receives `updates: { artifacts: { design: "path.md" } }`, it replaces the entire `artifacts` object, losing `plan` and `pr` keys. The Zod schema then rejects the state on next read because required keys are missing.

### Root Cause

The `handleSet` function at `tools.ts:238-240` iterates over `input.updates` and calls `applyDotPath(mutableState, dotPath, value)`. When the dotPath is `artifacts` (no dot), it replaces the entire object. Users should use `artifacts.design` instead, but the API should be resilient to both forms.

### Approach

The callers already use dot-path notation (e.g., `artifacts.design`) for simple fields. The issue is when a top-level key is set to an object — `applyDotPath` does a direct replacement. The fix is to deep-merge when the update value is a plain object and the existing value is also a plain object.

1. **[RED]** Write tests proving shallow merge breaks artifacts

   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-store.test.ts`
   - Test: `ApplyDotPath_ObjectUpdate_DeepMerges` — Apply `{ artifacts: { design: "path.md" } }` to a state with full artifacts. Assert `plan` and `pr` keys are preserved.
   - Test: `ApplyDotPath_NestedObjectUpdate_DeepMerges` — Apply `{ synthesis: { prUrl: "https://..." } }` to a state with full synthesis. Assert other keys preserved.
   - Test: `ApplyDotPath_NonObjectUpdate_Replaces` — Apply `{ artifacts.design: "new-path" }` (dot-path). Assert it replaces the value, not merge.
   - Expected failure: First two tests fail (siblings are lost)

2. **[GREEN]** Add deep merge to `applyDotPath`

   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/state-store.ts`
   - In `applyDotPath`, when setting the final value: if both the existing value and the new value are plain objects (not arrays, not null), deep-merge instead of replace
   - Helper: `isPlainObject(v)` — returns true for `typeof v === 'object' && v !== null && !Array.isArray(v)`
   - Deep merge: recursively merge keys from new object into existing object

3. **[REFACTOR]** Extract `deepMerge` as a named helper function

**Dependencies:** None
**Parallelizable:** Yes (with Task 1)

---

## Task 3: Fix `handleSet` to Read Raw JSON for Guard Evaluation

**Phase:** RED → GREEN → REFACTOR
**Fixes:** Bug 2 (P0) — complete fix together with Task 1

### Problem

Even with `.passthrough()` (Task 1), the `handleSet` function at `tools.ts:146` reads state via `readStateFile()` which uses Zod parsing. The fix from Task 1 makes Zod preserve dynamic fields, but we should also ensure the mutable state copy used for guard evaluation retains all fields.

Additionally, `handleGet` (line 103) reads via `readStateFile()` which means `workflow_get` queries against dynamic fields now work with Task 1's passthrough fix. But we need a test to verify this end-to-end.

1. **[RED]** Write end-to-end test proving the full round-trip works

   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Test: `ToolSet_DynamicFields_SurviveRoundTrip` — Init a refactor workflow. Set `track`, `explore.scopeAssessment` via `handleSet`. Read back via `handleGet`. Assert both fields are present.
   - Test: `ToolSet_RefactorTransition_ExploreTooBrief` — Init refactor. Set explore scope assessment. Transition to `brief` phase. Assert success.
   - Test: `ToolGet_DynamicFieldQuery_ReturnsDotPathValue` — Init feature. Set `planReview.approved` to true. Query `planReview.approved` via `handleGet`. Assert returns `true`.
   - Test: `ToolSet_ArtifactUpdate_PreservesSiblings` — Init feature. Set `artifacts.design` via object update (`updates: { artifacts: { design: "path" } }`). Read back. Assert `plan` and `pr` are still present.
   - Expected failure: These tests should fail before Tasks 1+2, pass after

2. **[GREEN]** No additional code changes needed — Tasks 1 and 2 provide the fixes. This task validates the integration.

3. **[REFACTOR]** Clean up any redundant raw-JSON reading in `handleReconcile` (line 671) and `handleNextAction` (line 737) — these read raw JSON as workarounds for the Zod stripping bug. With `.passthrough()`, they can use `readStateFile()` consistently.

**Dependencies:** Task 1, Task 2
**Parallelizable:** No (depends on 1 and 2)

---

## Task 4: Migrate Skill Files from Bash to MCP Tools

**Phase:** DIRECT (no tests — markdown only)

### Problem

23 files reference `~/.claude/scripts/workflow-state.sh` which doesn't exist. All references need to be migrated to `mcp__workflow-state__workflow_*` MCP tool equivalents.

### Migration Map

| Bash Command | MCP Tool |
|-------------|----------|
| `workflow-state.sh init <id>` | `mcp__workflow-state__workflow_init({ featureId, workflowType })` |
| `workflow-state.sh set <file> '<jq-expr>'` | `mcp__workflow-state__workflow_set({ featureId, updates: {...} })` |
| `workflow-state.sh get <file> [query]` | `mcp__workflow-state__workflow_get({ featureId, query })` |
| `workflow-state.sh summary <file>` | `mcp__workflow-state__workflow_summary({ featureId })` |
| `workflow-state.sh next-action <file>` | `mcp__workflow-state__workflow_next_action({ featureId })` |
| `workflow-state.sh list` | `mcp__workflow-state__workflow_list()` |
| `workflow-state.sh reconcile <file>` | `mcp__workflow-state__workflow_reconcile({ featureId })` |

### Files to Migrate

**Skills (18 files):**
- `skills/refactor/phases/auto-chain.md`
- `skills/refactor/phases/overhaul-delegate.md`
- `skills/refactor/phases/overhaul-plan.md`
- `skills/refactor/phases/overhaul-review.md`
- `skills/refactor/phases/brief.md`
- `skills/refactor/phases/polish-implement.md`
- `skills/refactor/phases/polish-validate.md`
- `skills/refactor/phases/explore.md`
- `skills/refactor/phases/update-docs.md`
- `skills/refactor/references/doc-update-checklist.md`
- `skills/refactor/references/brief-template.md`
- `skills/refactor/references/explore-checklist.md`
- `skills/refactor/COMMAND.md`
- `skills/debug/SKILL.md`
- `skills/debug/references/investigation-checklist.md`
- `skills/spec-review/SKILL.md`
- `skills/quality-review/SKILL.md`
- `skills/shared/prompts/context-reading.md`

### Approach

For each file:
1. Read current content
2. Replace bash code blocks with MCP tool invocation descriptions
3. Replace inline bash references with MCP tool names
4. Preserve the intent and documentation structure

**Dependencies:** Task 3 (bug fixes must be in place for MCP tools to work correctly)
**Parallelizable:** Yes (with Tasks 5 and 6)

---

## Task 5: Migrate Command Files from Bash to MCP Tools

**Phase:** DIRECT (no tests — markdown only)

### Files to Migrate

**Commands (5 files):**
- `commands/integrate.md`
- `commands/debug.md`
- `commands/resume.md`
- `commands/synthesize.md`
- `commands/checkpoint.md`

### Approach

Same migration map as Task 4. For each command file:
1. Read current content
2. Replace bash code blocks with MCP tool calls
3. Update state management sections to reference MCP tools

**Dependencies:** Task 3
**Parallelizable:** Yes (with Tasks 4 and 6)

---

## Task 6: Config and Documentation Fixes

**Phase:** DIRECT (no tests)

### Changes

1. **Add workflow-state to marketplace.json**
   - File: `.claude-plugin/marketplace.json`
   - Add: `{ "name": "workflow-state", "source": "./plugins/workflow-state", "description": "Workflow state persistence with HSM transitions", "keywords": ["workflow", "state-machine", "mcp"] }`

2. **Add `scripts/` to package.json files array**
   - File: `package.json`
   - Add `"scripts"` to the `files` array

3. **Update README.md counts**
   - File: `README.md`
   - Commands: 11 → 12 (added `/refactor`)
   - Rules: 9 → 10 (added `primary-workflows.md`)

4. **Remove stale bash permission from settings.json**
   - File: `settings.json`
   - Remove: `"Bash(~/.claude/scripts/workflow-state.sh:*)"` from allow list

**Dependencies:** Task 3 (settings.json change depends on migration being complete)
**Parallelizable:** Yes (with Tasks 4 and 5)

---

## Parallelization Summary

```
Phase 1 (parallel):  Task 1 + Task 2
Phase 2 (sequential): Task 3 (validates 1+2)
Phase 3 (parallel):  Task 4 + Task 5 + Task 6
```

## Verification

After all tasks complete:
1. Run `npm run test:run` in workflow-state-mcp — all tests pass
2. Run `npm run typecheck` in workflow-state-mcp — no errors
3. Grep for `workflow-state.sh` across entire repo — zero matches
4. Grep for `mcp__workflow-state__` in skills/commands — verify consistent usage
