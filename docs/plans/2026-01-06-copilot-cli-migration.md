# Implementation Plan: Copilot CLI Migration

## Source Design
Link: `docs/designs/2026-01-06-copilot-cli-migration.md`

## Summary
- Total tasks: 18
- Parallel groups: 3
- Estimated test count: 24

## Deliverables

| Component | Files | Tests |
|-----------|-------|-------|
| Workflow State (PowerShell) | `copilot-cli/scripts/workflow-state.ps1` | Pester tests |
| Installation Script | `copilot-cli/scripts/install-copilot-workflow.ps1` | Pester tests |
| Agents (4) | `copilot-cli/agents/*.agent.md` | Format validation |
| Skills (7) | `copilot-cli/skills/*/SKILL.md` | Format validation |
| Instructions | `copilot-cli/copilot-instructions.md` | Content validation |

## Task Breakdown

---

### Group A: Core Infrastructure (Sequential)

These tasks must be completed in order - installation script depends on workflow-state script.

---

### Task A1: Create PowerShell Test Infrastructure

**Phase:** RED → GREEN

1. [RED] Create Pester test scaffold
   - File: `copilot-cli/scripts/workflow-state.tests.ps1`
   - Write test: `Describe "workflow-state" { It "should exist" { ... } }`
   - Expected failure: File not found or module not loaded

2. [GREEN] Create minimal PowerShell script
   - File: `copilot-cli/scripts/workflow-state.ps1`
   - Implement: Empty script with param block

**Dependencies:** None
**Parallelizable:** No (foundation)

---

### Task A2: Implement Init Command

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `Init_ValidFeatureId_CreatesStateFile`
   - File: `copilot-cli/scripts/workflow-state.tests.ps1`
   - Expected failure: Function not implemented

2. [RED] Write test: `Init_ExistingFile_ThrowsError`
   - Expected failure: No error thrown

3. [GREEN] Implement `Invoke-WorkflowStateInit` function
   - File: `copilot-cli/scripts/workflow-state.ps1`
   - Create JSON state file with schema

4. [REFACTOR] Extract JSON schema to helper function

**Dependencies:** Task A1
**Parallelizable:** No

---

### Task A3: Implement Get Command

**Phase:** RED → GREEN

1. [RED] Write test: `Get_ValidFile_ReturnsJson`
   - File: `copilot-cli/scripts/workflow-state.tests.ps1`
   - Expected failure: Function not implemented

2. [RED] Write test: `Get_WithQuery_ReturnsFilteredValue`
   - Expected failure: jq query not processed

3. [RED] Write test: `Get_MissingFile_ThrowsError`
   - Expected failure: No error thrown

4. [GREEN] Implement `Invoke-WorkflowStateGet` function
   - File: `copilot-cli/scripts/workflow-state.ps1`
   - Use `jq` for JSON queries (require jq.exe)

**Dependencies:** Task A2
**Parallelizable:** No

---

### Task A4: Implement Set Command

**Phase:** RED → GREEN

1. [RED] Write test: `Set_ValidFilter_UpdatesFile`
   - File: `copilot-cli/scripts/workflow-state.tests.ps1`
   - Expected failure: Function not implemented

2. [RED] Write test: `Set_UpdatesTimestamp`
   - Expected failure: Timestamp not updated

3. [RED] Write test: `Set_MissingFile_ThrowsError`
   - Expected failure: No error thrown

4. [GREEN] Implement `Invoke-WorkflowStateSet` function
   - File: `copilot-cli/scripts/workflow-state.ps1`
   - Use `jq` for JSON manipulation

**Dependencies:** Task A3
**Parallelizable:** No

---

### Task A5: Implement List Command

**Phase:** RED → GREEN

1. [RED] Write test: `List_ActiveWorkflows_ReturnsFormatted`
   - File: `copilot-cli/scripts/workflow-state.tests.ps1`
   - Expected failure: Function not implemented

