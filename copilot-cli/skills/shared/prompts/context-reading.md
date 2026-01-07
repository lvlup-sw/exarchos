# Context Reading Instructions

## For Subagents

You are a subagent with isolated context. Read your own context from files rather than relying on information passed inline.

## Reading Task Details

If given a state file path, read task details:

```powershell
# Get your task
~/.copilot/scripts/workflow-state.ps1 get <state-file> '.tasks[] | select(.id == "<task-id>")'

# Get plan path
~/.copilot/scripts/workflow-state.ps1 get <state-file> '.artifacts.plan'
```

Then read the specific task section from the plan file.

## Reading for Review

If reviewing, read the diff instead of full files:

```powershell
# Get diff from main to feature branch
git diff main...feature/<branch-name>

# Or from integration branch
git diff main...feature/integration-<feature-name>
```

## Reading Design Context

If you need design context:

```powershell
# Get design path from state
~/.copilot/scripts/workflow-state.ps1 get <state-file> '.artifacts.design'

# Then read the design file
Get-Content <design-path>
```

## Best Practices

1. **Read on demand** - Only read files when you need the information
2. **Use diffs** - Prefer diffs over full file contents for reviews
3. **Extract sections** - Focus on the specific task section from plans
4. **Trust state file** - The state file is the source of truth for workflow state
