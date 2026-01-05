# Context Reading Instructions

## For Subagents

You are a subagent with isolated context. Read your own context from files rather than relying on information passed inline.

## Reading Task Details

If given a state file path, read task details:

```bash
# Get your task
~/.claude/scripts/workflow-state.sh get <state-file> '.tasks[] | select(.id == "<task-id>")'

# Get plan path
~/.claude/scripts/workflow-state.sh get <state-file> '.artifacts.plan'
```

Then read the specific task section:

```bash
~/.claude/scripts/extract-task.sh <plan-path> <task-id>
```

## Reading for Review

If reviewing, read the diff instead of full files:

```bash
~/.claude/scripts/review-diff.sh <worktree-path> main
```

## Reading Design Context

If you need design context:

```bash
# Get design path from state
~/.claude/scripts/workflow-state.sh get <state-file> '.artifacts.design'

# Then read the design file
cat <design-path>
```

## Best Practices

1. **Read on demand** - Only read files when you need the information
2. **Use diffs** - Prefer diffs over full file contents for reviews
3. **Extract sections** - Use extract-task.sh for single task context
4. **Trust state file** - The state file is the source of truth for workflow state
