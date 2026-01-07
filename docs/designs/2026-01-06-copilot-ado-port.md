# Copilot CLI Azure DevOps Port

**Date**: 2026-01-06
**Feature ID**: copilot-ado-port
**Status**: Design Complete

## Overview

Port the existing `copilot-cli` workflow orchestration to support Azure DevOps as the version control and pull request platform. The solution uses Microsoft's official `azure-devops-mcp` server for ADO operations while maintaining full parity with the 7-phase workflow.

### Goals

1. **Full Parity**: All 7 workflow phases function identically (ideate → plan → delegate → integrate → review → synthesize → merge)
2. **ADO-Native**: PRs, branches, and work item linking via Azure DevOps APIs
3. **MCP-First**: Primary integration through `azure-devops-mcp` for clean Claude integration
4. **Windows Environment**: PowerShell scripts, Windows paths, Microsoft tooling

### Non-Goals

- CI/CD pipeline configuration (no yml pipelines)
- CodeRabbit or other bot integrations
- Work item creation (linking only)
- GitHub fallback support

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    GitHub Copilot CLI (Windows)                 │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ Orchestrator│  │ Implementer │  │  Reviewer   │  (agents)   │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│         └────────────────┼────────────────┘                     │
│                          │                                      │
│  ┌───────────────────────▼───────────────────────┐              │
│  │              Workflow Skills                   │              │
│  │  brainstorming │ planning │ delegation │ etc. │              │
│  └───────────────────────┬───────────────────────┘              │
│                          │                                      │
│  ┌───────────────────────▼───────────────────────┐              │
│  │            State Management (PowerShell)       │              │
│  │            workflow-state.ps1                  │              │
│  └───────────────────────┬───────────────────────┘              │
└──────────────────────────┼──────────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           │                               │
┌──────────▼──────────┐         ┌─────────▼──────────┐
│  azure-devops-mcp   │         │   az devops CLI    │
│    (Primary)        │         │    (Fallback)      │
│                     │         │                    │
│ • PR operations     │         │ • Auth debugging   │
│ • Branch management │         │ • Complex queries  │
│ • Work item linking │         │ • Bulk operations  │
│ • Thread comments   │         │                    │
└─────────┬───────────┘         └─────────┬──────────┘
          │                               │
          └───────────────┬───────────────┘
                          │
            ┌─────────────▼─────────────┐
            │    Azure DevOps APIs      │
            │    (REST + Git)           │
            └───────────────────────────┘
```

### Integration Points

| Operation | Tool | Parameters |
|-----------|------|------------|
| Create PR | `mcp_ado_repo_create_pull_request` | repositoryId, sourceRefName, targetRefName, title, description |
| Update PR | `mcp_ado_repo_update_pull_request` | repositoryId, pullRequestId, status, mergeStrategy |
| List PR threads | `mcp_ado_repo_list_pull_request_threads` | repositoryId, pullRequestId |
| Reply to comment | `mcp_ado_repo_reply_to_comment` | repositoryId, pullRequestId, threadId, content |
| Link work item | `mcp_ado_wit_link_work_item_to_pull_request` | projectId, repositoryId, pullRequestId, workItemId |
| Create branch | `mcp_ado_repo_create_branch` | repositoryId, branchName, sourceBranchName |
| List branches | `mcp_ado_repo_list_branches_by_repo` | repositoryId, filterContains |

## Detailed Design

### 1. MCP Server Configuration

#### Installation

```powershell
# Install azure-devops-mcp globally
npm install -g @anthropic/azure-devops-mcp

# Or local to project
npm install @anthropic/azure-devops-mcp
```

#### MCP Configuration File

Create `~/.copilot/.mcp.json`:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "npx",
      "args": ["@anthropic/azure-devops-mcp"],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://dev.azure.com/your-org",
        "AZURE_DEVOPS_PAT": "${AZURE_DEVOPS_PAT}"
      }
    }
  }
}
```

#### Authentication Options

| Method | Environment Variable | Use Case |
|--------|---------------------|----------|
| PAT | `AZURE_DEVOPS_PAT` | Personal development, service accounts |
| Azure CLI | `AZURE_DEVOPS_EXT_PAT` from `az account get-access-token` | SSO environments |
| Managed Identity | Automatic | Azure-hosted agents |

