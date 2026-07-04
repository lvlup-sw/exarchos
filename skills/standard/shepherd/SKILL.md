---
name: shepherd
description: "Shepherd PRs through CI and reviews to merge readiness. Operates as an iteration loop within the synthesize phase (not a separate HSM phase). Uses assess_stack to check PR health, fix failures, and request approval. Triggers: 'shepherd', 'tend PRs', 'check CI', or /shepherd."
metadata:
  author: exarchos
  version: 2.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: synthesize
---

# Shepherd Skill

## VCS Provider

This skill uses VCS operations through Exarchos MCP actions (`check_ci`, `list_prs`, `merge_pr`, `get_pr_comments`, `add_pr_comment`, etc.).
These actions automatically detect and route to the correct VCS provider (GitHub, GitLab, Azure DevOps).
No `gh`/`glab`/`az` commands needed — the MCP server handles provider dispatch.

> The `merge_pr` invoked here is the remote PR merge primitive (synthesize-phase). It is distinct from the integration merge run during the upstream `merge-pending` substate — there, `serialize_merge` (`@skills/merge-orchestrator/SKILL.md`) is the integration-merge path: it holds a single-writer lease and composes the local `git merge` (raw `merge_orchestrate` is that composed executor / the non-integration path). This skill never invokes `serialize_merge` or `merge_orchestrate`.

Iterative loop that shepherds published PRs through CI checks and code reviews to merge readiness. Uses the `assess_stack` composite action for all PR health checks, fixing failures and addressing feedback until the stack is green.

> **Note:** Shepherd is not a separate HSM phase. It operates as a loop within the `synthesize` phase. The workflow phase remains `synthesize` throughout the shepherd iteration cycle. Events (`shepherd.iteration`, `ci.status`) and the `shepherd_status` view track loop progress without requiring a phase transition.

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

`assess_stack` is advisory: its `computeRecommendation` only forces `fix-and-resubmit` on critical/major items, so it can return `request-approval` while minor `comment-reply` items remain. **Do not treat that as license to skip them** — only request approval once every `comment-reply` action item is addressed (fix or reply). "Address all feedback" is the standing default.

## Pipeline Hygiene

When `exarchos:exarchos_view pipeline` accumulates stale workflows (inactive > 7 days), run `@skills/prune-workflows/SKILL.md` to bulk-cancel abandoned workflows before starting a new shepherd cycle. Safeguards skip workflows with open PRs or recent commits, so active shepherd targets are never touched. A clean pipeline makes shepherd iteration reporting easier to read and reduces noise in the stale-count view.

## Triggers

Activate when:
- User runs `shepherd` or says "shepherd", "tend PRs", "check CI"
- PRs are published and need monitoring through the CI/review gauntlet
- After `synthesize` completes and PRs are enqueued

## Prerequisites

- Active workflow with PRs published (PR URLs in `synthesis.prUrl` or `artifacts.pr`)
- PRs created and pushed (`create_pr` already ran)
- Exarchos MCP tools available for VCS operations

## Process

> **Runbook:** Each shepherd iteration follows the shepherd-iteration runbook:
> `exarchos_orchestrate({ action: "runbook", id: "shepherd-iteration" })`
> If runbook unavailable, use `describe` to retrieve action schemas: `exarchos_orchestrate({ action: "describe", actions: ["assess_stack"] })`

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

Invoke the `assess_stack` composite action to check all PR dimensions at once:
```
exarchos:exarchos_orchestrate({
  action: "assess_stack",
  featureId: "<id>",
  prNumbers: [123, 124, 125]
})
```

The composite action internally handles:
- CI status checking for all PRs
- Formal review status (APPROVED / CHANGES_REQUESTED)
- Inline review comment polling and thread resolution (Sentry, CodeRabbit, humans)
- Stack health verification
- Event emission: `gate.executed` events per CI check (feeds CodeQualityView) and `ci.status` events per PR (feeds ShepherdStatusView). See `references/gate-event-emission.md` for the event format.

Review the returned `actionItems` and `recommendation`:

| Recommendation | Action |
|----------------|--------|
| `request-approval` | Skip to Step 4 **only if every `comment-reply` item is addressed**. If any inline comment is still unaddressed, treat as `fix-and-resubmit` and address it first (see [Default Objective](#default-objective)). |
| `fix-and-resubmit` | Proceed to Step 2 |
| `wait` | Inform user, pause, re-assess after delay |
| `escalate` | See `references/escalation-criteria.md` |

### Step 2 — Fix

**Anchor every change to the invariant catalog (evaluation-time Constraints).** Before composing any code fix, load `.exarchos/invariants.md` (entries marked `cost-of-load: always-load`) and surface a **Constraints** section naming the invariants the fix must preserve, then probe each proposed change against them. This is the shepherd evaluation-time equivalent of `ideate`'s Phase 0 and uses the **same single shared source of truth** for the selection rules and devCatalog gating: `@skills/brainstorming/references/constraint-anchoring.md`. **devCatalog-gated:** when `.exarchos.yml: invariants.devCatalog: enabled` is unset or `disabled`, surface no Constraints section and fix directly. This makes "when evaluating changes, apply `.exarchos/invariants.md`" the default — there is no need to request it per invocation.

Before iterating over individual action items, classify them so the loop
knows which to fix inline vs. delegate. Call `classify_review_items` on
the assessment's `actionItems` (the comment-reply subset is what the
classifier groups by file; CI-fix and review-address items are passed
through unchanged):

```typescript
exarchos:exarchos_orchestrate({
  action: "classify_review_items",
  featureId: "<id>",
  actionItems: <actionItems from assess_stack>
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
| `ci-fix` | Read logs, reproduce locally, fix, commit to stack branch |
| `comment-reply` | Use `actionItem.reviewer`, `normalizedSeverity`, `file`, `line`, and `raw` (full original comment) to compose a response. Provider adapters under `servers/exarchos-mcp/src/review/providers/` populate the input fields — no manual tier parsing needed. **Posting:** both PR-level summary comments and per-thread inline replies use the provider-agnostic `add_pr_comment` orchestrate action — pass a `threadId` to route a reply into a specific inline thread (via `VcsProvider.addReply`). Inline thread replies are supported on GitHub; GitLab and Azure DevOps return an explicit "not yet supported" capability signal. |
| `review-address` | Fix code for CHANGES_REQUESTED, reply to each thread |
| `restack` | Run `git rebase origin/<base>`, verify with `exarchos_orchestrate({ action: "list_prs" })` |
| `escalate` | Consult `references/escalation-criteria.md` |

Every inline review comment must get a reply. The goal is that a human scanning the PR sees every thread has a response.

### Step 3 — Resubmit

After fixes are applied, resubmit the stack:
```bash
git push --force-with-lease
```

Re-enable auto-merge if needed:
```typescript
exarchos_orchestrate({ action: "merge_pr", prId: "<number>", strategy: "squash" })
```

Return to Step 1 for the next iteration. Track iteration count against the limit (default 5). If the limit is reached without reaching `request-approval`, escalate per `references/escalation-criteria.md`.

### Step 4 — Request Approval

When `assess_stack` returns `recommendation: 'request-approval'` (all checks green, all comments addressed):

> **Guard:** Confirm there are no remaining `comment-reply` action items before requesting approval. Per the [Default Objective](#default-objective), every inline comment — including minor/nit-level — must be addressed first. If any remain, return to Step 2 instead of requesting approval.

> **Invariant-conformance pointer (devCatalog-gated, before merge):** When `.exarchos.yml: invariants.devCatalog: enabled`, run the review-phase-scoped `check_invariant_conformance` action over the PR diff before requesting approval / merge, so the merge-gate read of the architectural invariants matches the diff that is about to land. This is a **pointer/affordance, not a hard gate** — the action is non-blocking (`gate: { blocking: false }`); it surfaces conformance findings to fold into the review verdict, it does not stop the merge. It is **not** a design-time **Constraints** section (shepherd runs at synthesize/merge, not design-time) — Step 2's Constraints anchoring covers fix composition; this pointer covers the diff-vs-invariants read at the review/merge gate. When the flag is unset or `disabled`, skip this step.
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

For the full transition table, consult `@skills/workflow-state/references/phase-transitions.md`.

The shepherd skill operates within the `synthesize` phase and does not drive phase transitions directly.

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["update", "init"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "feature" })`
for phase transitions, guards, and playbook guidance. Use
`exarchos_event({ action: "describe", eventTypes: ["shepherd.iteration", "ci.status", "remediation.attempted"] })`
for event data schemas before emitting events.

## Event Emission

Before emitting any shepherd events, consult `references/shepherd-event-schemas.md` for full Zod schemas, type constraints, and example payloads. Use `exarchos_event({ action: "describe", eventTypes: ["shepherd.iteration", "ci.status"] })` to discover required fields at runtime.

| Event | When | Purpose |
|-------|------|---------|
| `shepherd.started` | On skill start (emitted by `assess_stack`) | Audit trail |
| `shepherd.iteration` | After each assess cycle | Track progress |
| `gate.executed` | Per CI check (emitted by `assess_stack`) | CodeQualityView -- gate pass rates |
| `ci.status` | Per CI check result | ShepherdStatusView -- PR health tracking |
| `remediation.attempted` | Before applying a fix | selfCorrectionRate metric |
| `remediation.succeeded` | After fix confirmed | avgRemediationAttempts metric |
| `shepherd.approval_requested` | On requesting review | Audit trail |
| `shepherd.completed` | On merge detected (emitted by `assess_stack`) | Audit trail |

## Domain Knowledge

Consult these references for detailed guidance:
- `references/fix-strategies.md` — Fix approaches per issue type, response templates, remediation event emission details
- `references/escalation-criteria.md` — When to stop iterating and escalate to the user
- `references/gate-event-emission.md` — Event format for `gate.executed` (now emitted by `assess_stack`)
- `references/shepherd-event-schemas.md` — Full Zod-aligned schemas for all four shepherd lifecycle events

### Decision Runbooks

When iteration limits are reached or CI repeatedly fails, consult the escalation runbook:
`exarchos_orchestrate({ action: "runbook", id: "shepherd-escalation" })`

This runbook provides structured criteria for deciding whether to keep iterating, escalate to the user, or abort the shepherd loop based on iteration count, CI stability, and review status.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Poll CI/reviews directly | Use `assess_stack` composite action |
| Force-merge with failing CI | Fix the failures first |
| Ignore inline comments | Address every thread with a reply |
| Skip minor/nit comments because `assess_stack` said `request-approval` | Address every `comment-reply` item first — the recommendation is advisory (see Default Objective) |
| Compose fixes without checking invariants | Anchor each change to `.exarchos/invariants.md` (Step 2, devCatalog-gated) |
| Merge without a diff-vs-invariants read when devCatalog is on | Run `check_invariant_conformance` over the PR diff before approval/merge (Step 4 pointer, devCatalog-gated, non-blocking) |
| Loop indefinitely | Respect iteration limits, escalate |
| Skip remediation events | Emit `remediation.attempted` / `remediation.succeeded` for every fix |
| Push directly to main | All fixes go through stack branches |

## Transition

After approval is granted and PRs merge, run `cleanup` to resolve the workflow to completed state.
