---
name: shepherd
description: "Shepherd PRs through CI and reviews to merge readiness. Operates as an iteration loop within the synthesize phase (not a separate HSM phase). Reads PR, CI and review state with the agent's own tools, fixes failures, records each iteration, and requests approval. Triggers: 'shepherd', 'tend PRs', 'check CI', or /shepherd."
metadata:
  author: exarchos
  version: 2.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: synthesize
---

# Shepherd Skill

## VCS Provider

Exarchos reads no PR, CI or review state, and it does no VCS write.
Read PR, CI and review state with your own tools: `gh` or the GitHub MCP server for GitHub, `glab` for GitLab, `az repos` for Azure DevOps.
The coordinator posts each comment, enables auto-merge and merges each PR through its harness, outside governance.
If your tools cannot do a read or the harness cannot do a write, stop and report. Do not fall back to an Exarchos action.

> A PR merge in this skill is a remote operation that the coordinator runs through its harness. It is distinct from the integration merge. During delegation the coordinator lands each accepted head on the integration branch through its harness (`@skills/delegate/SKILL.md`). A stream parked in `merge-pending` follows `@skills/merge-orchestrator/SKILL.md`. This skill lands no integration commit.

Iterative loop that shepherds published PRs through CI checks and code reviews to merge readiness. You read the state of each PR with your own tools, fix failures, address feedback, and record each iteration as a `shepherd.iteration` event, until the stack is green.

> **Note:** Shepherd is not a separate HSM phase. It operates as a loop within the `synthesize` phase. The workflow phase remains `synthesize` throughout the shepherd iteration cycle. The `shepherd.iteration` events that you append and the `shepherd_status` view track loop progress without requiring a phase transition.

**Position in workflow:**
```text
synthesize → shepherd (assess → fix → resubmit → loop) → cleanup
              ^^^^^^^^^ runs within synthesize phase
```

## Default Objective

By default, shepherd seeks to **address every piece of feedback on the PR** — appending "address all feedback" to the invocation is redundant, because it is the default, not an opt-in. Each iteration drives toward zero outstanding items across all three feedback channels:

- **CI / checks** — every failing or pending check is fixed or resolved.
- **Formal reviews** — every `CHANGES_REQUESTED` review is addressed.
- **Inline comments** — every inline review comment (human, CodeRabbit, Sentry, bots) gets a fix and/or a reply, **regardless of severity**. A minor or nit-level comment is still feedback: address it, or reply explaining why it is intentionally declined. The goal is that a human scanning the PR sees **every** thread has a response.

A green CI run and an approved review do not make a PR ready while a minor `comment-reply` item remains. **Do not treat them as license to skip it** — only request approval once every `comment-reply` action item is addressed (fix or reply). "Address all feedback" is the standing default.

## Pipeline Hygiene

When the pipeline accumulates stale workflows (inactive > 7 days), run `@skills/prune/SKILL.md` to bulk-cancel abandoned workflows before starting a new shepherd cycle. Discover the stale set with `exarchos:exarchos_view({ action: "pipeline", scope: "all" })` — the default view is repo-scoped to the caller's repo and hides *legacy* rows (workflows started before repo identity was recorded), which are exactly the stale ones this cleanup targets. The safeguard skips workflows with recent commits, and the prune skill reads the open PRs of each candidate with your own tools before it applies, so active shepherd targets are not touched. A clean pipeline makes shepherd iteration reporting easier to read and reduces noise in the stale-count view.

## Triggers

Activate when:
- User runs `shepherd` or says "shepherd", "tend PRs", "check CI"
- PRs are published and need monitoring through the CI/review gauntlet
- After `synthesize` completes and PRs are enqueued

## Prerequisites

- Active workflow with PRs published (PR URLs in `synthesis.prUrl` or `artifacts.pr`)
- PRs created and pushed (synthesize Step 3 already ran)
- A tool that reads PR, CI and review state for your VCS provider, such as `gh`

## Process

> **Runbook:** The shepherd-iteration runbook lists the event steps of each iteration:
> `exarchos_orchestrate({ action: "runbook", id: "shepherd-iteration" })`
> Read PR, CI and review state with your own tools (Step 1), not through an Exarchos action.

