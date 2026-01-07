# Copilot Instructions

Consolidated workflow and coding rules for GitHub Copilot CLI.

## Orchestrator Constraints

The orchestrator (main Copilot session) MUST NOT:

1. **Write implementation code** - All code changes via subagents
2. **Fix review findings directly** - Dispatch fixer subagents
3. **Run integration tests inline** - Dispatch integration subagent
4. **Work in main project root** - All implementation in worktrees

The orchestrator SHOULD:

1. **Parse and extract** - Read plans, extract task details
2. **Dispatch and monitor** - Launch subagents, track progress
3. **Manage state** - Update workflow state file
4. **Chain phases** - Invoke next phase when current completes
5. **Handle failures** - Route failures back to appropriate phase

When tempted to write code directly, ask:
1. Can this be delegated to a subagent?
2. Is this a coordination task or implementation task?
3. Will this consume significant context?

If in doubt, delegate.

## TDD Requirements

### The Iron Law

> NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST

### TDD Workflow

1. **RED**: Write a failing test
   - Run tests, verify failure
   - Failure must be for the RIGHT reason

2. **GREEN**: Write minimum code to pass
   - Only what the test requires
   - No extra features

3. **REFACTOR**: Clean up (if needed)
   - Tests must stay green
   - Apply SOLID principles

### Test Naming Convention

```plaintext
MethodName_Scenario_ExpectedOutcome
```

Examples:
- `Add_PositiveNumbers_ReturnsSum`
- `Validate_NullInput_ThrowsArgumentException`
- `Process_EmptyList_ReturnsEmptyResult`

## Coding Standards

### SOLID Constraints

| Principle | Constraint |
|-----------|------------|
| **S**RP | One public type per file. File name must match type name. |
| **O**CP | No `switch` on types/enums for logic. Use polymorphism. |
| **L**SP | Subclasses must not throw `NotImplementedException`. |
| **I**SP | Small role-specific interfaces. |
| **D**IP | All dependencies via constructor injection. |

### Control Flow

- **Guard clauses first**: Validate preconditions at method entry
- **Early return**: Exit as soon as result is known
- **No arrow code**: Avoid deeply nested if/else structures

```csharp
// Preferred: Guard clause
public void Process(Input input)
{
    if (input == null) return;
    if (!input.IsValid) throw new ArgumentException();

    // Main logic flat
}

// Avoid: Arrow code
public void Process(Input input)
{
    if (input != null)
    {
        if (input.IsValid)
        {
            // Deeply nested
        }
    }
}
```

### Code Organization

- Extract duplicated logic into private helpers
- Use built-in library methods (LINQ, String methods, etc.)
- Do not re-implement standard library functionality
- `sealed` by default for classes

## PR Description Guidelines

### Title Format

`<type>: <what>` (max 72 chars)

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

### Body Structure

```markdown
## Summary

[2-3 sentences: What changed, why it matters]

## Changes

- **Component 1** - Brief description
- **Component 2** - Brief description

## Test Plan

[Testing approach and coverage summary]

---

**Results:** Tests X passed - Build 0 errors
**Design:** [design-doc.md](docs/path/design-doc.md)
**Related:** #123, Continues #456
```

### Avoid

- Bullet lists of every file changed
- Repeating commit messages in the body
- Low-level implementation details
- Phase-by-phase breakdowns

## Workflow Phases

1. **ideate** - Design exploration (human checkpoint)
2. **plan** - Create TDD implementation plan
3. **delegate** - Dispatch implementer agents
4. **integrate** - Merge branches and run tests
5. **review** - Two-stage code review
6. **synthesize** - Create pull request (human checkpoint)

### Auto-Chaining

- plan complete -> auto-chain to delegate
- delegate complete -> auto-chain to integrate
- integrate passed -> auto-chain to review
- integrate failed -> auto-chain to delegate --fixes
- review passed -> auto-chain to synthesize
- review failed -> auto-chain to delegate --fixes

### Human Checkpoints

Only pause for human input at:
- **ideate**: Design confirmation required
- **synthesize**: Merge confirmation required

## State Management

Use workflow-state.ps1 for state operations:

```powershell
# Initialize workflow
~/.copilot/scripts/workflow-state.ps1 init <feature-id>

# Update state
~/.copilot/scripts/workflow-state.ps1 set <state-file> '.phase = "delegate"'

# Read state
~/.copilot/scripts/workflow-state.ps1 get <state-file> '.tasks'

# List active workflows
~/.copilot/scripts/workflow-state.ps1 list

# Get next action
~/.copilot/scripts/workflow-state.ps1 next-action <state-file>
```

## Azure DevOps Integration

This workflow supports Azure DevOps as an alternative to GitHub for version control and pull requests.

### Platform Detection

Check workflow state for platform:
```powershell
$platform = ~/.copilot/scripts/workflow-state.ps1 get <state-file> '.platform'
# Returns: "github" or "azure-devops"
```

Use platform-appropriate tools:
- **GitHub**: `gh` CLI commands
- **Azure DevOps**: MCP tools (`mcp_ado_*`)

### ADO State Initialization

Initialize an ADO workflow with organization details:
```powershell
~/.copilot/scripts/workflow-state.ps1 init-ado my-feature `
  -Organization "my-org" `
  -Project "my-project" `
  -RepositoryId "repo-guid"
```

This creates a v1.1 state file with:
- `platform: "azure-devops"`
- `ado.organization`, `ado.project`, `ado.repositoryId`

### Available MCP Tools

When working with ADO workflows, these MCP tools are available:

| Tool | Purpose |
|------|---------|
| `mcp_ado_repo_create_pull_request` | Create PR |
| `mcp_ado_repo_update_pull_request` | Update PR status |
| `mcp_ado_repo_list_pull_request_threads` | Get review comments |
| `mcp_ado_repo_reply_to_comment` | Reply to reviewers |
| `mcp_ado_wit_link_work_item_to_pull_request` | Link AB# items |
| `mcp_ado_repo_create_branch` | Create branch (optional) |

### Work Item References

ADO work items use AB# syntax:
- `AB#1234` in commit messages or PR descriptions
- Automatically linked when detected

### CLI Fallback

If MCP tools are unavailable, use `az devops` CLI:
```powershell
# Example: Create PR via CLI
az repos pr create --title "..." --source-branch "..." --target-branch "main"
```

See `docs/ado-cli-reference.md` for full CLI reference.

## rm Safety

When using `rm` commands:

### NEVER Execute
- `rm -rf /` or `rm -rf /*`
- `rm -rf ~` or `rm -rf ~/*`
- Any rm with unset variables

### Always
- Use specific paths
- List before deleting (`ls` first)
- Avoid `-f` flag unless necessary
- Double-check recursion targets
