# Copilot CLI Workflow Orchestration

Terminal-based agentic workflow orchestration for GitHub Copilot CLI on Windows. Enforces TDD methodology with automated phase chaining and persistent state management.

## Quick Start

```powershell
# Clone and install
git clone <repo-url> C:\repos\copilot-cli-workflow
cd C:\repos\copilot-cli-workflow
.\scripts\install-copilot-workflow.ps1
```

Done. Agents and scripts installed to `~/.copilot/`.

## The Workflow

```
/ideate → [CONFIRM] → /plan → /delegate → /integrate → /review → /synthesize → [CONFIRM] → merge
            ↑           (auto)   (auto)      (auto)      (auto)     (auto)           ↑
          HUMAN                                                                    HUMAN
```

**Two human checkpoints.** Everything else auto-continues.

| Phase | Purpose | Trigger |
|-------|---------|---------|
| ideate | Design exploration with trade-offs | `/ideate` or "let's brainstorm" |
| plan | TDD task decomposition | Auto after design confirmation |
| delegate | Dispatch to implementer agents | Auto after plan saved |
| integrate | Merge worktree branches, run tests | Auto after all tasks complete |
| review | Two-stage: spec compliance → code quality | Auto after integration passes |
| synthesize | Create PR from integration branch | Auto after reviews pass |

### Auto-Chaining

| When | Then |
|------|------|
| Plan saved | → delegate |
| All tasks complete | → integrate |
| Integration passes | → review |
| Integration fails | → delegate --fixes |
| Reviews pass | → synthesize |
| Reviews fail | → delegate --fixes |

### Human Checkpoints

Only pause for human input at:

1. **Design confirmation** (after ideate) - User must approve design before planning
2. **Merge confirmation** (after synthesize) - User must approve PR merge

## Prerequisites

| Requirement | Install Command |
|-------------|-----------------|
| Windows | - |
| PowerShell 5.1+ | Built-in on Windows 10+ |
| jq | `winget install jqlang.jq` |
| git | `winget install Git.Git` |
| GitHub CLI | `winget install GitHub.cli` |
| GitHub Copilot CLI | `gh extension install github/gh-copilot` |

## Installation

### Standard Install

```powershell
.\scripts\install-copilot-workflow.ps1
```

### Options

```powershell
# Install from specific path
.\scripts\install-copilot-workflow.ps1 -SourceRepo "C:\repos\copilot-cli-workflow"

# Overwrite existing files
.\scripts\install-copilot-workflow.ps1 -Force

# Skip validation checks
.\scripts\install-copilot-workflow.ps1 -SkipValidation
```

### Installed Structure

```
~/.copilot/
├── scripts/
│   └── workflow-state.ps1      # State management
├── agents/
│   ├── orchestrator.agent.md   # Workflow coordinator
│   ├── implementer.agent.md    # TDD implementation
│   ├── reviewer.agent.md       # Code review
│   └── integrator.agent.md     # Branch integration
└── config.json                 # Installation metadata
```

## TDD Iron Law

Every implementation task follows Red-Green-Refactor:

1. **RED**: Write failing test first
2. **GREEN**: Minimum code to pass
3. **REFACTOR**: Clean up, tests stay green

**No production code without a failing test first.**

### Test Naming Convention

```
MethodName_Scenario_ExpectedOutcome
```

Examples:
- `Add_PositiveNumbers_ReturnsSum`
- `Validate_NullInput_ThrowsArgumentException`
- `Process_EmptyList_ReturnsEmptyResult`

## State Management

Workflows persist across sessions via state files in `docs/workflow-state/`.

### Commands

```powershell
# Initialize a new workflow
~/.copilot/scripts/workflow-state.ps1 init my-feature

# List active workflows
~/.copilot/scripts/workflow-state.ps1 list

# Get state field
~/.copilot/scripts/workflow-state.ps1 get my-feature.state.json '.phase'

# Update state
~/.copilot/scripts/workflow-state.ps1 set my-feature.state.json '.phase = "delegate"'

# Get context summary (for session restoration)
~/.copilot/scripts/workflow-state.ps1 summary my-feature.state.json

# Determine next auto-action
~/.copilot/scripts/workflow-state.ps1 next-action my-feature.state.json

# Reconcile state with git reality
~/.copilot/scripts/workflow-state.ps1 reconcile my-feature.state.json
```

### State File Structure

```json
{
  "version": "1.0",
  "featureId": "my-feature",
  "phase": "delegate",
  "artifacts": {
    "design": "docs/designs/2024-01-15-my-feature.md",
    "plan": "docs/plans/2024-01-15-my-feature.md",
    "pr": null
  },
  "tasks": [
    {
      "id": "001",
      "title": "Add types",
      "status": "complete",
      "branch": "feature/001-types"
    }
  ],
  "worktrees": {},
  "synthesis": {
    "integrationBranch": "feature/integration-my-feature",
    "prUrl": null
  }
}
```

## Agents

### Orchestrator

Workflow coordinator. Dispatches tasks, manages state, chains phases.

