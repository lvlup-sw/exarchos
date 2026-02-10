---
description: Dispatch tasks to Claude Code subagents
---

# Delegate

Delegate tasks for: "$ARGUMENTS"

## Workflow Position

```
/ideate → [CONFIRM] → /plan → /delegate → /integrate → /review → /synthesize → [CONFIRM] → merge
                                 ▲▲▲▲▲▲▲▲                                            │
                                    │                                                │
                      ON FAIL ──────┤                                                │
                      --pr-fixes ───┴────────────────────────────────────────────────┘
```

Auto-invokes `/integrate` after tasks complete (or `/synthesize` for `--pr-fixes` mode).

## Invocation Modes

| Flag | Source | Use Case |
|------|--------|----------|
| (none) | Implementation plan | Initial task delegation |
| `--fixes` | Review issues | Address spec/quality failures |
| `--pr-fixes` | PR comments | Address human review feedback |

## Skill References

- Delegation skill: `@skills/delegation/SKILL.md`
- Git worktrees: `@skills/git-worktrees/SKILL.md`
- Implementer template: `@skills/delegation/references/implementer-prompt.md`

## Delegation Mode

### Task Tool (Subagents)
```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",  // REQUIRED for coding
  description: "Task description",
  prompt: "[Full implementer prompt]"
})
```

## Process

### Step 1: Set Up Worktrees
For parallel tasks:
```bash
git worktree add .worktrees/task-001 feature/task-001
cd .worktrees/task-001 && npm install
npm run test:run  # Baseline verification
```

### Step 2: Extract Task Details
From implementation plan, extract:
- Full task description
- Files to create/modify
- Test requirements
- Success criteria

### Step 3: Track Progress
Use TodoWrite to track all delegated tasks.

### Step 4: Dispatch
- Provide FULL task text (never file references)
- Include TDD requirements
- Specify working directory
- Use `model: "opus"` for coding

### Step 5: Monitor
- Task tool: `TaskOutput`

### Step 6: Schema Sync (Auto)
After all tasks complete, auto-detect if API files were modified:
```bash
git diff --name-only origin/main...HEAD | grep -E "(Endpoints|Models|Dtos).*\.cs$"
```

If matches found, run `npm run sync:schemas` and commit generated files.

See: `@skills/sync-schemas/SKILL.md`

## Parallel Execution

Launch parallel tasks in SINGLE message:
```typescript
Task({ model: "opus", description: "Task 001", prompt: "..." })
Task({ model: "opus", description: "Task 002", prompt: "..." })
```

## PR Feedback Mode (--pr-fixes)

When invoked with `--pr-fixes [PR_URL]`:

### Priority Levels

| Priority | Source | Description |
|----------|--------|-------------|
| 1 | `coderabbit:critical` | 🔴 Critical issues + SPEC COMPLIANCE failures |
| 2 | `human` | Human reviewer comments (authority over automation) |
| 3 | `coderabbit:major` | 🟠 Major issues + CODE QUALITY HIGH items |
| 4 | `coderabbit:minor` | 🟡 Minor issues |

### Step 1: Fetch All PR Feedback

```typescript
// Extract owner, repo, PR number from URL
// Get full PR details including reviews and comments
mcp__plugin_github_github__pull_request_read({
  owner: "<owner>",
  repo: "<repo>",
  pullNumber: <number>
})

// Get issue-level comments (pre-merge check summaries)
mcp__plugin_github_github__issue_read({
  owner: "<owner>",
  repo: "<repo>",
  issueNumber: <number>
})
```

### Step 2: Parse CodeRabbit Feedback

**2a: Identify CodeRabbit comments** by author = `coderabbitai[bot]`

**2b: Parse line comments by severity label:**

| Label | Priority |
|-------|----------|
| `🔴 Critical` | 1 |
| `🟠 Major` | 2 |
| `🟡 Minor` | 3 |

Extract from each comment:
- Severity label (emoji + text)
- File path and line number
- Issue description
- Suggested fix (from `🔎 Proposed fix` section if present)

**2c: Parse pre-merge check summaries:**
- `Status: FAIL` in Spec Review → Priority 1
- `Status: NEEDS_FIXES | BLOCKED` in Quality Review → Priority 2
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
| `severity` | `"🔴 Critical"`, `"🟠 Major"`, `"🟡 Minor"`, or null |
| `file` | File path |
| `line` | Line number (if line comment) |
| `issue` | Problem description |
| `action` | Required change / suggested fix |

