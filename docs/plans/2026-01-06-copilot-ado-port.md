# Implementation Plan: Copilot CLI Azure DevOps Port

## Source Design
Link: `docs/designs/2026-01-06-copilot-ado-port.md`

## Summary
- Total tasks: 10
- Parallel groups: 3
- Estimated test count: 18 (Pester tests for PowerShell, validation tests for markdown)

## Parallelization Strategy

```
Phase 1 (Parallel Group A):        Phase 1 (Parallel Group B):
┌─────────────────────────┐        ┌─────────────────────────┐
│ Task 001: MCP Config    │        │ Task 003: State Updates │
│ Task 002: Auth Script   │        │ Task 004: Install Script│
└───────────┬─────────────┘        └───────────┬─────────────┘
            │                                   │
            └──────────────┬───────────────────┘
                           │
                           ▼
            Phase 2 (Sequential after Phase 1):
            ┌─────────────────────────┐
            │ Task 005: Synthesis     │
            │ Task 006: Delegation    │
            │ Task 007: Orchestrator  │
            │ Task 008: Reviewer      │
            └───────────┬─────────────┘
                        │
                        ▼
            Phase 3 (Parallel - Documentation):
            ┌─────────────────────────┐
            │ Task 009: CLI Reference │
            │ Task 010: Instructions  │
            └─────────────────────────┘
```

---

## Task Breakdown

### Task 001: MCP Server Configuration Template

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `McpConfig_ValidStructure_ContainsAzureDevOpsServer`
   - File: `copilot-cli/tests/mcp-config.tests.ps1`
   - Expected failure: File not found or missing azure-devops server entry
   - Run: `Invoke-Pester -Path copilot-cli/tests/mcp-config.tests.ps1` - MUST FAIL

2. [GREEN] Create MCP configuration template
   - File: `copilot-cli/.mcp.json`
   - Contents: Azure DevOps MCP server configuration with env variable placeholders
   - Run: `Invoke-Pester -Path copilot-cli/tests/mcp-config.tests.ps1` - MUST PASS

3. [REFACTOR] Validate JSON schema compliance
   - Ensure proper escaping of environment variable references
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra configuration beyond ADO requirements

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 002: ADO Authentication Helper Script

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests for authentication functions
   - File: `copilot-cli/tests/ado-auth.tests.ps1`
   - Tests:
     - `GetAdoToken_PatEnvSet_ReturnsPat`
     - `GetAdoToken_NoPatButAzCliAvailable_ReturnsCliToken`
     - `GetAdoToken_NeitherAvailable_ThrowsError`
     - `TestAdoConnection_ValidOrg_ReturnsTrue`
   - Expected failure: Functions not defined
   - Run: `Invoke-Pester -Path copilot-cli/tests/ado-auth.tests.ps1` - MUST FAIL

2. [GREEN] Implement authentication functions
   - File: `copilot-cli/scripts/ado-auth.ps1`
   - Functions: `Get-AdoToken`, `Test-AdoConnection`
   - Run: `Invoke-Pester -Path copilot-cli/tests/ado-auth.tests.ps1` - MUST PASS

3. [REFACTOR] Add parameter validation and help documentation
   - Add `[CmdletBinding()]` and proper parameter attributes
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Error messages are clear and actionable

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 003: Workflow State ADO Extensions

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests for ADO state initialization
   - File: `copilot-cli/tests/workflow-state-ado.tests.ps1`
   - Tests:
     - `InitAdo_ValidParams_CreatesStateWithAdoFields`
     - `InitAdo_ValidParams_SetsPlatformToAzureDevops`
     - `InitAdo_ValidParams_IncludesOrgProjectRepo`
     - `GetAdoConfig_ExistingState_ReturnsAdoObject`
   - Expected failure: init-ado command not recognized
   - Run: `Invoke-Pester -Path copilot-cli/tests/workflow-state-ado.tests.ps1` - MUST FAIL

2. [GREEN] Add ADO initialization to workflow-state.ps1
   - File: `copilot-cli/scripts/workflow-state.ps1`
   - Add: `init-ado` command, ADO state fields, version bump to 1.1
   - Run: `Invoke-Pester -Path copilot-cli/tests/workflow-state-ado.tests.ps1` - MUST PASS