**Does NOT write code.** All implementation via subagents.

| Action | Allowed |
|--------|---------|
| Parse plans | Yes |
| Dispatch agents | Yes |
| Update state | Yes |
| Chain phases | Yes |
| Write code | No |
| Fix issues directly | No |

### Implementer

TDD implementation in isolated worktrees.

| Responsibility | Details |
|----------------|---------|
| Create worktree | `git worktree add .worktrees/<task-id>` |
| Write failing test | RED phase |
| Implement minimum code | GREEN phase |
| Refactor | Keep tests green |
| Commit | Atomic commits per task |

### Reviewer

Two-stage code review.

| Stage | Focus |
|-------|-------|
| Spec Review | Does code match plan requirements? |
| Quality Review | SOLID principles, patterns, security |

### Integrator

Branch merging and combined testing.

| Step | Action |
|------|--------|
| Create integration branch | `feature/integration-<feature>` |
| Merge task branches | In dependency order |
| Run combined tests | Full test suite |
| Report conflicts | If merge fails |

## Skills

| Skill | Purpose | Location |
|-------|---------|----------|
| brainstorming | Design exploration, trade-off analysis | `/ideate` |
| implementation-planning | TDD task decomposition from design | `/plan` |
| delegation | Task dispatch to implementer agents | `/delegate` |
| integration | Branch merging, combined testing | `/integrate` |
| spec-review | Verify implementation matches plan | Review stage 1 |
| quality-review | SOLID, patterns, security review | Review stage 2 |
| synthesis | PR creation from integration branch | `/synthesize` |

## Coding Standards

### SOLID Constraints

| Principle | Constraint |
|-----------|------------|
| **S**RP | One public type per file. File name matches type. |
| **O**CP | No switch on types/enums. Use polymorphism. |
| **L**SP | Subclasses must not throw NotImplementedException. |
| **I**SP | Small, role-specific interfaces. |
| **D**IP | All dependencies via constructor injection. |

### Control Flow

- **Guard clauses first**: Validate at method entry
- **Early return**: Exit when result is known
- **No arrow code**: Avoid deep nesting

```csharp
// Preferred
public void Process(Input input)
{
    if (input == null) return;
    if (!input.IsValid) throw new ArgumentException();

    // Main logic flat
}

// Avoid
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

## Repository Structure

```
copilot-cli/
├── README.md                   # This file
├── copilot-instructions.md     # Consolidated rules for Copilot
├── scripts/
│   ├── install-copilot-workflow.ps1  # Installation script
│   └── workflow-state.ps1            # State management
├── agents/
│   ├── orchestrator.agent.md   # Workflow coordinator
│   ├── implementer.agent.md    # TDD implementer
│   ├── reviewer.agent.md       # Code reviewer
│   └── integrator.agent.md     # Branch integrator
└── skills/
    ├── brainstorming/          # Design exploration
    ├── implementation-planning/ # TDD task planning
    ├── delegation/             # Task dispatch
    ├── integration/            # Branch merging
    ├── spec-review/            # Spec compliance review
    ├── quality-review/         # Code quality review
    └── synthesis/              # PR creation
```

## Example Session

```powershell
# Start new feature
> let's brainstorm a user authentication system

[Orchestrator initializes state]
[Brainstorming skill activates]
[Design exploration: 3 options presented]
[User selects approach]
[Design saved to docs/designs/]

# HUMAN CHECKPOINT: Design confirmation
> yes, proceed with the JWT approach

[Plan skill auto-activates]
[TDD tasks created in docs/plans/]
[Delegation auto-chains]
[3 implementer agents dispatched to worktrees]
[Tasks complete]
[Integration auto-chains]
[Branches merged to feature/integration-auth]
[Tests pass]
[Review auto-chains]
[Spec review: PASS]
[Quality review: APPROVED]
[Synthesis auto-chains]
[PR created]

# HUMAN CHECKPOINT: Merge confirmation
> merge the PR

[PR merged]
[Worktrees cleaned up]
[State marked complete]
```

## Troubleshooting

### Installation Issues

**jq not found:**
```powershell
winget install jqlang.jq
# Or: choco install jq
```

**PowerShell version too old:**
```powershell
$PSVersionTable.PSVersion  # Check version
# Upgrade via Windows Update or install PowerShell 7
```

### State Issues

**State file not found:**
```powershell
# List all state files
Get-ChildItem docs/workflow-state/*.state.json

# Initialize if missing
~/.copilot/scripts/workflow-state.ps1 init <feature-id>
```

**State out of sync with git:**
```powershell
~/.copilot/scripts/workflow-state.ps1 reconcile <state-file>
```

### Workflow Issues

**Stuck in phase:**
```powershell
# Check current state
~/.copilot/scripts/workflow-state.ps1 summary <state-file>

# Check what action is expected
~/.copilot/scripts/workflow-state.ps1 next-action <state-file>
```

**Worktree conflicts:**
```powershell
# List worktrees
git worktree list

# Remove stale worktree
git worktree remove .worktrees/<task-id>
git worktree prune
```

## License

Apache License 2.0
