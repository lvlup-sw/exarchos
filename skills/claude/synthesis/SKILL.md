---
name: synthesis
description: "Create pull request from completed feature branch using GitHub-native stacked PRs. Use when the user says 'create PR', 'submit for review', 'synthesize', or runs /synthesize. Validates branch readiness, creates PR with structured description, and manages merge queue. Do NOT use before review phase completes. Not for draft PRs."
metadata:
  author: exarchos
  version: 2.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: synthesize
---

# Synthesis Skill

## VCS Provider

This skill uses VCS operations through Exarchos MCP actions (`create_pr`, `merge_pr`, `list_prs`, `check_ci`, etc.).
These actions automatically detect and route to the correct VCS provider (GitHub, GitLab, Azure DevOps).
No `gh`/`glab`/`az` commands needed — the MCP server handles provider dispatch.

## Overview

Submit stacked PRs after review phase completes. The `prepare_synthesis` composite action consolidates readiness checks, stack verification, test validation, and quality signal analysis into a single call -- eliminating the multi-script coordination that historically caused synthesis failures.

**Prerequisites:**
- All delegated tasks complete with reviews passed (spec + quality)
- The integration branch already exists from delegation phase
- Task branches present and pushed to remote

Do NOT proceed if either review is incomplete or failed -- return to `/exarchos:review` first.

**Entry points:** Synthesis is normally reached from the `review` phase of
feature / debug / refactor workflows. It is also reachable from `oneshot`
workflows via the opt-in path — when a user signals "let's open a PR for
this" during `plan` or `implementing`, the `request_synthesize` event is
appended, and `finalize_oneshot` then resolves the choice state and
transitions the workflow to `synthesize`. See
`@skills/oneshot-workflow/SKILL.md` for the opt-in mechanics and
`synthesisPolicy` semantics.

## Triggers

Activate this skill when:
- User runs `/exarchos:synthesize` command
- All reviews have passed successfully
- Ready to submit PRs
- Oneshot workflow resolved to `synthesize` via `finalize_oneshot`

## Process

> **Runbook:** Follow the synthesis-flow runbook:
> `exarchos_orchestrate({ action: "runbook", id: "synthesis-flow" })`
> If runbook unavailable, use `describe` to retrieve action schemas: `exarchos_orchestrate({ action: "describe", actions: ["prepare_synthesis"] })`

### Step 1: Verify Readiness

Call the `prepare_synthesis` composite action to validate all preconditions in a single operation:

```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "prepare_synthesis",
  featureId: "<id>"
})
```

This action performs:
- **Phase readiness** -- Confirms workflow is in the correct phase with all reviews complete
- **Stack integrity** -- Detects diverged branches, missing task branches, or broken parent chains and reconstructs automatically
- **Test verification** -- Runs `npm run test:run && npm run typecheck` from the stack top
- **Benchmark regression** -- If `state.verification.hasBenchmarks` is true, checks for performance regressions
- **Quality signals** -- Queries `code_quality` view for regressions and actionable hints
- **Gate events** -- Auto-emits `gate.executed` events for each check (tests, benchmarks, CodeRabbit)

For the full breakdown of individual checks the composite action performs, see `references/synthesis-steps.md`.

**On success:** All checks passed. The response includes a readiness summary with any quality hints to present to the user. Proceed to Step 2.

**On failure:** The response identifies which check failed and provides remediation guidance. Follow the guidance -- typically returning to `/exarchos:review` or `/exarchos:delegate`.

If any quality hint has `confidenceLevel: 'actionable'`, present the `suggestedAction` to the user before proceeding.

### Step 2: Write and Validate PR Descriptions

For each PR in the stack, write a structured description following `references/pr-descriptions.md`. Required sections: **Summary**, **Changes**, **Test Plan**, plus a footer. Projects can override required sections via `.exarchos/pr-template.md`.

**Title format:** `<type>: <what>` (max 72 chars)

Write the PR body to a temp file:
```bash
cat > /tmp/pr-body.md <<'EOF'
## Summary
[2-3 sentences: what changed, why it matters]

## Changes
- **Component** -- Description of change

## Test Plan
[Testing approach and coverage]

---
**Results:** Tests X pass · Build 0 errors
**Design:** [doc](path)
**Related:** #issue
EOF
```