Recommended: Use Azure CLI-based auth for work environments with SSO:

```powershell
# Login with Azure AD
az login

# Get token for ADO scope
$token = az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv
$env:AZURE_DEVOPS_PAT = $token
```

### 2. Skill Adaptations

Each skill that interacts with VCS needs adaptation. Below are the changes per skill:

#### 2.1 Synthesis Skill (PR Creation)

**Current (GitHub)**:
```bash
gh pr create --title "$TITLE" --body "$BODY" --base main
```

**New (ADO MCP)**:
```
Tool: mcp_ado_repo_create_pull_request
Parameters:
  repositoryId: <from project config>
  sourceRefName: refs/heads/feature/integration-{feature}
  targetRefName: refs/heads/main
  title: {computed title}
  description: {computed body}
```

**Post-PR Work Item Linking**:
```
Tool: mcp_ado_wit_link_work_item_to_pull_request
Parameters:
  projectId: <project>
  repositoryId: <repo>
  pullRequestId: <from create response>
  workItemId: <extracted from AB#1234 syntax>
```

#### 2.2 PR Feedback Skill (--pr-fixes)

**Current (GitHub)**:
```bash
gh api repos/{owner}/{repo}/pulls/{pr}/reviews
gh api repos/{owner}/{repo}/pulls/{pr}/comments
```

**New (ADO MCP)**:
```
Tool: mcp_ado_repo_list_pull_request_threads
Parameters:
  repositoryId: <repo>
  pullRequestId: <pr-id>

Returns: Array of threads with:
  - id: thread identifier
  - status: "active" | "resolved" | "won't fix" | ...
  - comments: array of {content, author, publishedDate}
  - threadContext: {filePath, rightFileStart, rightFileEnd} for inline comments
```

**Parsing Logic**:
```typescript
// Transform ADO threads to actionable feedback
interface PrFeedback {
  threadId: number;
  status: string;
  filePath: string | null;
  lineRange: { start: number; end: number } | null;
  comments: string[];
  priority: 'P1' | 'P2' | 'P3' | 'P4';
}

// Priority assignment:
// P1 (Critical): Threads marked as "active" with "security", "breaking" keywords
// P2 (Human): Threads from human reviewers (not bots)
// P3 (Major): Active threads with code suggestions
// P4 (Minor): All other active threads
```

#### 2.3 Branch Management

**Current**: Git commands only (branches created on push)

**New**: Explicit branch creation for better tracking:

```
Tool: mcp_ado_repo_create_branch
Parameters:
  repositoryId: <repo>
  branchName: feature/001-user-model
  sourceBranchName: main
```

This enables branch policies (if configured in ADO) to apply immediately.

### 3. State File Updates

Add ADO-specific fields to workflow state:

```json
{
  "version": "1.1",
  "featureId": "auth-system",
  "phase": "synthesize",
  "platform": "azure-devops",
  "ado": {
    "organization": "your-org",
    "project": "your-project",
    "repositoryId": "repo-guid-here"
  },
  "artifacts": {
    "design": "docs/designs/2026-01-06-auth.md",
    "plan": "docs/plans/2026-01-06-auth.md",
    "pr": null
  },
  "workItems": ["AB#1234", "AB#1235"],
  "tasks": [...],
  "synthesis": {
    "integrationBranch": "feature/integration-auth",
    "prId": null,
    "prUrl": null
  }
}
```

### 4. Agent Adaptations

#### 4.1 Orchestrator Agent

Update `orchestrator.agent.md` to:
- Reference ADO MCP tools instead of `gh` commands
- Handle ADO PR URLs (format: `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`)
- Parse AB# syntax for work item references

#### 4.2 Implementer Agent

No changes required. Implementer works with git worktrees and local files only.

#### 4.3 Reviewer Agent

Update to understand ADO thread structure when reviewing PR feedback.

#### 4.4 Integrator Agent

No changes required. Integration is git-based (merge, test).

### 5. Scripts Adaptation

#### 5.1 workflow-state.ps1

Add ADO initialization:

```powershell
function Initialize-AdoWorkflow {
    param(
        [string]$FeatureId,
        [string]$Organization,
        [string]$Project,
        [string]$RepositoryId
    )

    $state = @{
        version = "1.1"
        featureId = $FeatureId
        phase = "ideate"
        platform = "azure-devops"
        ado = @{
            organization = $Organization
            project = $Project
            repositoryId = $RepositoryId
        }
        # ... rest of state
    }

    $statePath = "docs/workflow-state/$FeatureId.state.json"
    $state | ConvertTo-Json -Depth 10 | Set-Content $statePath
    return $statePath
}
```

#### 5.2 New: ado-auth.ps1

Helper for authentication:

```powershell
# ~/.copilot/scripts/ado-auth.ps1

function Get-AdoToken {
    # Try PAT first
    if ($env:AZURE_DEVOPS_PAT) {
        return $env:AZURE_DEVOPS_PAT
    }

    # Fall back to Azure CLI
    $token = az account get-access-token `
        --resource 499b84ac-1321-427f-aa17-267ca6975798 `
        --query accessToken -o tsv

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to get ADO token. Run 'az login' first."
    }

    return $token
}

function Test-AdoConnection {
    param([string]$Organization)

    $token = Get-AdoToken
    # Test with a simple API call
    az devops project list --org "https://dev.azure.com/$Organization" --query "[0].name" -o tsv
    return $LASTEXITCODE -eq 0
}
```

### 6. Installation Script Updates

Update `install-copilot-workflow.ps1`:

```powershell
# Add ADO-specific setup
function Install-AdoMcp {
    Write-Host "Installing Azure DevOps MCP server..."
    npm install -g @anthropic/azure-devops-mcp

    # Create MCP config if not exists
    $mcpConfigPath = "$env:USERPROFILE\.copilot\.mcp.json"
    if (-not (Test-Path $mcpConfigPath)) {
        $mcpConfig = @{
            mcpServers = @{
                "azure-devops" = @{
                    command = "npx"
                    args = @("@anthropic/azure-devops-mcp")
                    env = @{
                        AZURE_DEVOPS_ORG_URL = "`${AZURE_DEVOPS_ORG_URL}"
                        AZURE_DEVOPS_PAT = "`${AZURE_DEVOPS_PAT}"
                    }
                }
            }
        }
        $mcpConfig | ConvertTo-Json -Depth 5 | Set-Content $mcpConfigPath
        Write-Host "Created MCP config at $mcpConfigPath"
    }
}

