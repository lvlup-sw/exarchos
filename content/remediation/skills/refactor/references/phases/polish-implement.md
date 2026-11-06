# Polish Track: Implement Phase

## Purpose

Direct implementation for small, well-scoped refactors. This phase allows the orchestrator to write code directly without delegation to subagents, reducing ceremony while maintaining quality.

## Orchestrator Exception

**This is the explicit exception to orchestrator constraints.**

The orchestrator constraints in `rules/orchestrator-constraints.md` state the orchestrator MUST NOT write implementation code. The polish track implement phase is the one case where this rule is intentionally violated.

### Why This Exception Exists

| Standard Workflow | Polish Track |
|-------------------|--------------|
| Delegation overhead justified | Overhead exceeds value for small changes |
| Context window preserved for coordination | Small changes fit within session |
| Parallel execution via worktrees | Sequential execution sufficient |
| Subagent isolation for testing | Direct testing in main branch |

### When the Exception Applies

The orchestrator may write code directly ONLY when ALL conditions are met:

1. **Track is polish** - State file shows `.track = "polish"`
2. **Brief is captured** - Phase has advanced to "implement"
3. **Scope is limited** - 5 or fewer files affected
4. **Single concern** - One refactoring goal per session
5. **Tests exist** - Affected code has test coverage

If any condition is violated, switch to overhaul track.

## Entry Conditions

Before starting implementation, verify prerequisites:

**Check track:**
```
action: "get", featureId: "refactor-<slug>", query: "track"
```
Must return: `{ "track": "polish" }`

**Check phase:**
```
action: "get", featureId: "refactor-<slug>", query: "phase"
```
Must return: `{ "phase": "polish-implement" }`

**Check goals:**
```
action: "get", featureId: "refactor-<slug>", query: "brief.goals"
```
Must return: `{ "brief.goals": [...] }` with a populated array. A path that resolves to nothing returns `{}`.

### State Requirements

| Field | Requirement |
|-------|-------------|
| `.track` | "polish" |
| `.phase` | "polish-implement" |
| `.brief.problem` | Non-empty string |
| `.brief.goals` | 1-3 items |
| `.brief.affectedAreas` | 1-5 files |
| `.brief.successCriteria` | 2-3 items |
| `.explore.scopeAssessment.testCoverage` | "good" or "gaps" (not "none") |

## Implementation Process

### Step 1: Pre-Implementation Verification

Run the full test suite before making any changes:

```bash
npm run test:run
```

**Gate:** Tests must pass. If tests fail before implementation, stop and investigate. Do not implement on top of a failing test suite.

**Record baseline:**

```
action: "update", featureId: "refactor-<slug>", updates: {
  "implement": {
    "startedAt": "<ISO8601>",
    "baselineTestsPass": true,
    "changesLog": []
  }
}
```

### Step 2: Make Changes Incrementally

For each logical change:

1. **Understand the change** - Read affected code
2. **Update tests** (if behavior changes) - test-after is fine; ensure they can fail
3. **Make the change** - Minimal modification
4. **Run tests** - Verify no regression
5. **Commit** - Atomic commit for the change

```bash
# After each change
npm run test:run

# Commit changes
git add <files>
git commit -m "refactor: <description>"
```

After all changes are complete:
```bash
git push -u origin refactor/<brief-name>
```

**Log change:**

```
action: "update", featureId: "refactor-<slug>", updates: {
  "implement.changesLog": [{"file": "<path>", "description": "<what changed>"}]
}
```

### Step 3: Test After Each Change

**Critical:** Run tests after EVERY change, not just at the end.

| Test Failure | Action |
|--------------|--------|
| Test fails after change | Revert and retry with smaller change |
| Unrelated test fails | Stop, investigate, may need track switch |
| Lint/type error | Fix before proceeding |

### Step 4: Verify Goals

After all changes, verify each goal from brief:

```
action: "get", featureId: "refactor-<slug>", query: "brief.goals"
```

The goals are the array under the `brief.goals` key of the response `data`.

For each goal, confirm it's addressed. If a goal cannot be addressed within polish scope, trigger track switch.

## Scope Monitoring

### Red Flags During Implementation

Watch for these indicators that polish is insufficient:

| Signal | Description | Threshold |
|--------|-------------|-----------|
| File count growing | Started with 3 files, now touching 6+ | >5 files |
| Test gaps discovered | Affected code lacks tests | Need >2 new test files |
| Cascading changes | Change in one file requires changes in many | >3 unexpected files |
| Architecture concerns | Structure questions beyond scope | Needs design document |
| Duration | Implementation taking too long | >1 hour of changes |