2. [RED] Write test: `List_CompletedWorkflows_ExcludesFromList`
   - Expected failure: Completed workflows shown

3. [GREEN] Implement `Invoke-WorkflowStateList` function
   - File: `copilot-cli/scripts/workflow-state.ps1`

**Dependencies:** Task A4
**Parallelizable:** No

---

### Task A6: Implement Summary Command

**Phase:** RED → GREEN

1. [RED] Write test: `Summary_ValidFile_ReturnsMarkdown`
   - File: `copilot-cli/scripts/workflow-state.tests.ps1`
   - Expected failure: Function not implemented

2. [RED] Write test: `Summary_IncludesTaskProgress`
   - Expected failure: Task count missing

3. [GREEN] Implement `Invoke-WorkflowStateSummary` function
   - File: `copilot-cli/scripts/workflow-state.ps1`

**Dependencies:** Task A5
**Parallelizable:** No

---

### Task A7: Implement Next-Action Command

**Phase:** RED → GREEN

1. [RED] Write test: `NextAction_IdeatePhase_ReturnsHumanCheckpoint`
   - File: `copilot-cli/scripts/workflow-state.tests.ps1`
   - Expected failure: Function not implemented

2. [RED] Write test: `NextAction_PlanComplete_ReturnsAutoDelegate`
   - Expected failure: Wrong action returned

3. [RED] Write test: `NextAction_AllTasksComplete_ReturnsAutoReview`
   - Expected failure: Wrong action returned

4. [RED] Write test: `NextAction_ReviewsPassed_ReturnsAutoSynthesize`
   - Expected failure: Wrong action returned

5. [GREEN] Implement `Invoke-WorkflowStateNextAction` function
   - File: `copilot-cli/scripts/workflow-state.ps1`
   - Match bash script logic exactly

**Dependencies:** Task A6
**Parallelizable:** No

---

### Task A8: Create Installation Script Scaffold

**Phase:** RED → GREEN

1. [RED] Write test: `Install_CreatesDirectoryStructure`
   - File: `copilot-cli/scripts/install-copilot-workflow.tests.ps1`
   - Expected failure: Script not found

2. [GREEN] Create installation script with param block
   - File: `copilot-cli/scripts/install-copilot-workflow.ps1`
   - Implement directory creation

**Dependencies:** Task A7
**Parallelizable:** No

---

### Task A9: Implement Dependency Detection

**Phase:** RED → GREEN

1. [RED] Write test: `Install_DetectsJq_ReturnsTrue`
   - File: `copilot-cli/scripts/install-copilot-workflow.tests.ps1`
   - Expected failure: Detection not implemented

2. [RED] Write test: `Install_MissingJq_OffersInstall`
   - Expected failure: No install prompt

3. [RED] Write test: `Install_DetectsCopilotCli_ReturnsVersion`
   - Expected failure: Detection not implemented

4. [GREEN] Implement `Test-Dependencies` function
   - File: `copilot-cli/scripts/install-copilot-workflow.ps1`

**Dependencies:** Task A8
**Parallelizable:** No

---

### Task A10: Implement File Installation

**Phase:** RED → GREEN

1. [RED] Write test: `Install_CopiesAgents_ToCorrectLocation`
   - File: `copilot-cli/scripts/install-copilot-workflow.tests.ps1`
   - Expected failure: Files not copied

2. [RED] Write test: `Install_CopiesScripts_ToCorrectLocation`
   - Expected failure: Scripts not copied

3. [RED] Write test: `Install_Force_OverwritesExisting`
   - Expected failure: Existing files not overwritten

4. [GREEN] Implement `Install-WorkflowFiles` function
   - File: `copilot-cli/scripts/install-copilot-workflow.ps1`

**Dependencies:** Task A9
**Parallelizable:** No

---

### Task A11: Implement Validation

**Phase:** RED → GREEN

