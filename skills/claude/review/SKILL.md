---
name: review
description: "Single adversarial review pass over the integrated branch diff — spec-compliance, code quality, and test adequacy judged together by one fresh-context reviewer. Triggers: /review, 'review the changes', or after delegation completes. Emits one verdict (reviews.review.status). Do NOT use for plan-review (that is its own dispatched gate) or for debugging."
metadata:
  author: exarchos
  version: 2.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: review
---

# Review Skill

## Overview

One adversarial review pass over the **complete integrated diff** (the feature branch vs `main`). A single fresh-context reviewer judges spec-compliance, code quality, and test adequacy **together** — there is no separate spec-then-quality staging. The pass emits **one** verdict (`reviews.review.status`).

> **Posture:** you are an ADVERSARIAL reviewer. Your job is to find what is wrong, not to confirm what is right.

> **MANDATORY:** before accepting any rationalization for approving without full verification, consult `references/rationalization-refutation.md`. Every common excuse is catalogued with a counter-argument and the correct action.

## Execution Context

This skill runs in a SUBAGENT spawned by the orchestrator, not inline — a clean reviewer with no authoring transcript, provisioned with the diff + the spec.

The orchestrator:
1. Generates the integrated diff once: `exarchos_orchestrate({ action: "review_diff", baseBranch: "main" })` (or `git diff main...HEAD`).
2. Passes the diff content + the state file path (for artifact resolution) + the intent grounding in the dispatch prompt.

The subagent reads the spec from state, runs the gates against the working tree, performs the adversarial walkthrough, and returns one structured JSON verdict.

### Intent grounding (intended-vs-delivered)

The orchestrator captures the **intended** change as `artifacts.intent` and threads it into the dispatch as an `intentGrounding` directive. When present, verify the delivered diff against it:

- **Intended-but-missing** — a surface or outcome the intent calls for that the diff does not deliver. Flag as a `spec` issue.
- **Delivered-but-unintended (scope creep)** — changes outside the intended surfaces with no spec justification. Flag as a `spec` issue.

When no `intentGrounding` is supplied, review against the diff alone — do not fabricate an intent.

## What the pass covers

**Pick the approach first:** `exarchos_orchestrate({ action: "runbook", id: "review-strategy" })` — single-pass vs two-pass, by diff size and prior fix-cycle count.

Review the **combined** diff across all tasks in one view — this catches cross-task interface mismatches, bugs invisible in isolation, and inconsistent patterns. Cover all three lenses in the single pass:

1. **Spec-compliance** — functional completeness, specification alignment, intended-vs-delivered. See `references/spec-compliance-checklist.md`.
2. **Test adequacy** — outcome-based, tier-scaled (not test-first ordering). Run the kill-probe so a vacuous test fails the gate:
   ```typescript
   exarchos_orchestrate({
     action: "check_test_adequacy",
     featureId: "<featureId>",
     taskId: "<taskId>",
     branch: "<branch>",
     riskTier: "<low|medium|high>",
     phase: "review"
   })
   ```
3. **Code quality** — correctness, SOLID, error handling, security, performance, maintainability, and test desiderata (behavioral / structure-insensitive / deterministic / specific). See `references/code-quality-checklist.md`, `references/security-checklist.md`, `references/typescript-standards.md`.

### Gate execution

Run the quality-evaluation gates via runbook — `exarchos_orchestrate({ action: "runbook", id: "quality-evaluation" })` — then execute the MCP-served quality-check catalog. See `references/gate-execution.md` for signatures.

1. `check_static_analysis` — lint + typecheck (D2). Must pass.
2. `check_security_scan` — security pattern detection (D1).
3. `prepare_review` — returns the deterministic check catalog (grep / structural / heuristic) + `pluginStatus`. Execute each check against the changed files; collect findings as `pluginFindings`.
4. Optional D3–D5 gates (`check_context_economy`, `check_operational_resilience`, `check_workflow_determinism`) — advisory; feed the convergence view.

> **mutation-adequacy (HIGH tier only):** a **separate required dimension** that gates the HIGH risk tier at the `/review` boundary — see `@skills/mutation-adequacy/SKILL.md`. Do not run mutation testing in this skill; the closest in-scope proxy is the **Specific** test-desiderata property plus the delegation-time `check_test_adequacy` gate.