The shepherd loop repeats until all PRs are healthy or escalation criteria are met. Default: 5 iterations.

### Step 0 — Surface Quality Signals

At the start of each iteration, query quality hints to inform the assessment:
```
exarchos:exarchos_view({ action: "code_quality", workflowId: "<featureId>" })
```
- If `regressions` is non-empty, include regression context in the status report
- If any hint has `confidenceLevel: 'actionable'`, surface the `suggestedAction` in the iteration summary
- If `gatePassRate < 0.80` for any skill, flag degrading quality trends

This step ensures the agent acts on accumulated quality intelligence before polling individual PRs.

### Step 1 — Assess

Read each PR in the stack with your own tools. For GitHub with `gh`:
```bash
gh pr view <number> --json number,url,state,headRefName,baseRefName,reviewDecision,autoMergeRequest
gh pr checks <number>
gh api --paginate repos/<owner>/<repo>/pulls/<number>/reviews
gh api --paginate repos/<owner>/<repo>/pulls/<number>/comments
```

The GitHub MCP server, `glab` and `az repos` give the same facts. `references/assess-checklist.md` gives the full read for each dimension:
- CI status of each check
- Formal review status (APPROVED / CHANGES_REQUESTED)
- Inline review comments and their replies (Sentry, CodeRabbit, humans)
- Stack health: the base of each PR and its open, merged or closed state

Read every page of each list. A read that fails or stops early is not "no items": stop the iteration and report.

Make one action item for each open issue that the reads show:

| Type | Source |
|------|--------|
| `ci-fix` | A failing check |
| `review-address` | A `CHANGES_REQUESTED` review |
| `comment-reply` | An inline comment thread with no reply |
| `stack-fix` | A PR with the wrong base, or a branch behind its base |

Each action item holds `type`, `pr`, `description`, `severity` (`critical`, `major` or `minor`) and `normalizedSeverity` (`HIGH`, `MEDIUM` or `LOW`). A comment item also holds `file`, `line`, `reviewer` and `threadId` when the comment gives them.

Then decide the next step:

| Result of the reads | Action |
|---------------------|--------|
| Every check passes, no `CHANGES_REQUESTED` review, every thread has a reply | Skip to Step 4 |
| Any action item | Proceed to Step 2 |
| Checks still pending, no other action item | Inform user, pause, re-assess after delay |
| An escalation trigger | See `references/escalation-criteria.md` |

### Step 2 — Fix

**Anchor every change to the invariant catalog (evaluation-time Constraints).** Before composing any code fix, load `.exarchos/invariants.md` (entries marked `cost-of-load: always-load`) and surface a **Constraints** section naming the invariants the fix must preserve, then probe each proposed change against them. This is the shepherd evaluation-time equivalent of `ideate`'s Phase 0 and uses the **same single shared source of truth** for the selection rules and catalog-registration gating: `@skills/ideate/references/constraint-anchoring.md`. **Catalog-registration gated:** when no catalog is registered under `.exarchos.yml: invariants.catalogs`, surface no Constraints section and fix directly. This makes "when evaluating changes, apply `.exarchos/invariants.md`" the default — there is no need to request it per invocation.

Before iterating over individual action items, classify them so the loop
knows which to fix inline vs. delegate. Call `classify_review_items` on
the action items of Step 1 (the classifier groups them by file):

```typescript
exarchos:exarchos_orchestrate({
  action: "classify_review_items",
  featureId: "<id>",
  actionItems: <action items from Step 1>
})
```

The result returns `groups: ClassificationGroup[]` with a `recommendation`
per group: `direct` (handle inline), `delegate-fixer` (spawn the fixer
subagent for batched/HIGH-severity work), or `delegate-scaffolder`
(cheap subagent for doc nits). Iterate the groups in order, applying
per-group strategy, then consult `references/fix-strategies.md` for
detailed per-issue-type instructions.

**Remediation event protocol (FLYWHEEL):**

1. **BEFORE applying a fix**, emit `remediation.attempted`:
   ```typescript
   exarchos:exarchos_event({
     action: "append",
     stream: "<featureId>",
     event: {
       type: "remediation.attempted",
       data: { taskId: "<taskId>", skill: "shepherd", gateName: "<failing-gate>", attemptNumber: <N>, strategy: "direct-fix" }
     }
   })
   ```

