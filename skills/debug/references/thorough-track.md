---
name: thorough-track
---

# Thorough Track

## Purpose

Fix bugs with proper rigor. Capture institutional knowledge through RCA.

## Phases

```
Triage -> Investigate -> RCA -> Design -> Implement -> Review -> Synthesize -> Completed
  |          |          |       |         |          |          |           |
  |          |          |       |         |          |          |           +- Merge
  |          |          |       |         |          |          +- Create PR
  |          |          |       |         |          +- Spec review only
  |          |          |       |         +- TDD in worktree
  |          |          |       +- Brief fix approach
  |          |          +- Full RCA document
  |          +- Systematic investigation
  +- Capture symptom, select track
```

## Phase Details

### 1. Triage Phase

Same as hotfix, but set track to "thorough":

**Set track and advance to investigate:**

```
action: "set", featureId: "debug-<issue-slug>", updates: {
  "track": "thorough"
}, phase: "investigate"
```

### 2. Investigate Phase

Use `@skills/debug/references/investigation-checklist.md`.

No time limit. Be thorough:
- Use Task tool with Explore agent for complex investigation
- Document all findings
- Understand the full picture before proposing fix

### 3. RCA Phase

Create RCA document using `@skills/debug/references/rca-template.md`.

Save to: `docs/rca/YYYY-MM-DD-<issue-slug>.md`

Update state:

**Record RCA artifact and advance to design:**

```
action: "set", featureId: "debug-<issue-slug>", updates: {
  "artifacts.rca": "docs/rca/YYYY-MM-DD-<issue-slug>.md"
}, phase: "design"
```

### 4. Design Phase

Brief fix approach (NOT a full design document).

2-3 paragraphs max in state file:

**Record fix design and advance to implement:**

```
action: "set", featureId: "debug-<issue-slug>", updates: {
  "artifacts.fixDesign": "<fix approach description>"
}, phase: "implement"
```

### 5. Implement Phase

Create worktree and implement with TDD:

```bash
# Create worktree
git branch feature/debug-<issue-slug> main
git worktree add .worktrees/debug-<issue-slug> feature/debug-<issue-slug>
cd .worktrees/debug-<issue-slug> && npm install

# TDD: Write failing test first, then implement
```

Update state:

**Record worktree and advance to review:**

```
action: "set", featureId: "debug-<issue-slug>", updates: {
  "worktrees.\".worktrees/debug-<issue-slug>\"": {
    "branch": "feature/debug-<issue-slug>",
    "status": "active"
  }
}, phase: "review"
```

### 6. Review Phase

Spec review only (not quality review - this is a fix, not new feature).

Run the debug review gate to verify test coverage for the bug fix:

```typescript
exarchos_orchestrate({
  action: "run_script",
  script: "debug-review-gate.sh",
  args: ["--repo-root", "<path>", "--base-branch", "<branch>"]
})
```

**On `passed: true`:** Review passed -- tests added and passing.
**On `passed: false`:** Gaps found -- missing tests or regressions.

Additionally verify:
- [ ] Fix matches RCA root cause
- [ ] Fix matches design approach

Update state:

**Advance to synthesize:**

```
action: "set", featureId: "debug-<issue-slug>", phase: "synthesize"
```

### 7. Synthesize Phase

Create PR via GitHub CLI:

```bash
# Stage, commit, and push
git add <fixed-files>
git commit -m "fix: <issue summary>"
git push -u origin <branch-name>

# Create PR and enable auto-merge
gh pr create --base main --title "fix: <issue summary>" --body "<pr-body>"
gh pr merge <number> --auto --squash
```

Then update the PR description:
```bash
gh pr edit <number> --body "## Summary
[Brief description]

## Root Cause Analysis
See: docs/rca/YYYY-MM-DD-<issue-slug>.md

## Changes
- [change 1]

## Test Plan
- [test approach]"
```

> Or use GitHub MCP `update_pull_request` if available.

**Human checkpoint:** Confirm merge.

## Track Switching

### Hotfix -> Thorough

When `exarchos_orchestrate({ action: "run_script", script: "investigation-timer.sh" })` returns `passed: false` (budget exceeded), switch to thorough track:

**Switch to thorough track:**

```
action: "set", featureId: "debug-<issue-slug>", updates: {
  "track": "thorough",
  "investigation.findings": ["Switched to thorough track: root cause not found in 15 min"]
}
```

Continue investigation without time constraint.

### Thorough -> Escalate

If fix requires architectural changes:

**Escalate to blocked:**

```
action: "set", featureId: "debug-<issue-slug>", updates: {
  "investigation.findings": ["Escalated: requires architectural changes"]
}, phase: "blocked"
```

Output to user:
> This issue requires architectural changes that exceed bug fix scope.
> Recommend running `/exarchos:ideate` to design the solution properly.
>
> Context preserved in: `<state-file>`
