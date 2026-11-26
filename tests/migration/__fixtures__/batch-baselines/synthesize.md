---
name: synthesize
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

Exarchos reads no PR, CI or review state, and it does no VCS write.
Read PR, CI and review state with your own tools: `gh` or the GitHub MCP server for GitHub, `glab` for GitLab, `az repos` for Azure DevOps.
The coordinator creates each PR, enables auto-merge, merges and posts each comment through its harness, outside governance.
If your tools cannot do a read or the harness cannot do a write, stop and report. Do not fall back to an Exarchos action.

> **Not to be confused with the integration merge.** This skill merges user-facing PRs on `main` through the harness of the coordinator, a remote operation. During delegation the coordinator lands each accepted head on the integration branch through its harness (`@skills/delegate/SKILL.md`). Settle observes each landing by ancestry. Synthesize lands no integration commit.

## Overview

Submit stacked PRs after review phase completes. The `prepare_synthesis` composite action consolidates readiness checks, stack verification, test validation, and quality signal analysis into a single call -- eliminating the multi-script coordination that historically caused synthesis failures.

**Prerequisites:**
- All delegated tasks complete with reviews passed (spec + quality)
- The integration branch already exists from delegation phase
- Task branches present and pushed to remote

Do NOT proceed if either review is incomplete or failed -- return to `review` first.

**Entry points:** Synthesis is normally reached from the `review` phase of
feature / debug / refactor workflows. It is also reachable from `oneshot`
workflows via the opt-in path — when a user signals "let's open a PR for
this" during `plan` or `implementing`, the `request_synthesize` event is
appended, and `finalize_oneshot` then resolves the choice state and
transitions the workflow to `synthesize`. See
`@skills/oneshot/SKILL.md` for the opt-in mechanics and
`synthesisPolicy` semantics.

## Triggers

Activate this skill when:
- User runs `synthesize` command
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
exarchos:exarchos_orchestrate({
  action: "prepare_synthesis",
  featureId: "<id>",
  repoRoot: "<absolute path of the repo under synthesis>"
})
```

`repoRoot` is required. All four readiness legs (test suite, typecheck, stack, changed files) shell out with it as their working directory, so it names the tree the verdict is about. The gate will not fall back to whatever directory the server was launched in — omit it and the call is rejected rather than answered about the wrong repo. During a stacked synthesis, pass the integration worktree's absolute path.

This action performs:
- **Phase readiness** -- Confirms workflow is in the correct phase with all reviews complete
- **Stack integrity** -- Detects diverged branches, missing task branches, or broken parent chains and reconstructs automatically
- **Test verification** -- Runs `npm run test:run && npm run typecheck` from the stack top
- **Benchmark regression** -- If `state.verification.hasBenchmarks` is true, checks for performance regressions
- **Quality signals** -- Queries `code_quality` view for regressions and actionable hints
- **Document readiness** -- Touched doc-surfaces must carry corresponding doc updates (auto-waives when no doc surface is touched)
- **Gate events** -- Auto-emits `gate.executed` events for each check (tests, benchmarks, CodeRabbit)

For the full breakdown of individual checks the composite action performs, see `references/synthesis-steps.md`.

**On success:** All checks passed. The response includes a readiness summary with any quality hints to present to the user. Proceed to Step 2.

**On failure:** The response identifies which check failed and provides remediation guidance. Follow the guidance -- typically returning to `review` or `delegate`.

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
exarchos:exarchos_orchestrate({
  action: "validate_pr_body",
  bodyFile: "/tmp/pr-body.md"
})
```

**Do NOT create the PR until validation passes.** If validation fails, fix the body and re-validate.

`validate_pr_body` reports `intentGrounded` as advisory only. If the report says that the body is not grounded, add the intent from `artifacts.intent` to the body before the create.

### Step 3: Submit and Merge

