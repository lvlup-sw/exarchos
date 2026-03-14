# PR Feedback Mode (--pr-fixes)

When invoked with `--pr-fixes [PR_URL]`, delegation addresses human review feedback from a pull request instead of implementing from a plan.

## Priority Levels

| Priority | Source | Description |
|----------|--------|-------------|
| 1 | `coderabbit:critical` | Critical issues + SPEC COMPLIANCE failures |
| 2 | `human` | Human reviewer comments (authority over automation) |
| 3 | `coderabbit:major` | Major issues + CODE QUALITY HIGH items |
| 4 | `coderabbit:minor` | Minor issues |

## Process

### Step 1: Fetch All PR Feedback

```bash
# Get full PR details including reviews and comments
gh pr view <number> --json title,body,state,files,reviewDecision,reviews,comments

# Get issue-level comments (pre-merge check summaries)
gh issue view <number> --json comments
```

> Or use GitHub MCP `pull_request_read` and `issue_read` if available.

### Step 2: Parse CodeRabbit Feedback

**2a: Identify CodeRabbit comments** by author = `coderabbitai[bot]`

**2b: Parse line comments by severity label:**

| Label | Priority |
|-------|----------|
| `Critical` | 1 |
| `Major` | 2 |
| `Minor` | 3 |

Extract from each comment:
- Severity label (emoji + text)
- File path and line number
- Issue description
- Suggested fix (from Proposed fix section if present)

**2c: Parse pre-merge check summaries:**
- `Status: FAIL` in Spec Review -> Priority 1
- `Status: NEEDS_FIXES | BLOCKED` in Quality Review -> Priority 2
- Extract items from `Missing:`, `Untested:`, `Scope Creep:` lists

**2d: Parse reviews with `CHANGES_REQUESTED`:**
- Note "Actionable comments posted: N" count
- Cross-reference with line comments already parsed

### Step 3: Parse Human Comments (Priority 2)

For non-CodeRabbit comments, assign `priority: 2` (human authority over automation).

Skip comments that are:
- Purely praise/acknowledgment ("LGTM", "Nice work")
- Questions without action items
- Already marked resolved
- From other bots (CI notifications, etc.)

### Step 4: Create Fix Tasks

For each actionable item, create a structured fix task:

| Field | Description |
|-------|-------------|
| `id` | `fix-001`, `fix-002`, etc. |
| `priority` | `1` (critical), `2` (human), `3` (major), `4` (minor) |
| `source` | `"coderabbit:critical"`, `"human"`, `"coderabbit:major"`, `"coderabbit:minor"` |
| `severity` | `"Critical"`, `"Major"`, `"Minor"`, or null |
| `file` | File path |
| `line` | Line number (if line comment) |
| `issue` | Problem description |
| `action` | Required change / suggested fix |

### Step 5: Sort and Display Fix Tasks

Sort by priority (1->4), then by file path for grouping.

### Step 6: Track Fix Tasks

Use TodoWrite to track all fix tasks with priority labels.

### Step 7: Dispatch Fixes (MANDATORY - Priority Order)

**Dispatch sequence:**
1. Dispatch all P1 (critical) fixes in parallel
2. Wait for completion
3. Dispatch all P2 (human) fixes in parallel
4. Wait for completion
5. Dispatch all P3 (major) fixes in parallel
6. Wait for completion
7. Dispatch all P4 (minor) fixes in parallel
8. Wait for completion

**Task prompt template:**
```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",
  description: "Fix [P{priority} {severity}]: {issue summary}",
  prompt: `
# Task: Fix PR Feedback - {issue summary}

## Priority
{priority} - {source}

## Context
PR: {PR_URL}
Source: {source}
Original feedback: "{original comment text}"

## Working Directory
{absolute path to repo}

## Fix Required
File: {file path}
Line: {line number if applicable}
Issue: {issue description}
Action: {required change}

## TDD Requirements
1. Write a test that would catch this issue (if applicable)
2. Verify test fails
3. Implement the fix
4. Verify test passes

## Success Criteria
- [ ] Issue addressed per feedback
- [ ] Tests pass
- [ ] No regressions introduced
`
})
```

**CHECKPOINT:** Do NOT proceed to next priority level until all fixes in the current level have completed.

### Step 8: Push and Report

After all fixes complete, commit and push:
```bash
git add <fixed-files>
git commit -m "fix: address PR review feedback"
git push
```

Report to user: total fixes by priority, files modified. Then auto-chain to `/exarchos:synthesize` for merge confirmation.

### Handling Missing CodeRabbit Comments

If no CodeRabbit comments found, proceed with human comments only.
