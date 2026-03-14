# Brief Phase

## Purpose

Capture refactoring intent in a structured format without the overhead of a full design document.

## Entry Conditions

- Explore phase complete
- Track selected (polish or overhaul)
- Scope assessment available in state

## Brief Structure

The brief captures these required fields:

### 1. Problem Statement

**What's wrong with the current code?** Be specific and measurable.

Good examples:
- "UserService class has grown to 500 lines with authentication, validation, and persistence mixed together"
- "The payment module uses 4 different error handling patterns inconsistently"
- "Test setup duplicated across 12 test files with slight variations"

Bad examples:
- "Code is messy"
- "Need to clean things up"
- "Could be better"

### 2. Goals

**What specific outcomes will this refactor achieve?** Each goal must be verifiable.

Good goals:
- "Extract validation into UserValidator class (<100 lines)"
- "Consolidate error handling to single pattern using Result type"
- "Create shared TestFixtures reducing setup duplication by 80%"

Bad goals:
- "Improve code quality"
- "Make it cleaner"
- "Better organization"

### 3. Approach

**How will you achieve the goals?** High-level strategy.

Polish approach (1-2 sentences):
- "Extract methods, create new class, update callers"

Overhaul approach (phases):
- "Phase 1: Create adapter for new pattern alongside old"
- "Phase 2: Migrate internal callers"
- "Phase 3: Migrate external callers"
- "Phase 4: Remove old pattern"

### 4. Affected Areas

**Specific paths that will change.** From explore phase.

### 5. Out of Scope

**What you're explicitly NOT changing.** Prevents scope creep.

Examples:
- "Not changing the public API"
- "Not addressing performance issues"
- "Not updating unrelated tests"

### 6. Success Criteria

**How will you verify the refactor is complete?**

- All existing tests pass
- New tests added for [specific areas]
- [Goal 1] achieved (measurable)
- No new linting errors
- Documentation updated

### 7. Docs to Update

**Documentation that needs updating.** From explore phase.

## Brief Depth by Track

| Field | Polish | Overhaul |
|-------|--------|----------|
| Problem | 1-2 sentences | Paragraph with context |
| Goals | 1-3 items | 3-5 items |
| Approach | 1-2 sentences | Phases described |
| Out of Scope | 1-2 items | 3+ items |
| Success Criteria | 2-3 items | 4+ items |

## Interactive Capture

When in brief phase, prompt user for each field if not provided:

```
## Refactor Brief

Based on exploration, preparing brief for <polish|overhaul> track.

**Problem:** <from user or prompt>
**Goals:** <from user or prompt>
...
```

## State Update

**Save brief and advance:**

```
action: "set", featureId: "refactor-<slug>", updates: {
  "brief": {
    "problem": "<problem statement>",
    "goals": ["<goal 1>", "<goal 2>"],
    "approach": "<approach description>",
    "affectedAreas": ["<from explore>"],
    "outOfScope": ["<exclusion 1>"],
    "successCriteria": ["<criterion 1>"],
    "docsToUpdate": ["<from explore>"],
    "capturedAt": "<ISO8601>"
  }
}, phase: "<polish-implement|overhaul-plan>"
```

Phase transitions:
- Polish track -> `polish-implement`
- Overhaul track -> `overhaul-plan`

## Validation

Before proceeding, validate brief completeness:

```
Required fields check:
[x] Problem: defined
[x] Goals: at least 1
[x] Approach: defined
[x] Affected areas: from explore
[x] Out of scope: at least 1
[x] Success criteria: at least 2
[x] Docs to update: from explore (can be empty)
```

If validation fails, prompt for missing fields.

## Exit Conditions

- All required fields captured
- Brief stored in state
- Phase transitioned appropriately:
  - Polish -> implement
  - Overhaul -> plan

## Transition

After brief is captured, auto-continue to next phase:

### Polish Track

1. Update state: `.phase = "polish-implement"`
2. Output: "Brief captured. Auto-continuing to implementation..."
3. Continue with implement phase inline (no Skill invocation - orchestrator implements directly)

### Overhaul Track

1. Update state: `.phase = "overhaul-plan"`
2. Output: "Brief captured. Auto-continuing to planning..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "exarchos:plan", args: "--refactor ~/.claude/workflow-state/<feature>.state.json" })
   ```

This is NOT a human checkpoint - workflow continues autonomously.
