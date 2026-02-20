---
name: synthesis
description: "Create pull request from completed feature branch using Graphite stacked PRs. Use when the user says 'create PR', 'submit for review', 'synthesize', or runs /synthesize. Validates branch readiness, creates PR with structured description, and manages merge queue. Do NOT use before review phase completes. Not for draft PRs."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: synthesize
---

# Synthesis Skill

## Overview

Submit Graphite stack as pull requests after review phase completes.

**Prerequisites:**
- All delegated tasks complete
- All reviews (spec + quality) passed — integration must be complete and passing
- Graphite stack exists with task branches (the integration branch already exists from delegation)

Requires BOTH spec-review PASS AND quality-review APPROVED. If either review is incomplete or failed, do NOT proceed — return to /exarchos:review.

## Triggers

Activate this skill when:
- User runs `/synthesize` command
- All reviews have passed successfully
- Ready to submit PRs

## Simplified Process (Review Already Complete)

Since delegation creates Graphite stack branches and review validates them, synthesis focuses on:
1. Verifying the stack is ready
2. Submitting the stacked PRs
3. Handling PR feedback (if any)
4. Cleanup after merge

## Synthesis Process

1. **Verify readiness** -- `scripts/pre-synthesis-check.sh` (includes phase readiness check with transition guidance)
2. **REQUIRED: Verify/reconstruct Graphite stack** -- Run `scripts/reconstruct-stack.sh` before PR creation. If exit 1: stop and report error.
3. **Quick test verification** -- `npm run test:run && npm run typecheck`
4. **Check CodeRabbit reviews** -- `scripts/check-coderabbit.sh`
5. **Write PR descriptions** -- Follow `references/pr-descriptions.md` for title format and body structure
6. **Submit to merge queue** -- `gt submit --no-interactive --publish --merge-when-ready`
7. **Cleanup after merge** -- `gt sync` + remove worktrees

For detailed step instructions, see `references/synthesis-steps.md`.

## Handling Failures

See `references/troubleshooting.md` for test failures, PR check failures, and merge queue rejections.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Skip review phase | Always run `/exarchos:review` first |
| Force push stack branches | Use normal push |
| Delete worktrees before PR approval | Wait for merge confirmation |
| Create PR with failing tests | Ensure review phase passes first |

## State Management

Call `mcp__exarchos__exarchos_workflow` for all state operations. Full parameter reference: `@skills/workflow-state/SKILL.md` § Update State.

### Read Task State

```
action: "get", featureId: "<id>", fields: ["tasks", "synthesis"]
```

### On PR Created

```
action: "set", featureId: "<id>", updates: {
  "artifacts": { "pr": ["<url1>", "<url2>"] },
  "synthesis": { "mergeOrder": ["<branch1>", ...], "prUrl": ["<url1>", ...], "prFeedback": [] }
}
```

### On PR Feedback Received

```
action: "set", featureId: "<id>", updates: {
  "synthesis": { "prFeedback": [{ "pr": "<url>", "reviewer": "<name>", "status": "<status>" }] }
}
```

### On Merge Complete

```
action: "cleanup", featureId: "<id>", mergeVerified: true, prUrl: ["<url>", ...], mergedBranches: ["<branch>", ...]
```

## Completion Criteria

- [ ] Graphite stack verified via reconstruct-stack.sh
- [ ] Quick test verification passed
- [ ] CodeRabbit reviews checked (no CHANGES_REQUESTED blocking)
- [ ] PRs enqueued via `--merge-when-ready`
- [ ] PR links provided to user
- [ ] State file updated with PR URLs

## Handling PR Feedback

Route to `/exarchos:delegate --pr-fixes [PR_URL]` for automated fix dispatch. See `references/troubleshooting.md` for details.

## Transition

After stacked PRs enqueued in merge queue, this is a **human checkpoint**:

1. Update state: `action: "set", featureId: "<id>", updates: { "synthesis": { "prUrl": ["<urls>"] }, "artifacts": { "pr": ["<urls>"] } }`
2. Output: "Stacked PRs enqueued: [URLs]. Waiting for CI/merge queue."
3. **PAUSE for user input**: "Merge stack? (yes/no/feedback)"

This is one of only TWO human checkpoints in the workflow.

Options:
- **'yes'**: Merge PR, update state to "completed"
- **'feedback'**: Auto-continue to `/exarchos:delegate --pr-fixes` to address comments, then return here
- **'no'**: Pause workflow, can resume later with `/exarchos:resume`

## Troubleshooting

See `references/troubleshooting.md` for MCP failures, state desync, PR creation issues, and stack rebase conflicts.
