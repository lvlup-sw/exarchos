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

## Idempotency

Before shepherding, check shepherd status:
1. Read `shepherd.currentIteration` from state — resume from last iteration
2. If `shepherd.approvalRequested` is true, skip to approval wait
3. If workflow phase is `completed`, no action needed

## Process

### Step 0: Surface Quality Signals

```typescript
mcp__plugin_exarchos_exarchos__exarchos_view({ action: "code_quality", workflowId: "<featureId>" })
```

Check for regressions and degrading gate pass rates before assessing PRs.

### Step 1: Assess Stack

```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "assess_stack",
  featureId: "<featureId>",
  prNumbers: [123]
})
```

Act on the `recommendation`:
- `fix-and-resubmit` — Proceed to Step 2
- `request-approval` — Skip to Step 4
- `wait` — Inform user, pause, re-assess after delay
- `escalate` — Report to user with escalation context

### Step 2: Fix Issues

Address each `actionItem` from the assessment:
- `ci-fix` — Read CI logs, reproduce locally, fix, commit
- `comment-reply` — Read context, compose response, post via GitHub MCP
- `review-address` — Fix code for CHANGES_REQUESTED, reply to each thread
- `restack` — `git rebase origin/<base>`, verify with `gh pr list`

### Step 3: Resubmit

```bash
git push --force-with-lease
gh pr merge <number> --auto --squash
```

Return to Step 1. Max 5 iterations — escalate if limit reached.

### Step 4: Request Approval

When all checks green and comments addressed:

1. Request review via GitHub MCP or `gh pr edit <number> --add-reviewer <approver>`
2. Update state:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_workflow({
  action: "set",
  featureId: "<featureId>",
  updates: { "shepherd": { "approvalRequested": true } }
})
```

## State Management

Initialize shepherd tracking on first run:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_workflow({
  action: "set",
  featureId: "<featureId>",
  updates: {
    "shepherd": {
      "startedAt": "<ISO8601>",
      "currentIteration": 0,
      "maxIterations": 5,
      "approvalRequested": false
    }
  }
})
```

Update `currentIteration` after each assess cycle.

## Output

When approval requested:
```markdown
## Ready for Approval

All CI checks pass. All review comments addressed.
Approval requested from: <approvers>

PRs:
- #123: <url>

Run `/exarchos:cleanup` after merge completes.
```

## Error Handling

- **CI keeps failing after fixes:** Escalate to user after 5 iterations with failure context
- **Workflow not found:** "No active workflow found. Run `/exarchos:rehydrate` to restore state."
- **No PRs in state:** "No PRs found in artifacts. Run `/exarchos:synthesize` first."

## Auto-Chain

After approval requested:
1. Output: "All CI checks pass. Approval requested."
2. **PAUSE for user input** — this is within the synthesize human checkpoint
3. On merge confirmed → Run `/exarchos:cleanup`