1. [RED] Write test: `Install_Validation_ChecksAllComponents`
   - File: `copilot-cli/scripts/install-copilot-workflow.tests.ps1`
   - Expected failure: Validation not implemented

2. [RED] Write test: `Install_Validation_ReportsFailures`
   - Expected failure: Failures not reported

3. [GREEN] Implement `Test-Installation` function
   - File: `copilot-cli/scripts/install-copilot-workflow.ps1`

**Dependencies:** Task A10
**Parallelizable:** No

---

### Group B: Agents (Parallel)

These tasks can run in parallel - no dependencies between them.
Location: `copilot-cli/agents/`

---

### Task B1: Finalize Orchestrator Agent

**Phase:** GREEN (example exists)

1. [GREEN] Move and validate orchestrator agent
   - Source: `examples/copilot-cli/agents/orchestrator.agent.md`
   - Target: `copilot-cli/agents/orchestrator.agent.md`
   - Validate: YAML frontmatter, required fields

**Dependencies:** None
**Parallelizable:** Yes (with B2, B3, B4)

---

### Task B2: Finalize Implementer Agent

**Phase:** GREEN

1. [GREEN] Move and validate implementer agent
   - Source: `examples/copilot-cli/agents/implementer.agent.md`
   - Target: `copilot-cli/agents/implementer.agent.md`

**Dependencies:** None
**Parallelizable:** Yes (with B1, B3, B4)

---

### Task B3: Finalize Reviewer Agent

**Phase:** GREEN

1. [GREEN] Move and validate reviewer agent
   - Source: `examples/copilot-cli/agents/reviewer.agent.md`
   - Target: `copilot-cli/agents/reviewer.agent.md`

**Dependencies:** None
**Parallelizable:** Yes (with B1, B2, B4)

---

### Task B4: Finalize Integrator Agent

**Phase:** GREEN

1. [GREEN] Move and validate integrator agent
   - Source: `examples/copilot-cli/agents/integrator.agent.md`
   - Target: `copilot-cli/agents/integrator.agent.md`

**Dependencies:** None
**Parallelizable:** Yes (with B1, B2, B3)

---

### Group C: Skills Conversion (Parallel)

Convert Claude Code skills to Copilot CLI format.
Location: `copilot-cli/skills/`

---

### Task C1: Convert Brainstorming Skill

**Phase:** GREEN → REFACTOR

1. [GREEN] Add YAML frontmatter to brainstorming skill
   - Source: `skills/brainstorming/SKILL.md`
   - Target: `copilot-cli/skills/brainstorming/SKILL.md`
   - Add: `name`, `description` in frontmatter

2. [REFACTOR] Update tool references
   - Replace: `Skill()` → natural skill chaining
   - Replace: `Task()` → `/agent` invocation
   - Update: state script path to `~/.copilot/scripts/`

**Dependencies:** None
**Parallelizable:** Yes (with C2-C7)

---

### Task C2: Convert Implementation-Planning Skill

**Phase:** GREEN → REFACTOR

1. [GREEN] Add YAML frontmatter
   - Source: `skills/implementation-planning/SKILL.md`
   - Target: `copilot-cli/skills/implementation-planning/SKILL.md`

2. [REFACTOR] Update tool references

**Dependencies:** None
**Parallelizable:** Yes

---

### Task C3: Convert Delegation Skill

**Phase:** GREEN → REFACTOR

1. [GREEN] Add YAML frontmatter
   - Source: `skills/delegation/SKILL.md`
   - Target: `copilot-cli/skills/delegation/SKILL.md`

2. [REFACTOR] Update tool references
   - Key change: `Task()` → `/agent implementer` or `/delegate`

**Dependencies:** None
**Parallelizable:** Yes

---

### Task C4: Convert Integration Skill

**Phase:** GREEN → REFACTOR