# Add to main install flow
Install-AdoMcp
```

### 7. CLI Fallback Documentation

For scenarios where MCP is unavailable or debugging is needed:

| MCP Tool | CLI Equivalent |
|----------|---------------|
| `mcp_ado_repo_create_pull_request` | `az repos pr create --title "..." --source-branch "..." --target-branch "..."` |
| `mcp_ado_repo_update_pull_request` | `az repos pr update --id <id> --status <status>` |
| `mcp_ado_repo_list_pull_request_threads` | `az repos pr show-thread --id <pr-id> --thread-id <id>` |
| `mcp_ado_wit_link_work_item_to_pull_request` | `az boards work-item relation add --id <wi-id> --relation-type "ArtifactLink" --target-url <pr-url>` |

## File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `copilot-cli/scripts/ado-auth.ps1` | ADO authentication helpers |
| `copilot-cli/.mcp.json` | MCP server configuration template |
| `copilot-cli/docs/ado-cli-reference.md` | CLI fallback documentation |

### Modified Files

| File | Changes |
|------|---------|
| `copilot-cli/agents/orchestrator.agent.md` | Add ADO MCP tool references |
| `copilot-cli/agents/reviewer.agent.md` | ADO thread structure parsing |
| `copilot-cli/scripts/workflow-state.ps1` | ADO state fields, init function |
| `copilot-cli/scripts/install-copilot-workflow.ps1` | MCP installation, ADO setup |
| `copilot-cli/skills/synthesis/SKILL.md` | ADO PR creation flow |
| `copilot-cli/skills/delegation/SKILL.md` | ADO branch creation |
| `copilot-cli/copilot-instructions.md` | ADO context, MCP tool list |

### Unchanged Files

| File | Reason |
|------|--------|
| `copilot-cli/agents/implementer.agent.md` | Git-only operations |
| `copilot-cli/agents/integrator.agent.md` | Git-only operations |
| `copilot-cli/skills/brainstorming/*` | Platform-agnostic |
| `copilot-cli/skills/implementation-planning/*` | Platform-agnostic |
| `copilot-cli/skills/spec-review/*` | Platform-agnostic |
| `copilot-cli/skills/quality-review/*` | Platform-agnostic |

## Testing Strategy

### Unit Tests

1. **State management**: Verify ADO fields are correctly initialized and updated
2. **Auth helpers**: Test token retrieval from PAT and Azure CLI
3. **PR feedback parsing**: Test ADO thread → actionable feedback transformation

### Integration Tests

1. **MCP connectivity**: Verify azure-devops-mcp connects to ADO org
2. **PR lifecycle**: Create PR → Add comment → Read threads → Complete PR
3. **Work item linking**: Link PR to work item, verify bidirectional reference

### End-to-End Tests

1. **Full workflow**: Run complete ideate → merge cycle on test repository
2. **Context compaction**: Verify state restoration after session restart
3. **Error recovery**: Test workflow continuation after MCP failures

## Migration Path

For users with existing `copilot-cli` installations:

### Step 1: Update Installation

```powershell
cd C:\repos\copilot-cli-workflow
git pull origin main
.\scripts\install-copilot-workflow.ps1 -Force
```

### Step 2: Configure ADO

```powershell
# Set environment variables
$env:AZURE_DEVOPS_ORG_URL = "https://dev.azure.com/your-org"
$env:AZURE_DEVOPS_PAT = "your-pat-here"  # Or use 'az login'

# Verify connection
~/.copilot/scripts/ado-auth.ps1 Test-AdoConnection -Organization "your-org"
```

### Step 3: Initialize Workflow with ADO

```powershell
~/.copilot/scripts/workflow-state.ps1 init my-feature -Platform azure-devops `
    -Organization "your-org" -Project "your-project" -RepositoryId "repo-id"
```

## Security Considerations

1. **PAT Scope**: Minimum required scopes for azure-devops-mcp:
   - `vso.code_write` (read/write code and PRs)
   - `vso.work_write` (link work items)

2. **Token Storage**: Never commit PATs. Use:
   - Environment variables (development)
   - Azure Key Vault (production)
   - Windows Credential Manager (local dev)

3. **MCP Security**: The azure-devops-mcp server runs locally; tokens are not transmitted to third parties.

## Rollout Plan

### Phase 1: Core Infrastructure
- MCP configuration and authentication
- State management updates
- Installation script updates

### Phase 2: Skill Adaptations
- Synthesis skill (PR creation)
- Delegation skill (branch creation)
- PR feedback parsing

### Phase 3: Agent Updates
- Orchestrator ADO tool references
- Reviewer thread parsing
- Documentation updates

### Phase 4: Testing & Polish
- Integration tests
- Error handling improvements
- CLI fallback documentation

## Appendix: ADO MCP Tool Reference

Complete list of tools available from azure-devops-mcp relevant to this workflow:

### Repository Operations
- `mcp_ado_repo_list_repos_by_project`
- `mcp_ado_repo_get_repo_by_name_or_id`
- `mcp_ado_repo_list_branches_by_repo`
- `mcp_ado_repo_create_branch`

### Pull Request Operations
- `mcp_ado_repo_create_pull_request`
- `mcp_ado_repo_update_pull_request`
- `mcp_ado_repo_get_pull_request_by_id`
- `mcp_ado_repo_list_pull_requests_by_repo_or_project`

### PR Comments & Threads
- `mcp_ado_repo_list_pull_request_threads`
- `mcp_ado_repo_list_pull_request_thread_comments`
- `mcp_ado_repo_create_pull_request_thread`
- `mcp_ado_repo_reply_to_comment`
- `mcp_ado_repo_update_pull_request_thread`

### Work Item Operations
- `mcp_ado_wit_link_work_item_to_pull_request`
- `mcp_ado_wit_add_artifact_link`