3. [REFACTOR] Extract ADO-specific logic to helper functions
   - Keep main dispatcher clean
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Backward compatible with existing state files (version 1.0)

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 004: Installation Script ADO Setup

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests for ADO MCP installation
   - File: `copilot-cli/tests/install-ado.tests.ps1`
   - Tests:
     - `InstallAdoMcp_NpmAvailable_InstallsPackage`
     - `InstallAdoMcp_NoMcpConfig_CreatesConfig`
     - `InstallAdoMcp_ExistingConfig_PreservesOtherServers`
   - Expected failure: Install-AdoMcp function not defined
   - Run: `Invoke-Pester -Path copilot-cli/tests/install-ado.tests.ps1` - MUST FAIL

2. [GREEN] Add ADO installation to install script
   - File: `copilot-cli/scripts/install-copilot-workflow.ps1`
   - Add: `Install-AdoMcp` function, MCP config creation
   - Run: `Invoke-Pester -Path copilot-cli/tests/install-ado.tests.ps1` - MUST PASS

3. [REFACTOR] Add idempotency checks
   - Skip if already installed
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Installation is idempotent (safe to run multiple times)

**Dependencies:** Task 001 (MCP config template)
**Parallelizable:** Yes (in same group as Task 001)

---

### Task 005: Synthesis Skill ADO PR Creation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Validate ADO PR creation documentation
   - File: `copilot-cli/tests/synthesis-ado.tests.ps1`
   - Tests:
     - `SynthesisSkill_ContainsAdoPrCreation_True`
     - `SynthesisSkill_ContainsMcpToolReference_True`
     - `SynthesisSkill_ContainsWorkItemLinking_True`
   - Expected failure: Skill file missing ADO content
   - Run: `Invoke-Pester -Path copilot-cli/tests/synthesis-ado.tests.ps1` - MUST FAIL

2. [GREEN] Update synthesis skill with ADO flow
   - File: `copilot-cli/skills/synthesis/SKILL.md`
   - Add: ADO MCP tool calls for PR creation, work item linking section
   - Run: `Invoke-Pester -Path copilot-cli/tests/synthesis-ado.tests.ps1` - MUST PASS

3. [REFACTOR] Organize into platform-specific sections
   - Clear separation between GitHub and ADO flows
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Both GitHub and ADO flows documented

**Dependencies:** Task 001, Task 003
**Parallelizable:** No (sequential with other skill updates)

---

### Task 006: Delegation Skill ADO Branch Creation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Validate ADO branch creation documentation
   - File: `copilot-cli/tests/delegation-ado.tests.ps1`
   - Tests:
     - `DelegationSkill_ContainsAdoBranchCreation_True`
     - `DelegationSkill_ContainsMcpRepoCreateBranch_True`
   - Expected failure: Skill file missing ADO content
   - Run: `Invoke-Pester -Path copilot-cli/tests/delegation-ado.tests.ps1` - MUST FAIL

2. [GREEN] Update delegation skill with ADO branch creation
   - File: `copilot-cli/skills/delegation/SKILL.md`
   - Add: ADO MCP branch creation alternative to git-only flow
   - Run: `Invoke-Pester -Path copilot-cli/tests/delegation-ado.tests.ps1` - MUST PASS

3. [REFACTOR] Document when to use MCP vs git commands
   - Clear guidance on platform detection
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Git commands still work as fallback

**Dependencies:** Task 001, Task 003
**Parallelizable:** No (sequential with other skill updates)

---

### Task 007: Orchestrator Agent ADO Tool References

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Validate orchestrator ADO awareness
   - File: `copilot-cli/tests/orchestrator-ado.tests.ps1`
   - Tests:
     - `OrchestratorAgent_ContainsAdoMcpTools_True`
     - `OrchestratorAgent_ContainsPrUrlFormat_True`
     - `OrchestratorAgent_ContainsWorkItemSyntax_True`
   - Expected failure: Agent file missing ADO content
   - Run: `Invoke-Pester -Path copilot-cli/tests/orchestrator-ado.tests.ps1` - MUST FAIL

2. [GREEN] Update orchestrator agent with ADO references
   - File: `copilot-cli/agents/orchestrator.agent.md`
   - Add: ADO MCP tool references, PR URL format, AB# syntax handling
   - Run: `Invoke-Pester -Path copilot-cli/tests/orchestrator-ado.tests.ps1` - MUST PASS

