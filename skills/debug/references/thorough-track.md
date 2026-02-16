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

```
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: { "track": "thorough" }
  phase: "investigate"
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

```
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: { "artifacts.rca": "docs/rca/YYYY-MM-DD-<issue-slug>.md" }
  phase: "design"
```

### 4. Design Phase

Brief fix approach (NOT a full design document).

2-3 paragraphs max in state file:

```
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: { "artifacts.fixDesign": "<fix approach description>" }
  phase: "implement"
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

```
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: {
    "worktrees.\".worktrees/debug-<issue-slug>\"": {
      "branch": "feature/debug-<issue-slug>",
      "status": "active"
    }
  }
  phase: "review"
```

### 6. Review Phase

Spec review only (not quality review - this is a fix, not new feature).

Run the debug review gate to verify test coverage for the bug fix:

```bash
scripts/debug-review-gate.sh --repo-root <path> --base-branch <branch>
```

**On exit 0:** Review passed -- tests added and passing.
**On exit 1:** Gaps found -- missing tests or regressions.

Additionally verify:
- [ ] Fix matches RCA root cause
- [ ] Fix matches design approach

Update state:

```
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  phase: "synthesize"
```

### 7. Synthesize Phase

Create PR via Graphite MCP:

```
# Stage and create branch with fix commit
mcp__graphite__run_gt_cmd({ args: ["create", "-m", "fix: <issue summary>"], cwd: "<repo-root>" })

# Submit to create the PR
mcp__graphite__run_gt_cmd({ args: ["submit", "--no-interactive", "--publish", "--merge-when-ready"], cwd: "<repo-root>" })
```

Then update the PR description using GitHub MCP:
```
mcp__plugin_github_github__update_pull_request({
  owner, repo, pullNumber,
  body: "## Summary\n[Brief description]\n\n## Root Cause Analysis\nSee: docs/rca/YYYY-MM-DD-<issue-slug>.md\n\n## Changes\n- [change 1]\n\n## Test Plan\n- [test approach]"
})
```

**Human checkpoint:** Confirm merge.

## Track Switching

### Hotfix -> Thorough

When `scripts/investigation-timer.sh` exits with code 1 (budget exceeded), switch to thorough track:

```
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: {
    "track": "thorough",
    "investigation.findings": ["Switched to thorough track: root cause not found in 15 min"]
  }
```

Continue investigation without time constraint.

### Thorough -> Escalate

If fix requires architectural changes:

```
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: { "investigation.findings": ["Escalated: requires architectural changes"] }
  phase: "blocked"
```

Output to user:
> This issue requires architectural changes that exceed bug fix scope.
> Recommend running `/ideate` to design the solution properly.
>
> Context preserved in: `<state-file>`
