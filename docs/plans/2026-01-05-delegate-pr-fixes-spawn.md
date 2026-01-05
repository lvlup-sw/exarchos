# Implementation Plan: Delegate PR-Fixes Subagent Spawn

## Source Design
Link: `docs/designs/2026-01-05-delegate-pr-fixes-spawn.md`

## Summary
- Total tasks: 1
- Type: Documentation edit (no TDD - markdown only)
- Parallel groups: N/A

## Task Breakdown

### Task 001: Replace --pr-fixes section in delegate.md

**Type:** Documentation edit

**File:** `commands/delegate.md`

**Change:** Replace lines 94-119 (current `## PR Feedback Mode (--pr-fixes)` section) with the enhanced version from the design document.

**Current content (lines 94-119):**
```markdown
## PR Feedback Mode (--pr-fixes)

When invoked with `--pr-fixes [PR_URL]`:

### Step 1: Fetch PR Comments
...
### Step 4: Dispatch and Verify
- Dispatch fixes to subagents
- Push changes to integration branch
- Return to `/synthesize` for merge confirmation
```

**New content:** Enhanced section with:
1. Structured fix task format table
2. TodoWrite tracking step
3. **Explicit Task/Jules dispatch code blocks** (the fix)
4. Mandatory checkpoint language
5. Monitor completion step
6. Push and report step

**Dependencies:** None
**Parallelizable:** N/A (single task)

## Verification

After implementation, verify by:
1. Running `/delegate --pr-fixes "https://github.com/lvlup-sw/agentic-engine/pull/5"`
2. Confirming Claude:
   - Fetches PR comments
   - Parses actionable items
   - **Actually invokes Task or jules_create_task tools** (the fix)
   - Applies fixes
   - Pushes changes

## Completion Checklist
- [ ] Lines 94-119 of delegate.md replaced
- [ ] New section includes explicit Task() code block
- [ ] New section includes mandatory checkpoint language
- [ ] Manual verification passes