1. [GREEN] Add YAML frontmatter
   - Source: `skills/integration/SKILL.md`
   - Target: `copilot-cli/skills/integration/SKILL.md`

2. [REFACTOR] Update tool references

**Dependencies:** None
**Parallelizable:** Yes

---

### Task C5: Convert Spec-Review Skill

**Phase:** GREEN → REFACTOR

1. [GREEN] Add YAML frontmatter
   - Source: `skills/spec-review/SKILL.md`
   - Target: `copilot-cli/skills/spec-review/SKILL.md`

2. [REFACTOR] Update tool references

**Dependencies:** None
**Parallelizable:** Yes

---

### Task C6: Convert Quality-Review Skill

**Phase:** GREEN → REFACTOR

1. [GREEN] Add YAML frontmatter
   - Source: `skills/quality-review/SKILL.md`
   - Target: `copilot-cli/skills/quality-review/SKILL.md`

2. [REFACTOR] Update tool references

**Dependencies:** None
**Parallelizable:** Yes

---

### Task C7: Convert Synthesis Skill

**Phase:** GREEN → REFACTOR

1. [GREEN] Add YAML frontmatter
   - Source: `skills/synthesis/SKILL.md`
   - Target: `copilot-cli/skills/synthesis/SKILL.md`

2. [REFACTOR] Update tool references

**Dependencies:** None
**Parallelizable:** Yes

---

### Group D: Instructions (Parallel with C)

---

### Task D1: Finalize Copilot Instructions

**Phase:** GREEN

1. [GREEN] Move and validate instructions file
   - Source: `examples/copilot-cli/copilot-instructions.md`
   - Target: `copilot-cli/copilot-instructions.md`
   - Validate: All rule sections present

**Dependencies:** None
**Parallelizable:** Yes (with Group C)

---

## Parallelization Strategy

```
Phase 1 (Sequential - Foundation):
  A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 → A9 → A10 → A11

Phase 2 (Parallel - Content):
  ┌─ B1 (orchestrator)
  ├─ B2 (implementer)
  ├─ B3 (reviewer)
  ├─ B4 (integrator)
  ├─ C1 (brainstorming)
  ├─ C2 (implementation-planning)
  ├─ C3 (delegation)
  ├─ C4 (integration)
  ├─ C5 (spec-review)
  ├─ C6 (quality-review)
  ├─ C7 (synthesis)
  └─ D1 (instructions)
```

## Worktree Strategy

Given the parallel structure:

| Worktree | Tasks | Branch |
|----------|-------|--------|
| Main session | A1-A11 (sequential) | `feature/copilot-scripts` |
| Worktree 1 | B1-B4, D1 | `feature/copilot-agents` |
| Worktree 2 | C1-C7 | `feature/copilot-skills` |

## Completion Checklist

- [ ] All Pester tests pass for PowerShell scripts
- [ ] Installation script works on fresh Windows machine
- [ ] All agents have valid YAML frontmatter
- [ ] All skills have valid YAML frontmatter
- [ ] All tool references updated to Copilot equivalents
- [ ] State script paths point to `~/.copilot/scripts/`
- [ ] Instructions file contains all rules
- [ ] README updated with installation instructions

## Verification Commands

```powershell
# Run all Pester tests
Invoke-Pester -Path copilot-cli/scripts/*.tests.ps1

# Validate agent frontmatter
Get-ChildItem copilot-cli/agents/*.agent.md | ForEach-Object {
    $content = Get-Content $_ -Raw
    if ($content -notmatch '^---\s*\n.*?name:.*?description:.*?---') {
        Write-Error "Invalid frontmatter: $_"
    }
}

# Validate skill frontmatter
Get-ChildItem copilot-cli/skills/*/SKILL.md | ForEach-Object {
    $content = Get-Content $_ -Raw
    if ($content -notmatch '^---\s*\nname:') {
        Write-Error "Missing frontmatter: $_"
    }
}
```
