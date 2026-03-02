# Context Reading Instructions

## For Subagents

You are a subagent with isolated context. Read your own context from files rather than relying on information passed inline.

## Reading Task Details

If given a state file path, read task details using MCP tools:

**Get your task:**

```
action: "get", featureId: "<feature-id>", query: ".tasks[] | select(.id == \"<task-id>\")"
```

**Get plan path:**

```
action: "get", featureId: "<feature-id>", query: ".artifacts.plan"
```

Then read the specific task section:

```typescript
exarchos_orchestrate({
  action: "run_script",
  script: "extract-task.sh",
  args: ["<plan-path>", "<task-id>"]
})
```

## Reading for Review

If reviewing, read the diff instead of full files:

```typescript
exarchos_orchestrate({
  action: "run_script",
  script: "review-diff.sh",
  args: ["<worktree-path>", "main"]
})
```

## Reading Design Context

If you need design context:

**Get design path from state:**

```
action: "get", featureId: "<feature-id>", query: ".artifacts.design"
```

Then read the design file:

```bash
Read({ file_path: "<design-path>" })
```

## Best Practices

1. **Read on demand** - Only read files when you need the information
2. **Use diffs** - Prefer diffs over full file contents for reviews
3. **Extract sections** - Use extract-task.sh for single task context
4. **Trust state file** - The state file is the source of truth for workflow state
