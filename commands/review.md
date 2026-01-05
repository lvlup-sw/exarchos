---
description: Run two-stage review (spec compliance + code quality)
---

# Review

Review implementation for: "$ARGUMENTS"

## Workflow Position

```
/ideate → [CONFIRM] → /plan → /delegate → /review → /synthesize → [CONFIRM] → merge
            ↑                               ▲▲▲▲▲▲
            └──────────── ON BLOCKED ───────────┘
                          ON FAIL → /delegate --fixes (auto)
```

- **ON PASS**: Auto-invokes `/synthesize`
- **ON FAIL**: Auto-invokes `/delegate --fixes`
- **ON BLOCKED**: Auto-invokes `/ideate --redesign`

## Skill References

- Spec review: `@skills/spec-review/SKILL.md`
- Quality review: `@skills/quality-review/SKILL.md`

## Execution Mode

Reviews MUST be dispatched to subagents (not run inline).

### Context-Efficient Reviews

Use diffs instead of full file contents to reduce context by 80-90%:

```bash
# Generate diff for review subagent
scripts/review-diff.sh .worktrees/<task> main
```

### Dispatch Spec Review
```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",
  description: "Spec review for $FEATURE_NAME",
  prompt: `[Spec review prompt with:
    - State file path
    - Diff output from review-diff.sh
    - Task ID being reviewed]`
})
```

### Dispatch Quality Review (after spec passes)
```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",
  description: "Quality review for $FEATURE_NAME",
  prompt: `[Quality review prompt with:
    - State file path
    - Diff output from review-diff.sh
    - Task ID being reviewed]`
})
```

## Two-Stage Process

### Stage 1: Spec Review

**Focus:** Functional completeness, TDD compliance, specification alignment

**Checklist:**
- [ ] All requirements implemented
- [ ] Tests exist for all features
- [ ] Tests written before implementation
- [ ] Coverage >80% for new code
- [ ] Matches design specification

**Verification:**
```bash
npm run test:run
npm run test:coverage
```

**Verdict:**
- PASS → Proceed to quality review
- FAIL → Return to implementer with fix list

### Stage 2: Quality Review

**Prerequisite:** Spec review must PASS

**Focus:** Code quality, SOLID principles, error handling, security

**Priority Levels:**
- HIGH: Must fix before merge
- MEDIUM: Should fix, may defer
- LOW: Nice to have

**Checklist:**
- [ ] Clear naming and structure
- [ ] SOLID principles applied
- [ ] Proper error handling
- [ ] No security issues
- [ ] Good test quality

**Verdict:**
- APPROVED → Ready for synthesis
- NEEDS_FIXES → Return for quality fixes
- BLOCKED → Requires design discussion

## Fix Loop

For failures, create specific fix task:
```typescript
Task({
  model: "opus",
  description: "Fix review issues",
  prompt: "[Specific issues and required fixes]"
})
```

Re-review after fixes.

## Idempotency

Before reviewing, check review status:
1. Read review status from state for each task
2. Skip tasks where both reviews already passed
3. Only review pending tasks
4. If all reviews passed, skip to auto-chain

## Output

Track the feature name and plan path as `$FEATURE_NAME` and `$PLAN_PATH`.

## Auto-Chain

All transitions happen **immediately** without user confirmation:

### On PASS (both spec and quality stages):

1. Update state: `.phase = "synthesize"`
2. Output: "All reviews passed. Auto-continuing to synthesis..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "synthesize", args: "$FEATURE_NAME" })
   ```

### On FAIL (spec or quality issues):

1. Update state with failed review details
2. Output: "[Stage] found [N] issues. Auto-continuing to fixes..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "delegate", args: "--fixes $PLAN_PATH" })
   ```

### On BLOCKED (critical design issues):

1. Update state: `.phase = "blocked"`
2. Output: "Quality review BLOCKED: [critical issue]. Returning to design."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "ideate", args: "--redesign $FEATURE_NAME" })
   ```

**No pause for user input** - this is not a human checkpoint.
