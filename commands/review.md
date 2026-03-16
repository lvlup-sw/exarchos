---
description: Run two-stage review (spec compliance + code quality)
---

# Review

Review implementation for: "$ARGUMENTS"

## Workflow Position

```
/exarchos:ideate → [CONFIRM] → /exarchos:plan → /exarchos:delegate → /exarchos:review → /exarchos:synthesize → [CONFIRM] → merge
                                                                        ▲▲▲▲▲▲▲▲▲▲▲▲▲▲
                            ON BLOCKED ──────────────────────────────────────┘
                            ON FAIL → /exarchos:delegate --fixes (auto)
```

Review runs AFTER delegation completes -- reviews the branch stack diff.

## Skill References

- **Stage 1 (spec compliance):** `@skills/spec-review/SKILL.md`
- **Stage 2 (code quality):** `@skills/quality-review/SKILL.md`
- **Plugin integration:** `@skills/quality-review/references/axiom-integration.md`

Reviews MUST be dispatched to subagents (not run inline). Use the branch stack diff to reduce context by 80-90%:

```bash
git diff main...HEAD > /tmp/stack-diff.patch
```

## Idempotency

Before reviewing, check review status in state:
1. Skip tasks where both reviews already passed
2. Only review pending tasks
3. If all reviews passed, skip to auto-chain

## Quality Check Catalog (Tier 2 — All Platforms)

Before dispatching the quality-review subagent, call `prepare_review` to get the quality check catalog:

```typescript
exarchos_orchestrate({ action: "prepare_review", featureId: "<id>" })
```

This returns structured check patterns (grep, structural, heuristic) that the quality-review subagent executes against the codebase. The catalog works on **any MCP platform** — no companion plugins needed.

Pass the catalog to the quality-review subagent along with the diff. The subagent executes checks, collects findings, and feeds them as `pluginFindings` to `check_review_verdict`:

```typescript
exarchos_orchestrate({
  action: "check_review_verdict",
  featureId: "<id>",
  high: nativeHighCount,
  medium: nativeMediumCount,
  low: nativeLowCount,
  pluginFindings: catalogFindings,  // from check catalog execution
})
```

The `pluginFindings` counts are merged with native counts before computing the verdict.

## Companion Plugin Enhancement (Tier 3 — Claude Code / Cursor)

On platforms with skill support, the orchestrator additionally invokes companion plugin skills after the quality-review subagent returns. These provide deeper qualitative analysis beyond the deterministic catalog.

### Detection

Check the `pluginStatus` from `prepare_review` response AND your available skills list:
- `axiom:audit` — deeper backend quality analysis (7 dimensions)
- `impeccable:critique` — frontend design quality

### Invocation

```typescript
// Only if plugin is enabled AND skill is available
Skill({ skill: "axiom:audit" })    // Pass: diff content, changed file list
Skill({ skill: "impeccable:critique" })  // Pass: diff content
```

### Verdict Escalation

Feed companion plugin findings as additional `pluginFindings` to `check_review_verdict`. The merged counts determine the final verdict:

- **No plugin HIGH findings** → verdict unchanged
- **Plugin HIGH findings found** → escalates APPROVED to NEEDS_FIXES

### Plugin Coverage

Log status in review output:
- Not installed: `axiom: not installed (install with claude plugin install axiom@lvlup-sw)`
- Disabled: `axiom: disabled via .exarchos.yml`
- Active: `axiom: active (N findings)`

## Output

Track the feature name and plan path as `$FEATURE_NAME` and `$PLAN_PATH`.

## Auto-Chain

All transitions happen **immediately** without user confirmation:

- **ON PASS:** Update state `.phase = "synthesize"`, invoke `Skill({ skill: "exarchos:synthesize", args: "$FEATURE_NAME" })`
- **ON FAIL:** Update state with failed review details, invoke `Skill({ skill: "exarchos:delegate", args: "--fixes $PLAN_PATH" })`
- **ON BLOCKED:** Update state `.phase = "blocked"`, invoke `Skill({ skill: "exarchos:ideate", args: "--redesign $FEATURE_NAME" })`

**No pause for user input** -- this is not a human checkpoint.