3. [REFACTOR] None needed (documentation update)
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Agent can coordinate both GitHub and ADO workflows

**Dependencies:** Task 001, Task 003
**Parallelizable:** No (sequential with other agent updates)

---

### Task 008: Reviewer Agent ADO Thread Parsing

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Validate reviewer ADO thread handling
   - File: `copilot-cli/tests/reviewer-ado.tests.ps1`
   - Tests:
     - `ReviewerAgent_ContainsAdoThreadStructure_True`
     - `ReviewerAgent_ContainsPriorityMapping_True`
   - Expected failure: Agent file missing ADO thread content
   - Run: `Invoke-Pester -Path copilot-cli/tests/reviewer-ado.tests.ps1` - MUST FAIL

2. [GREEN] Update reviewer agent with ADO thread structure
   - File: `copilot-cli/agents/reviewer.agent.md`
   - Add: ADO thread structure parsing, priority assignment for ADO comments
   - Run: `Invoke-Pester -Path copilot-cli/tests/reviewer-ado.tests.ps1` - MUST PASS

3. [REFACTOR] None needed (documentation update)
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Priority mapping matches design spec (P1-P4)

**Dependencies:** Task 001, Task 003
**Parallelizable:** No (sequential with other agent updates)

---

### Task 009: CLI Fallback Documentation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Validate CLI reference exists
   - File: `copilot-cli/tests/cli-reference.tests.ps1`
   - Tests:
     - `CliReference_FileExists_True`
     - `CliReference_ContainsPrCreate_True`
     - `CliReference_ContainsPrUpdate_True`
     - `CliReference_ContainsWorkItemLink_True`
   - Expected failure: File not found
   - Run: `Invoke-Pester -Path copilot-cli/tests/cli-reference.tests.ps1` - MUST FAIL

2. [GREEN] Create CLI fallback documentation
   - File: `copilot-cli/docs/ado-cli-reference.md`
   - Contents: `az devops` equivalents for all MCP operations
   - Run: `Invoke-Pester -Path copilot-cli/tests/cli-reference.tests.ps1` - MUST PASS

3. [REFACTOR] Add troubleshooting section
   - Common errors and solutions
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] All MCP tools have CLI equivalents documented

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 010: Copilot Instructions ADO Context

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Validate instructions include ADO context
   - File: `copilot-cli/tests/instructions-ado.tests.ps1`
   - Tests:
     - `Instructions_ContainsAdoPlatform_True`
     - `Instructions_ContainsMcpToolList_True`
     - `Instructions_ContainsAdoStateInit_True`
   - Expected failure: Instructions missing ADO content
   - Run: `Invoke-Pester -Path copilot-cli/tests/instructions-ado.tests.ps1` - MUST FAIL

2. [GREEN] Update copilot-instructions.md with ADO context
   - File: `copilot-cli/copilot-instructions.md`
   - Add: Platform detection, ADO MCP tool list, state initialization with ADO params
   - Run: `Invoke-Pester -Path copilot-cli/tests/instructions-ado.tests.ps1` - MUST PASS

3. [REFACTOR] Organize into platform-agnostic and platform-specific sections
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Instructions work for both GitHub and ADO users

**Dependencies:** Task 003
**Parallelizable:** Yes

---

## Completion Checklist

- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards (Pester tests for all PowerShell)
- [ ] Ready for review

## Test Summary

| Task | Test File | Test Count |
|------|-----------|------------|
| 001 | mcp-config.tests.ps1 | 1 |
| 002 | ado-auth.tests.ps1 | 4 |
| 003 | workflow-state-ado.tests.ps1 | 4 |
| 004 | install-ado.tests.ps1 | 3 |
| 005 | synthesis-ado.tests.ps1 | 3 |
| 006 | delegation-ado.tests.ps1 | 2 |
| 007 | orchestrator-ado.tests.ps1 | 3 |
| 008 | reviewer-ado.tests.ps1 | 2 |
| 009 | cli-reference.tests.ps1 | 4 |
| 010 | instructions-ado.tests.ps1 | 3 |
| **Total** | | **29** |