2. Apply the fix (CI failure, review comment response, stack restack).

3. **AFTER the next assess confirms the fix resolved the gate**, emit `remediation.succeeded`:
   ```
   exarchos:exarchos_event({
     action: "append",
     stream: "<featureId>",
     event: {
       type: "remediation.succeeded",
       data: { taskId: "<taskId>", skill: "shepherd", gateName: "<gate>", totalAttempts: <N>, finalStrategy: "direct-fix" }
     }
   })
   ```

These events feed `selfCorrectionRate` and `avgRemediationAttempts` metrics in CodeQualityView.

**Action item types:**

| Type | Strategy |
|------|----------|
| `ci-fix` | Read the logs with your own tools (`gh run view <run-id> --log-failed`), reproduce locally, fix, commit to stack branch |
| `comment-reply` | Use the reviewer, severity, file, line and full text of the comment to compose a response. `references/fix-strategies.md` gives the severity markers of each reviewer. **Posting:** the coordinator posts both PR-level summary comments and per-thread inline replies through its harness, outside governance. A comment with a lost reply can post twice. Thus before a re-post, read every page of the PR comments with your own tools (`gh api --paginate`). Skip the re-post only on an exact match by PR, thread and body text. A truncated or failed read is never "no reply there": stop before the re-post. If the harness cannot post, stop and report. |
| `review-address` | Fix code for CHANGES_REQUESTED, reply to each thread |
| `stack-fix` | Run `git rebase origin/<base>`, then read the base and state of each PR again with your own tools (`gh pr view <number> --json baseRefName,state`) |
| `escalate` | Consult `references/escalation-criteria.md` |

Every inline review comment must get a reply. The goal is that a human scanning the PR sees every thread has a response.

### Step 3 — Resubmit

After fixes are applied, resubmit the stack:
```bash
git push --force-with-lease
```

Re-enable auto-merge if needed: the coordinator enables it through its harness, outside governance, with the squash strategy. Before a merge or an auto-merge retry, read the PR state with your own tools (`gh pr list --head <branch> --base <base> --state all --json number,url,state`). Do not merge a PR that is already merged, and stop and report on a closed one.

Append `shepherd.iteration` at the end of each iteration (REQUIRED — the escalation policy counts these events to bound the loop):
```typescript
exarchos:exarchos_event({
  action: "append",
  stream: "<featureId>",
  event: {
    type: "shepherd.iteration",
    data: { iteration: 1, prsAssessed: 2, fixesApplied: 3, status: "resubmitted" }
  },
  idempotencyKey: "<featureId>:shepherd.iteration:1"
})
```

Return to Step 1 for the next iteration. Track iteration count against the limit (default 5). If the limit is reached before every PR is ready for approval, escalate per `references/escalation-criteria.md`.

### Step 4 — Request Approval

When the reads of Step 1 show every check green and every comment addressed:

