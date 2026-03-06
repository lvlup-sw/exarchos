---
description: Shepherd PRs through CI and reviews to merge readiness
---

# Shepherd

Shepherd PRs for: "$ARGUMENTS"

## Workflow Position

```
/exarchos:synthesize → /exarchos:shepherd (assess → fix → resubmit → loop) → /exarchos:cleanup
                        ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
```

This command operates as an **iteration loop within the synthesize phase**. The workflow phase remains `synthesize` throughout.

## Skill Reference

Follow the shepherd skill: `@skills/shepherd/SKILL.md`

## Prerequisites

- [ ] Active workflow with PRs published
- [ ] PRs created via `gh pr create` (artifacts.pr exists in state)
- [ ] GitHub MCP tools available or `gh` CLI authenticated

## Process

### Step 0: Surface Quality Signals
```
exarchos_view({ action: "code_quality", workflowId: "<featureId>" })
```

### Step 1: Assess Stack
```
exarchos_orchestrate({ action: "assess_stack", featureId: "<id>", prNumbers: [N] })
```

Act on the `recommendation`:
- `fix-and-resubmit` — Fix issues, push, re-assess
- `request-approval` — Request review, report to user
- `wait` — Inform user, pause
- `escalate` — Consult escalation criteria

### Step 2: Fix Issues

Address each `actionItem` from the assessment:
- `ci-fix` — Read logs, reproduce, fix, commit
- `comment-reply` — Read context, compose response, post reply
- `review-address` — Fix code, reply to each thread
- `restack` — Rebase on base branch

### Step 3: Resubmit
```bash
git push --force-with-lease
gh pr merge <number> --auto --squash
```

Return to Step 1. Max 5 iterations.

### Step 4: Request Approval

When all checks green and comments addressed:
1. Request review via GitHub MCP or `gh pr edit --add-reviewer`
2. Report status to user
3. Instruct: Run `/exarchos:cleanup` after merge completes

## State Management

Track shepherd progress in workflow state:
```
exarchos_workflow({ action: "set", featureId: "<id>", updates: {
  shepherd: { startedAt, currentIteration, maxIterations: 5, approvalRequested }
}})
```

## Event Emission

Emit `shepherd.started`, `shepherd.iteration`, `remediation.attempted`/`remediation.succeeded`, and `shepherd.completed` events via `exarchos_event`.

## Auto-Chain

After approval requested:
1. Output: "All CI checks pass. Approval requested."
2. **PAUSE for user input** — this is within the synthesize human checkpoint
3. Run `/exarchos:cleanup` after merge completes
