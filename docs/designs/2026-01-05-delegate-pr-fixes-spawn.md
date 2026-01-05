# Design: Ensure /delegate --pr-fixes Spawns Subagents

## Problem Statement

When running `/delegate --pr-fixes "<PR_URL>"` directly, Claude fetches and parses PR comments but never actually spawns Task or Jules tools to dispatch the fix tasks. The existing documentation describes *what* should happen but lacks imperative language and code examples that ensure subagents are actually invoked.

## Root Cause

The `--pr-fixes` section in `commands/delegate.md` (lines 94-119) contains:

```markdown
### Step 4: Dispatch and Verify
- Dispatch fixes to subagents
- Push changes to integration branch
- Return to `/synthesize` for merge confirmation
```

This is too vague. Claude interprets "dispatch fixes to subagents" as descriptive rather than a mandatory action requiring tool invocation.

Compare to the normal delegation flow which explicitly shows `Task({...})` code blocks that Claude recognizes as required tool calls.

## Solution

Enhance the `--pr-fixes` section of `commands/delegate.md` with:

1. **Structured fix task format** - Clear template for transforming PR comments into dispatchable tasks
2. **Explicit Task/Jules invocation code** - Concrete examples that must be executed
3. **Mandatory dispatch checkpoint** - Language that prevents proceeding without confirming tool calls

## Design

### Enhanced --pr-fixes Section

Replace `commands/delegate.md` lines 94-119 with the following:

```markdown
## PR Feedback Mode (--pr-fixes)

When invoked with `--pr-fixes [PR_URL]`:

### Step 1: Fetch PR Comments
```bash
# Extract owner, repo, PR number from URL
gh pr view [PR_NUMBER] --repo [OWNER/REPO] --comments --json comments,reviews,body
gh api repos/{owner}/{repo}/pulls/{number}/comments
```

### Step 2: Parse Feedback into Fix Tasks

For each actionable comment, create a structured fix task:

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (e.g., `fix-001`) |
| `source` | Comment ID or review ID |
| `file` | File path mentioned (if any) |
| `line` | Line number mentioned (if any) |
| `issue` | What's wrong (from reviewer) |
| `action` | What needs to change |

Skip comments that are:
- Purely praise/acknowledgment
- Questions without action items
- Already resolved

### Step 3: Track Fix Tasks

```typescript
TodoWrite({
  todos: [
    { content: "Fix 001: [issue summary]", status: "pending", activeForm: "Fixing [issue]" },
    // ... one entry per fix task
  ]
})
```

### Step 4: Dispatch Fixes (MANDATORY)

**You MUST spawn subagents for each fix task.** This step is not optional.

**Option A: Task Tool (for local repo access)**
```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",  // REQUIRED for code changes
  description: "Fix: [issue summary]",
  prompt: `
# Task: Fix PR Feedback - [issue summary]

## Context
PR: [PR_URL]
Reviewer comment: "[original comment text]"

## Working Directory
[absolute path to repo]

## Fix Required
File: [file path]
Line: [line number if applicable]
Issue: [what's wrong]
Action: [what to change]

## TDD Requirements
1. Write a test that would catch this issue (if applicable)
2. Verify test fails
3. Implement the fix
4. Verify test passes

## Success Criteria
- [ ] Issue addressed per reviewer feedback
- [ ] Tests pass
- [ ] No regressions introduced
`
})
```

**Option B: Jules (for async execution)**
```typescript
jules_create_task({
  repo: "[owner/repo]",
  branch: "[PR branch name]",
  prompt: "[Same structured prompt as above]"
})
```

**For parallel fixes:** Launch multiple Task tools in a single message:
```typescript
// CORRECT: Single message with multiple tasks
Task({ model: "opus", description: "Fix 001: ...", prompt: "..." })
Task({ model: "opus", description: "Fix 002: ...", prompt: "..." })
```

**CHECKPOINT:** Do NOT proceed to Step 5 until you have confirmed that Task or jules_create_task tools have been invoked for EVERY fix task identified in Step 2.

### Step 5: Monitor Completion

For Task tool:
```typescript
TaskOutput({ task_id: "[task-id]", block: true })
```

For Jules:
```typescript
jules_check_status({ sessionId: "[session-id]" })
```

Update TodoWrite as each fix completes.

### Step 6: Push and Report

After all fixes complete:
```bash
git add -A && git commit -m "fix: address PR review feedback"
git push origin [branch]
```

Report to user:
- Number of fixes applied
- Files modified
- Suggestion to request re-review

Then auto-chain back to `/synthesize` for merge confirmation.
```

## Changes Required

| File | Change |
|------|--------|
| `commands/delegate.md` | Replace lines 94-119 with enhanced --pr-fixes section |

## Testing

After implementation, verify by running:
```
/delegate --pr-fixes "https://github.com/lvlup-sw/agentic-engine/pull/5"
```

Expected behavior:
1. PR comments are fetched
2. Actionable items are parsed
3. **Task or jules_create_task tools are invoked** (the fix)
4. Fixes are applied
5. Changes are pushed

## Alternatives Considered

### Create separate skills/pr-fixes/SKILL.md

Rejected because:
- `--pr-fixes` is a mode of delegation, not a separate workflow
- Would create discovery issues (Claude may not load the skill file)
- Increases surface area without proportional benefit

### Add hook to enforce dispatch

Rejected because:
- Hooks run post-tool-call, can't enforce tool invocation
- Design should be self-enforcing through clear instructions
