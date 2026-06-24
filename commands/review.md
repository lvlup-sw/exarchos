---
description: Run one adversarial review pass (spec-compliance + code quality + test adequacy)
---

# Review

Review implementation for: "$ARGUMENTS"

## Workflow Position

```
/exarchos:ideate → /exarchos:plan → /exarchos:delegate → /exarchos:review → /exarchos:synthesize → [CONFIRM] → merge
                                                              ▲▲▲▲▲▲▲▲▲▲▲▲
                          ON BLOCKED ────────────────────────────┘
                          ON FAIL → /exarchos:delegate --fixes (auto)
```

Review runs AFTER delegation completes — one adversarial pass over the branch stack diff.

## Skill Reference

`@skills/review/SKILL.md` — a single fresh-context, adversarial reviewer judges spec-compliance, code quality, and test adequacy **together** and emits one verdict (`reviews.review.status`). There is no separate spec-then-quality staging.

The review MUST be dispatched to a subagent (not run inline). Use the branch stack diff to reduce context by 80-90%:

```bash
git diff main...HEAD > /tmp/stack-diff.patch
```

## Idempotency

Before reviewing, check `reviews.review.status` in state. If it is already passing, skip to the auto-chain.

## Quality Check Catalog (all platforms)

Before dispatching the review subagent, call `prepare_review` for the deterministic check catalog and the intent grounding:

```typescript
exarchos_orchestrate({ action: "prepare_review", featureId: "<id>" })
```

Pass the catalog + the diff + the intent grounding to the subagent. It executes the checks, collects findings, and feeds them as `pluginFindings` to `check_review_verdict`:

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

`mutation-adequacy` is a separate required dimension at the HIGH risk tier (see `@skills/mutation-adequacy/SKILL.md`) — the orchestrator runs it alongside this pass for HIGH-tier features.

## Companion Plugin Enhancement (platform-dependent)

On platforms with skill support, after the review subagent returns, the orchestrator may invoke a companion plugin for deeper qualitative analysis — only if enabled in `.exarchos.yml` AND the skill is available:

```typescript
Skill({ skill: "impeccable:critique" })  // frontend design quality; pass the diff
```

Feed any companion findings as additional `pluginFindings` to `check_review_verdict`. Plugin HIGH findings escalate APPROVED → NEEDS_FIXES. Log coverage: not installed / disabled / active (N findings).

## Output

Track the feature name and plan path as `$FEATURE_NAME` and `$PLAN_PATH`.

## Auto-Chain

All transitions happen **immediately** without user confirmation. Phase changes go through `action: "transition"` (the canonical HSM-guarded surface that emits `workflow.transition`) — the runtime rejects `updates.phase` on `update`. Record the verdict as an object with a `status` field, then:

- **ON PASS (APPROVED):**
  - `action: "update"`, `updates.reviews.review` = `{ status: "pass", summary: "...", issues: [] }`
  - `action: "transition"`, `target: "synthesize"`
  - Then invoke `Skill({ skill: "exarchos:synthesize", args: "$FEATURE_NAME" })`
- **ON FAIL (NEEDS_FIXES):**
  - `action: "update"`, `updates.reviews.review` = `{ status: "fail", summary: "...", issues: [...] }`
  - `action: "transition"`, `target: "delegate"`
  - Then invoke `Skill({ skill: "exarchos:delegate", args: "--fixes $PLAN_PATH" })`
- **ON BLOCKED:**
  - `action: "transition"`, `target: "blocked"`
  - Then invoke `Skill({ skill: "exarchos:ideate", args: "--redesign $FEATURE_NAME" })`

> **Guard:** `review → synthesize` requires `all-reviews-passed` — `reviews.review.status` (+ `reviews.mutation-adequacy.status` at HIGH tier) must be a passing value (`pass | passed | approved | fixes-applied`).

**No pause for user input** — this is not a human checkpoint.
