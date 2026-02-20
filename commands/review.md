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

Review runs AFTER delegation completes -- reviews the Graphite stack diff.

## Skill References

- **Stage 1 (spec compliance):** `@skills/spec-review/SKILL.md`
- **Stage 2 (code quality):** `@skills/quality-review/SKILL.md`

Reviews MUST be dispatched to subagents (not run inline). Use the Graphite stack diff to reduce context by 80-90%:

```bash
TARGET_BRANCH=$(gt parent 2>/dev/null || echo "main")
gt diff $TARGET_BRANCH > /tmp/stack-diff.patch
```

## Idempotency

Before reviewing, check review status in state:
1. Skip tasks where both reviews already passed
2. Only review pending tasks
3. If all reviews passed, skip to auto-chain

## Output

Track the feature name and plan path as `$FEATURE_NAME` and `$PLAN_PATH`.

## Auto-Chain

All transitions happen **immediately** without user confirmation:

- **ON PASS:** Update state `.phase = "synthesize"`, invoke `Skill({ skill: "exarchos:synthesize", args: "$FEATURE_NAME" })`
- **ON FAIL:** Update state with failed review details, invoke `Skill({ skill: "exarchos:delegate", args: "--fixes $PLAN_PATH" })`
- **ON BLOCKED:** Update state `.phase = "blocked"`, invoke `Skill({ skill: "exarchos:ideate", args: "--redesign $FEATURE_NAME" })`

**No pause for user input** -- this is not a human checkpoint.