### Step 5: Sort and Display Fix Tasks

Sort by priority (1→4), then by file path for grouping.

Display summary:
```markdown
## PR Fix Tasks (N total)

### Priority 1: Critical 🔴 (count)
- fix-001: [issue] in [file:line]

### Priority 2: Human Feedback (count)
- fix-002: [issue] from @reviewer

### Priority 3: Major 🟠 (count)
- fix-003: [issue] in [file:line]

### Priority 4: Minor 🟡 (count)
- fix-004: [issue] in [file:line]
```

### Step 6: Track Fix Tasks

```typescript
TodoWrite({
  todos: [
    { content: "Fix 001 [P1 🔴]: Division by zero", status: "pending", activeForm: "Fixing division by zero" },
    { content: "Fix 002 [P2 HUMAN]: Reviewer suggestion", status: "pending", activeForm: "Addressing feedback" },
    { content: "Fix 003 [P3 🟠]: Missing validation", status: "pending", activeForm: "Adding validation" },
    { content: "Fix 004 [P4 🟡]: Naming convention", status: "pending", activeForm: "Fixing naming" },
  ]
})
```

### Step 7: Dispatch Fixes (MANDATORY - Priority Order)

**You MUST spawn subagents for each fix task, processing in priority order.**

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
  model: "opus",  // REQUIRED for code changes
  description: "Fix [P{priority} {severity}]: {issue summary}",
  prompt: `
# Task: Fix PR Feedback - {issue summary}

## Priority
{priority} - {source}
- P1 = 🔴 Critical (blocking)
- P2 = Human feedback (authority)
- P3 = 🟠 Major
- P4 = 🟡 Minor

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

**For parallel fixes within a priority level:**
```typescript
// CORRECT: Single message with multiple tasks
Task({ model: "opus", description: "Fix [P1 🔴]: ...", prompt: "..." })
Task({ model: "opus", description: "Fix [P1 🔴]: ...", prompt: "..." })
```

**CHECKPOINT:** Do NOT proceed to Step 8 until all fixes in the current priority level have completed.

### Step 8: Monitor Completion

For Task tool:
```typescript
TaskOutput({ task_id: "[task-id]", block: true })
```

Update TodoWrite as each fix completes.

### Step 9: Push and Report

After all fixes complete:
```bash
git add -A && git commit -m "fix: address PR review feedback

Fixes:
- P1 Critical: [count] issues
- P2 Human: [count] items
- P3 Major: [count] issues
- P4 Minor: [count] issues"
git push origin [branch]
```

Report to user:
- Total fixes applied by priority
- Files modified
- Suggest requesting re-review

Then auto-chain back to `/synthesize` for merge confirmation.

### Handling Missing CodeRabbit Comments

If no CodeRabbit comments found:
```
Note: No CodeRabbit feedback found. Processing human reviewer comments only.
Possible reasons:
- CodeRabbit not configured for this repository
- Pre-merge checks haven't completed yet
- PR has no code changes (documentation-only)
```

Proceed with human comments (Priority 4) only.

## Output

Track the plan path used for delegation as `$PLAN_PATH`.

## Idempotency

Before delegating, check task status:
1. Read tasks from state file
2. Skip tasks where `status == "complete"`
3. Only dispatch pending/failed tasks
4. If all tasks already complete, skip to auto-chain

## Auto-Chain

After all delegated tasks complete, **auto-continue immediately** (no user confirmation needed).

### For normal delegation and --fixes mode:

1. Update state: `.phase = "integrate"` and mark all tasks complete
2. Output: "All [N] tasks complete. Auto-continuing to integration..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "integrate", args: "$STATE_FILE" })
   ```

### For --pr-fixes mode:

Human review already happened - skip automated review and return to merge confirmation.

1. Update state: `.phase = "synthesize"` and mark all fixes complete
2. Output: "All [N] fixes applied and pushed. Returning to merge confirmation..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "synthesize", args: "$PR_URL" })
   ```

**No pause for user input** - this is not a human checkpoint.

State is saved automatically, enabling recovery after context compaction.