## Verdict & fix loop

Compute the verdict once over the merged finding set. Route it via the decision runbook — `exarchos_orchestrate({ action: "runbook", id: "review-escalation" })`. See `references/convergence-and-verdict.md`.

`check_review_verdict` takes the finding counts + the `pluginFindings`, emits the gate event, and returns APPROVED or NEEDS_FIXES:

```typescript
exarchos_orchestrate({
  action: "check_review_verdict",
  featureId: "<id>",
  high: nativeHighCount,
  medium: nativeMediumCount,
  low: nativeLowCount,
  pluginFindings: catalogFindings,
})
```

The fix loop is **bounded by the shared escalation policy** (config-resolvable `escalation.maxIterations`, default **5**) — the same bound the shepherd loop uses. `check_review_verdict` reads the event-sourced fix-cycle count and returns the escalate decision the loop MUST honor:

- **Auto-fix (under the bound, mechanical findings)** — `escalate` absent/falsy: re-dispatch to the implementer with the findings and re-review.
- **Escalate to the user** — `escalate: true`: surface the findings + `escalationReason` and ask how to proceed, when EITHER the bound is reached OR a finding is **intent-touching** (a `spec` issue that changes what was asked for — a human decides, not the loop).

> **Companion plugin (platform-dependent):** on platforms with skill support the orchestrator may also invoke `impeccable:critique` for frontend diffs; feed its findings as additional `pluginFindings`.

> **Gate events:** do NOT manually emit `gate.executed` — `check_review_verdict` emits it. Manual emission duplicates.

## Required output format

The subagent MUST return one structured JSON verdict. Any other format is an error.

```json
{
  "verdict": "pass | fail | blocked",
  "summary": "1-2 sentence summary",
  "issues": [
    {
      "severity": "HIGH | MEDIUM | LOW",
      "category": "spec | tdd | coverage | security | solid | dry | perf | naming | test-quality | other",
      "file": "path/to/file",
      "line": 123,
      "description": "Issue description",
      "required_fix": "What must change"
    }
  ],
  "test_results": { "passed": 0, "failed": 0, "coverage_percent": 0 }
}
```

## State & transition

Record the verdict as an **object** with a `status` field (a flat string is silently ignored by the guard):

**APPROVED:**
```
exarchos_workflow({ action: "update", featureId: "<id>", updates: {
  reviews: { "review": { status: "pass", summary: "...", issues: [] } }
}})
exarchos_workflow({ action: "transition", featureId: "<id>", target: "synthesize" })
```
Then invoke `/exarchos:synthesize`.

**NEEDS_FIXES:**
```
exarchos_workflow({ action: "update", featureId: "<id>", updates: {
  reviews: { "review": { status: "fail", summary: "...", issues: [{ severity: "HIGH", file: "...", description: "..." }] } }
}})
```
Then invoke `/exarchos:delegate --fixes`.

> **Guard:** `review → synthesize` requires `all-reviews-passed` — every required dimension's `reviews.{name}.status` must be a passing value (`pass | passed | approved | fixes-applied`, case-insensitive). The feature roster is `review` (+ `mutation-adequacy` at HIGH tier). `review → delegate` fires on `any-review-failed`.

All transitions are automatic — this is not a human checkpoint. See `references/auto-transition.md`.

## Anti-patterns

| Don't | Do instead |
|-------|-----------|
| Confirm what's right | Hunt for what's wrong (adversarial posture) |
| Approve without the kill-probe | Run `check_test_adequacy` — a test that can't fail is not coverage |
| Rubber-stamp on a rationalization | Consult `references/rationalization-refutation.md` |
| Let scope creep pass | Flag intended-vs-delivered drift as a `spec` issue |
| Block on LOW-priority nits | Record and track; reserve blocking for HIGH |

## Schema discovery

Use `exarchos_workflow({ action: "describe", actions: ["update"] })` and
`exarchos_orchestrate({ action: "describe", actions: ["check_static_analysis", "check_security_scan", "check_test_adequacy", "check_review_verdict", "prepare_review"] })` for current parameter schemas.