Validate **before** creating the PR:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "validate_pr_body",
  bodyFile: "/tmp/pr-body.md"
})
```

**Do NOT call `create_pr` until validation passes.** If validation fails, fix the body and re-validate.

### Step 3: Submit and Merge

Create PRs using the validated body and enable auto-merge. For each branch in the stack (bottom-up):

```typescript
// Create PR via VCS MCP action
exarchos_orchestrate({
  action: "create_pr",
  base: "<parent-branch>",
  head: "<branch>",
  title: "<type>: <what>",
  body: "<pr-body>"
})

// Enable auto-merge
exarchos_orchestrate({
  action: "merge_pr",
  prId: "<number>",
  strategy: "squash"
})
```

After submission:
1. **Apply benchmark label** -- If `verification.hasBenchmarks` is true, apply label: `gh pr edit <number> --add-label has-benchmarks`
2. **Record PR URLs** -- Capture URLs via `exarchos_orchestrate({ action: "list_prs", state: "open" })`
3. **Update state:**

```typescript
mcp__plugin_exarchos_exarchos__exarchos_workflow({
  action: "set", featureId: "<id>", updates: {
    "artifacts": { "pr": ["<url1>", "<url2>"] },
    "synthesis": { "mergeOrder": ["<branch1>", ...], "prUrl": ["<url1>", ...], "prFeedback": [] }
  }
})
```

For merge ordering strategy, see `references/merge-ordering.md`.

**Human checkpoint:** Output "Stacked PRs enqueued: [URLs]. Waiting for CI/merge queue." then **PAUSE for user input**: "Merge stack? (yes/no/feedback)"

- **'yes'** -- PRs merge; transition to completed via `/exarchos:cleanup`
- **'feedback'** -- Route to `/exarchos:shepherd [PR_URL]` to address comments, then return here
- **'no'** -- Pause workflow; resume later with `/exarchos:rehydrate`

### Event Emissions (REQUIRED)

After PRs are created and auto-merge is enabled, emit the `stack.submitted` event:

```typescript
mcp__plugin_exarchos_exarchos__exarchos_event({ action: "append", stream: "<featureId>", event: {
  type: "stack.submitted",
  data: {
    branches: ["task-001-branch", "task-002-branch"],
    prNumbers: [101, 102]
  }
}})
```

During shepherd iterations (CI monitoring loop), emit after each assessment:

```typescript
mcp__plugin_exarchos_exarchos__exarchos_event({ action: "append", stream: "<featureId>", event: {
  type: "shepherd.iteration",
  data: {
    iteration: 1,
    prsAssessed: 2,
    fixesApplied: 0,
    status: "all-green"
  }
}})
```

These events are checked by `check-event-emissions` during workflow validation. Missing emissions will trigger warnings.

### Post-Merge Cleanup

After PRs merge, invoke cleanup:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_workflow({
  action: "cleanup", featureId: "<id>", mergeVerified: true,
  prUrl: ["<url>", ...], mergedBranches: ["<branch>", ...]
})
```

Then sync: `git fetch --prune` and remove worktrees.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Skip review phase | Always run `/exarchos:review` first |
| Force push stack branches | Use normal push |
| Delete worktrees before merge | Wait for merge confirmation |
| Create PR with failing tests | Ensure review phase passes first |
| Run readiness scripts manually | Use `prepare_synthesis` composite action |

## Handling Failures

See `references/troubleshooting.md` for test failures, PR check failures, merge queue rejections, and MCP tool errors.

## Phase Transitions and Guards

For the full transition table, consult `@skills/workflow-state/references/phase-transitions.md`.

**Quick reference:** The `synthesize` → `completed` transition requires guard `pr-url-exists` — set `synthesis.prUrl` or `artifacts.pr` in the same `set` call as `phase`.

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["set", "init"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "feature" })`
for phase transitions, guards, and playbook guidance. Use
`exarchos_orchestrate({ action: "describe", actions: ["prepare_synthesis"] })`
for orchestrate action schemas.

## Completion Criteria

- [ ] `prepare_synthesis` readiness check passed
- [ ] PR descriptions written per `references/pr-descriptions.md`
- [ ] PRs created and auto-merge enabled
- [ ] PR links provided to user
- [ ] State updated with PR URLs and merge order
