---
name: thorough-track
---

# Thorough Track

## Purpose

Fix bugs with proper rigor. Capture institutional knowledge through RCA.

## Phases

```
triage -> investigate -> rca -> design -> debug-implement -> debug-validate -> debug-review -> synthesize -> completed
  |          |           |       |         |                  |                 |                |
  |          |           |       |         |                  |                 |                +- Merge
  |          |           |       |         |                  |                 +- Create PR
  |          |           |       |         |                  +- Spec review only
  |          |           |       |         +- TDD in worktree
  |          |           |       +- Brief fix approach
  |          |           +- Full RCA document
  |          +- Systematic investigation
  +- Capture symptom, select track
```

## Phase Details

### 1. Triage Phase

Same as hotfix, but set track to "thorough":

**Set track and advance to investigate:**

Call `exarchos_workflow({ action: "describe", playbook: "debug" })` for the `triage → investigate` guard requirements, then `set` the track to `"thorough"` and phase.

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

Call `exarchos_workflow({ action: "describe", playbook: "debug" })` for the `rca → design` guard requirements, then `set` the required fields (artifacts.rca) and phase.

### 4. Design Phase

Brief fix approach (NOT a full design document).

2-3 paragraphs max in state file:

**Record fix design and advance to implement:**

Call `exarchos_workflow({ action: "describe", playbook: "debug" })` for the `design → debug-implement` guard requirements, then `set` the required fields (artifacts.fixDesign) and phase.

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

**Record worktree and advance to validate:**

Call `exarchos_workflow({ action: "describe", playbook: "debug" })` for the `debug-implement → debug-validate` guard requirements, then `set` the required fields (worktrees) and phase.

### 6. Review Phase

Spec review only (not quality review - this is a fix, not new feature).

Run the debug review gate to verify test coverage for the bug fix:

```typescript
exarchos_orchestrate({
  action: "debug_review_gate",
  repoRoot: "<path>",
  baseBranch: "<branch>"
})
```

**On `passed: true`:** Review passed -- tests added and passing.
**On `passed: false`:** Gaps found -- missing tests or regressions.

Additionally verify:
- [ ] Fix matches RCA root cause
- [ ] Fix matches design approach

Update state:

**Advance to synthesize:**

Call `exarchos_workflow({ action: "describe", playbook: "debug" })` for the `debug-review → synthesize` guard requirements, then `set` the phase.

### 7. Synthesize Phase

Create PR via GitHub CLI:

```bash
# Stage, commit, and push
git add <fixed-files>
git commit -m "fix: <issue summary>"
git push -u origin <branch-name>

# Create PR and enable auto-merge
```

```typescript
exarchos_orchestrate({ action: "create_pr", base: "main", head: "<branch-name>", title: "fix: <issue summary>", body: "<pr-body>" })
exarchos_orchestrate({ action: "merge_pr", prId: "<number>", strategy: "squash" })
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

When `exarchos_orchestrate({ action: "investigation_timer" })` returns `passed: false` (budget exceeded), switch to thorough track:

**Switch to thorough track:**

Call `exarchos_workflow({ action: "describe", playbook: "debug" })` for the field shapes, then `set` the track to `"thorough"` and record the switch reason in `investigation.findings`.

Continue investigation without time constraint.

### Thorough -> Escalate

If fix requires architectural changes:

**Escalate to blocked:**

Call `exarchos_workflow({ action: "describe", playbook: "debug" })` for the guard requirements, then `set` the investigation findings and phase to `"blocked"`.

Output to user:
> This issue requires architectural changes that exceed bug fix scope.
> Recommend running `/exarchos:ideate` to design the solution properly.
>
> Context preserved in: `<state-file>`
