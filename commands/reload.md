# Reload Context

Manually trigger a context reload to recover from context degradation.

## Process

1. **Checkpoint current state** — Save workflow context to disk
2. **Clear session** — Type `/clear` to start fresh with pre-computed context

## Steps

### Step 1: Save Context Checkpoint

The PreCompact hook will fire, saving:
- Workflow checkpoint (phase, tasks, artifacts)
- Pre-assembled context document (structured Markdown summary)

This happens automatically when you type `/clear`.

### Step 2: Clear and Reload

Type `/clear` in the chat. The SessionStart hook will:
1. Detect the saved checkpoint
2. Inject the pre-computed context document
3. Resume with full workflow awareness

## When to Use

- Context feels degraded (agent forgets workflow state, repeats questions)
- After long sessions with many tool calls
- Before complex operations that need full context
- The auto-compact threshold (90%) will trigger this automatically, but you can manually trigger it anytime