> **Guard:** Confirm there are no remaining `comment-reply` action items before requesting approval. Per the [Default Objective](#default-objective), every inline comment — including minor/nit-level — must be addressed first. If any remain, return to Step 2 instead of requesting approval.

> **Invariant-conformance pointer (catalog-registration gated, before merge):** When a catalog is registered under `.exarchos.yml: invariants.catalogs`, run the review-phase-scoped `check_invariant_conformance` action over the PR diff before requesting approval / merge, so the merge-gate read of the architectural invariants matches the diff that is about to land. This is a **pointer/affordance, not a hard gate** — the action is non-blocking (`gate: { blocking: false }`); it surfaces conformance findings to fold into the review verdict, it does not stop the merge. It is **not** a design-time **Constraints** section (shepherd runs at synthesize/merge, not design-time) — Step 2's Constraints anchoring covers fix composition; this pointer covers the diff-vs-invariants read at the review/merge gate. When no catalog is registered, skip this step.
>
> ```typescript
> exarchos:exarchos_orchestrate({
>   action: "check_invariant_conformance",
>   featureId: "<id>",
>   phase: "review",
>   diff: "<PR diff>"
> })
> ```

1. Request review via GitHub MCP:
   ```
   mcp__plugin_github_github__update_pull_request({
     owner: "<owner>", repo: "<repo>", pullNumber: <number>,
     reviewers: ["<approver>"]
   })
   ```
   Fallback (if MCP token lacks write scope): `gh pr edit <number> --add-reviewer <approver>`

2. Report to user:
   ```markdown
   ## Ready for Approval

   All CI checks pass. All review comments addressed.
   Approval requested from: <approvers>

   PRs:
   - #123: <url>
   - #124: <url>

   Run `cleanup` after merge completes.
   ```

## State Management

Track shepherd progress via workflow state:

**Initialize:**
```
exarchos:exarchos_workflow({
  action: "update",
  featureId: "<id>",
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

**After each iteration:** Update `currentIteration`, record assessment summary and actions taken. On approval: set `approvalRequested: true` with timestamp and approver list.

### Phase Transitions and Guards

For the full transition table, consult `@skills/checkpoint/references/phase-transitions.md`.

The shepherd skill operates within the `synthesize` phase and does not drive phase transitions directly.

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["update", "init"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "feature" })`
for phase transitions, guards, and playbook guidance. Use
`exarchos_event({ action: "describe", eventTypes: ["shepherd.iteration", "remediation.attempted", "remediation.succeeded"] })`
for event data schemas before emitting events.

## Event Emission

Before emitting any shepherd events, consult `references/shepherd-event-schemas.md` for full Zod schemas, type constraints, and example payloads. Use `exarchos_event({ action: "describe", eventTypes: ["shepherd.iteration"] })` to discover required fields at runtime.

You append every event in this table with `exarchos_event append`. No Exarchos action reads a PR or appends a `shepherd.*` event for you. `shepherd.iteration` is the only `shepherd.*` event that you append.

| Event | When | Purpose |
|-------|------|---------|
| `shepherd.iteration` | After each assess cycle | Track progress |
| `remediation.attempted` | Before applying a fix | selfCorrectionRate metric |
| `remediation.succeeded` | After fix confirmed | avgRemediationAttempts metric |

Append no `ci.status` or `ci.check_observed` event. Those types hold CI history from the earlier assessment action, and the views still read the rows that exist.

Append no `shepherd.started`, `shepherd.approval_requested`, `shepherd.escalated` or `shepherd.completed` event. These four types are retired as emissions. The `shepherd_status` view still reads the rows that exist, so old logs replay the same.

## Domain Knowledge

Consult these references for detailed guidance:
- `references/fix-strategies.md` — Fix approaches per issue type, response templates, remediation event emission details
- `references/escalation-criteria.md` — When to stop iterating and escalate to the user
- `references/assess-checklist.md` — The read for each PR dimension, with your own tools
- `references/gate-event-emission.md` — The historical `ci.check_observed` rows, and why you append none
- `references/shepherd-event-schemas.md` — The schema of `shepherd.iteration`, and the four retired shepherd events

### Decision Runbooks

When iteration limits are reached or CI repeatedly fails, consult the escalation runbook:
`exarchos_orchestrate({ action: "runbook", id: "shepherd-escalation" })`

This runbook provides structured criteria for deciding whether to keep iterating, escalate to the user, or abort the shepherd loop based on iteration count, CI stability, and review status.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Ask Exarchos for PR, CI or review state | Read it with your own tools (Step 1) |
| Force-merge with failing CI | Fix the failures first |
| Ignore inline comments | Address every thread with a reply |
| Skip minor/nit comments because CI is green and a review approved | Address every `comment-reply` item first (see Default Objective) |
| Compose fixes without checking invariants | Anchor each change to `.exarchos/invariants.md` (Step 2, catalog-registration gated) |
| Merge without a diff-vs-invariants read when a catalog is registered | Run `check_invariant_conformance` over the PR diff before approval/merge (Step 4 pointer, catalog-registration gated, non-blocking) |
| Loop indefinitely | Respect iteration limits, escalate |
| Skip remediation events | Emit `remediation.attempted` / `remediation.succeeded` for every fix |
| Treat a failed or partial read as "no items" | Stop the iteration and report |
| Push directly to main | All fixes go through stack branches |

## Transition

After approval is granted and PRs merge, run `cleanup` to resolve the workflow to completed state.