First run the [Idempotency](#idempotency) procedure for every head of the stack. It classifies each head as a reused open match, a recorded merged match, or a create candidate. If it stops, create no PR. Then do these steps for each head of the stack, bottom-up, in this order:

1. **Create** -- For a create candidate, the coordinator creates the PR through its harness, outside governance. It uses base `<parent-branch>`, head `<branch>`, the title `<type>: <what>` and the validated body file. For a reused open match, create no PR.
2. **Record the PR URL** -- Record the URL that the harness returns as soon as it returns it, before auto-merge is enabled. Record the provider web URL exactly as the harness returns it, and do not normalize it. For a reused open match, record the URL of the single exact open match of your own read filtered by head and base: `gh pr list --head <branch> --base <parent-branch> --state all --limit 100 --json url,state,headRefName,baseRefName`. Never record an unrecorded merged match. Never record an unfiltered list of open PRs, because it can hold unrelated PRs.
3. **Update state** -- `update` replaces each array whole. Thus each write holds the full list of URLs recorded so far in both `artifacts.pr` and `synthesis.prUrl`, not only the new URL:

```typescript
exarchos:exarchos_workflow({
  action: "update", featureId: "<id>", updates: {
    "artifacts": { "pr": ["<url1>", "<url2>"] },
    "synthesis": { "mergeOrder": ["<branch1>", ...], "prUrl": ["<url1>", ...], "prFeedback": [] }
  }
})
```

A URL is recorded only after this `update` succeeds. After a lost `update` reply, send the same full list again before the next step.
4. **Enable auto-merge** -- Only after the `update` succeeds, the coordinator enables auto-merge on the PR through its harness, outside governance, with the squash strategy.
5. **Apply benchmark label** -- If `verification.hasBenchmarks` is true, apply label: `gh pr edit <number> --add-label has-benchmarks`

If the harness cannot do one of these writes, stop and report. Do not fall back to an Exarchos action.

For merge ordering strategy, see `references/merge-ordering.md`.

**Human checkpoint:** Output "Stacked PRs enqueued: [URLs]. Waiting for CI/merge queue." then **PAUSE for user input**: "Merge stack? (yes/no/feedback)"

- **'yes'** -- PRs merge; transition to completed via `cleanup`
- **'feedback'** -- Route to `shepherd [PR_URL]` to address comments, then return here
- **'no'** -- Pause workflow; resume later with `rehydrate`

### Event Emissions

After PRs are created and auto-merge is enabled, record the submission with a `stack.submitted` event. This is a telemetry record of what went up — nothing decides anything from it, and `check-event-emissions` does not ask for it:

```typescript
exarchos:exarchos_event({ action: "append", stream: "<featureId>", event: {
  type: "stack.submitted",
  data: {
    branches: ["task-001-branch", "task-002-branch"],
    prNumbers: [101, 102]
  }
}})
```

During shepherd iterations (CI monitoring loop), emit after each assessment of your own PR, CI and review reads (REQUIRED — the `shepherd_status` view counts these events, and its `iteration` value is the count that bounds the loop):

```typescript
exarchos:exarchos_event({ action: "append", stream: "<featureId>", event: {
  type: "shepherd.iteration",
  data: {
    iteration: 1,
    prsAssessed: 2,
    fixesApplied: 0,
    status: "all-green"
  }
}})
```

Checked by `check-event-emissions` in this phase: `team.spawned`, `team.disbanded`, `shepherd.iteration`.

A missing one comes back as a hint with `complete: false` — on the explicit gate call, and on the `_eventHints` field the telemetry middleware adds to tool results while hints are outstanding. `stack.submitted` is not checked.

### Post-Merge Cleanup

After PRs merge, invoke cleanup:
```typescript
exarchos:exarchos_workflow({
  action: "cleanup", featureId: "<id>", mergeVerified: true,
  prUrl: ["<url>", ...], mergedBranches: ["<branch>", ...]
})
```

Then sync: `git fetch --prune` and reclaim worktrees.

> **Worktree reclamation — after the merge.** Once the PRs merge, the
> coordinator removes the worktrees of this workflow through its harness,
> outside governance. It removes only the worktrees that this workflow recorded,
> skips one that is already removed, and never force-removes one with
> uncommitted work: it resolves the reason first. The full rule is in
> `@skills/cleanup/SKILL.md`.

## Idempotency

Exarchos has no PR-creation action and reads no PR, so no action decides that a PR already exists. The coordinator runs this procedure with its own tools for every head of the stack before the harness creates any PR. The reads below use `gh`. For GitLab use `glab mr list`, and for Azure DevOps use `az repos pr list`, with the same filters. It compares URLs as exact strings, in the `url` form that the provider returns.

1. Read the PR URLs that `synthesis.prUrl` and `artifacts.pr` record.
2. For each head, run `gh pr list --head <head> --base <base> --state all --limit 100 --json url,state,headRefName,baseRefName`. Keep each result whose `headRefName` equals the head and whose `baseRefName` equals the base.
3. For each head, also run `gh pr list --head <head> --state all --limit 100 --json url,state,headRefName,baseRefName`. The provider retargets a stacked PR to the base of its merged parent. Thus a recorded URL that this read shows into the base of a lower head of the stack is the match for this head.
4. Compare `state` without case. `OPEN` is open and `MERGED` is merged. Any other value, `CLOSED` included, is a stop. An unknown state is never "no match".
5. Classify each head:
   - One open match is reused, recorded or not, and the harness creates no PR for it. An open PR carries the current tip of its head branch.
   - One merged match counts only when `synthesis.prUrl` or `artifacts.pr` records its URL. A recorded merged match needs no new PR.
   - A head with no match is a create candidate.
6. Stop and report, and create no PR for any head, on one of these:
   - a match that is closed and not merged
   - more than one match for a head
   - a recorded URL that no read for any head of the stack shows
   - a failed read. A read that returns as many PRs as its `--limit` is a failed read, because more PRs can exist.
   - an unrecorded merged match into the same base
   - an unrecorded open or merged PR for the head into another base
   - a recorded PR for the head into another base that is not the base of a lower head of the stack
   - a create candidate beside a head with a merged match
7. When each head of the stack has a recorded merged match, take the merged-PR escape hatch below. An unrecorded merged match never takes the escape hatch.
8. Otherwise the harness creates a PR for each create candidate only, bottom-up (Step 3).

A merged match counts only when it is recorded. A merged PR carries only the tip of its head branch at merge time, so it does not prove that it holds the head commit of this workflow. The integration branch name can be used again (`synthesis.integrationBranch`, else the current branch, else the featureId). Thus an unrecorded merged match can be an old PR of another workflow. The workflow state record is the only proof that a merged PR belongs to this workflow.

The user resolves the reason for each stop. A reused or long-lived branch can hold old closed or merged PRs, so the procedure stops on that branch until the user resolves it. A lower head can auto-merge before an upper head is created, for example after a failed create or after a lost reply before the record. The procedure then stops on the create candidate beside the merged head. Step 3 records each URL before it enables auto-merge, so only a human merge can make an unrecorded PR merged. If a reply is lost and a human then merges that PR, the procedure stops and opens no duplicate. The coordinator never records an unrecorded merged URL itself, not even to clear a stop. The user records that URL in the workflow state only after the user confirms that the PR holds the head commit of this workflow. Then run synthesize again.

The post-merge case is distinct from create-time idempotency. When each head of the stack has a recorded merged match, transition to `completed` via `action: "transition"`, `target: "completed"` (the runtime rejects `updates.phase`; the canonical `transition` action runs the HSM guard and emits `workflow.transition`). The guard `pr-url-exists` checks only that a URL is present. Thus the escape hatch uses only the URLs that the workflow state recorded before the reads, and it records no new URL. This `completed` transition is normally owned by `cleanup` via `action: "cleanup"`; the bare phase-only transition is a manual-cleanup escape hatch.

## Direct Edits to Stack Branches

You can make direct edits to stack branches at any time — edit files, then stage and amend (`git add <files> && git commit --amend`). Push with the **explicit-SHA** lease, never a bare `--force-with-lease`:

```bash
git push --force-with-lease=<ref>:<expected-sha>
```

A bare lease anchors to the (possibly stale) local remote-tracking ref and can clobber a concurrent push. `<expected-sha>` is the remote SHA that the loop last read with `git ls-remote --heads origin <ref>`. Read it fresh before each push.

## Completion Output

When the PR is created and checks pass, report:

```markdown
## Synthesis Complete

PR: [URL]
Tests: X pass | Build: 0 errors
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Skip review phase | Always run `review` first |
| Force push stack branches | Use normal push |
| Delete worktrees before merge | Wait for merge confirmation |
| Create PR with failing tests | Ensure review phase passes first |
| Run readiness scripts manually | Use `prepare_synthesis` composite action |

## Handling Failures

See `references/troubleshooting.md` for test failures, PR check failures, merge queue rejections, and MCP tool errors.

## Phase Transitions and Guards

For the full transition table, consult `@skills/checkpoint/references/phase-transitions.md`.

**Quick reference:** The `synthesize` → `completed` transition requires guard `pr-url-exists` — write `synthesis.prUrl` or `artifacts.pr` with `update` before the `transition` call. On the merged-PR escape hatch, use only the URLs that the workflow state recorded before the Idempotency reads, and record no new URL.

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["update", "init"] })` for
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
