# Design: Context Exhaustion Mitigation for Workflow

## Problem Statement

Running the full workflow (`/ideate` → `/plan` → `/delegate` → `/integrate` → `/review` → `/synthesize`) exhausts context in the main Claude Code terminal. Context runs out during:
1. `/delegate` - task extraction, worktree setup, subagent dispatch
2. PR feedback iterations after `/synthesize`

Auto-summarization loses: task specifics, file locations, worktree state.

## Chosen Approach: Combined Three-Strategy Solution

Based on brainstorming, we selected a comprehensive approach combining:
1. **State Persistence** - JSON state files survive auto-summarization
2. **Context Reduction** - Diffs and reference-based prompts reduce overhead
3. **Workflow Segmentation** - Natural break points for fresh sessions

## Technical Design

### State File Structure

Location: `docs/workflow-state/<feature-id>.state.json`

```json
{
  "version": "1.0",
  "featureId": "user-authentication",
  "phase": "delegate",
  "artifacts": {
    "design": "docs/designs/2026-01-05-user-auth.md",
    "plan": "docs/plans/2026-01-05-user-auth.md",
    "pr": null
  },
  "tasks": [...],
  "worktrees": {...},
  "synthesis": {...}
}
```

### New Commands

- `/checkpoint` - Save current state, prepare for session handoff
- `/resume <state-file>` - Restore context from state file

### Scripts

- `~/.claude/scripts/workflow-state.sh` - State read/write/reconcile operations
- `~/.claude/scripts/review-diff.sh` - Generate context-efficient diffs
- `~/.claude/scripts/extract-task.sh` - Extract single task from plan

## Integration Points

Each workflow skill updates state at key moments:
- `/ideate` → Creates state file
- `/plan` → Populates tasks array
- `/delegate` → Updates task status, worktree locations
- `/integrate` → Updates integration status, merged branches
- `/review` → Updates review results
- `/synthesize` → Stores PR URL, feedback

## Testing Strategy

1. Run workflow on a small feature (2-3 tasks)
2. Verify state file is created and updated
3. Simulate context loss by starting new session
4. Use `/resume` to restore context
5. Verify workflow can continue from checkpoint

## Expected Outcomes

- State survives auto-summarization
- 70-90% reduction in context per operation
- Clean session boundaries with `/checkpoint` and `/resume`
- Graceful degradation when context runs low