### Monitoring Commands

```bash
# Check files changed
git diff --name-only HEAD~N  # where N = commits since implement started

# Count affected files
git diff --stat
```

### When to Stop

**Stop implementation immediately if:**

- More than 5 files need modification
- You discover test coverage is "none" (not "gaps")
- Multiple unrelated concerns emerge
- You're writing more than 100 lines of new code
- Changes require updates to public APIs

## Track Switching

### Detection

If scope expands beyond polish limits during implementation:

```bash
echo "Scope has expanded beyond polish limits."
echo "Files affected: $(git diff --name-only | wc -l)"
echo "Switching to overhaul track recommended."
```

### Switch Protocol

1. **Commit current work** - Don't lose progress
2. **Record the switch reason:**

```
action: "update", featureId: "refactor-<slug>", updates: {
  "implement.switchReason": "<reason for switch>",
  "implement.switchedAt": "<ISO8601>"
}
```

3. **Stop and ask the user.** The HSM has no edge from `polish-implement` to `overhaul-plan`, so `transition` cannot change the track after `brief`.
4. **To continue on the overhaul track**, `cancel` this workflow and start a new refactor workflow. Select the overhaul track in its `explore` phase.

### Output to User

```text
Scope has expanded beyond polish limits.
Reason: [specific reason]

The polish track cannot switch to overhaul after the brief. Options:
- Cancel this workflow and start a new refactor on the overhaul track
- Reduce the scope and continue on the polish track

Current progress has been committed. Which option?
```

## State Updates

### Implementation Start

**Record baseline:**

```
action: "update", featureId: "refactor-<slug>", updates: {
  "implement": {
    "startedAt": "<ISO8601>",
    "baselineTestsPass": true,
    "changesLog": []
  }
}
```

### After Each Change

**Log change:**

```
action: "update", featureId: "refactor-<slug>", updates: {
  "implement.changesLog": [
    {"file": "<path>", "description": "<what changed>", "commitSha": "<short-sha>"}
  ]
}
```

Note: For array appends, the MCP tool handles merging with existing array entries.

### Implementation Complete

**Record completion, then advance to validate:**

```
action: "update", featureId: "refactor-<slug>", updates: {
  "implement.completedAt": "<ISO8601>",
  "implement.totalFiles": <count>,
  "implement.totalCommits": <count>
}
action: "transition", featureId: "refactor-<slug>", target: "polish-validate"
```

### Track Switch (if needed)

**Record the switch reason, then stop and ask the user:**

```
action: "update", featureId: "refactor-<slug>", updates: {
  "implement.switchReason": "<reason>",
  "implement.switchedAt": "<ISO8601>"
}
```

No `transition` follows. The HSM has no edge from `polish-implement` to `overhaul-plan`.

## Exit Conditions

Implementation phase exits when:

### Success Exit -> Validate Phase

- All changes from brief are implemented
- All tests pass
- No scope expansion occurred
- Less than or equal to 5 files changed

**Advance to validate:**

```
action: "transition", featureId: "refactor-<slug>", target: "polish-validate"
```

Next action: `AUTO:polish-validate`

### Scope Expansion Exit -> Ask the User

- Scope expanded beyond polish limits
- Switch reason recorded (see Track Switch above)
- Current work committed

The HSM has no edge from `polish-implement` to `overhaul-plan`. The workflow stays in `polish-implement` until the user chooses: reduce the scope, or `cancel` and start a new refactor on the overhaul track.

Next action: ask the user

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Make all changes then test | Test after each change |
| Skip commits for "small" changes | Commit each logical change |
| Ignore expanding scope | Stop and switch tracks |
| Fix unrelated issues found | Note for separate refactor |
| Skip baseline test run | Always verify green baseline |
| Force polish when overhaul needed | Accept track switch gracefully |

## Example Implementation Session

```text
[Phase: implement]

1. Running baseline tests...
   Tests: 42 passed

2. Change 1: Extract validation to UserValidator
   - Created: src/validators/user-validator.ts
   - Modified: src/services/user-service.ts
   - Tests: 42 passed
   - Committed: abc123

3. Change 2: Update UserService imports
   - Modified: src/services/user-service.ts
   - Tests: 42 passed
   - Committed: def456

4. Verifying goals:
   [x] Extract validation logic into separate UserValidator class
   [x] Reduce UserService line count

5. Files changed: 2 (within limit)

6. Transitioning to validate phase...
```
