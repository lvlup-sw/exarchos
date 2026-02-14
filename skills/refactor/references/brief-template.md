# Refactor Brief Template

## Purpose

The brief captures refactor intent without the overhead of a full design document. Store in workflow state, not as a separate file.

## Brief Fields

### Problem (Required)
What's wrong with the current code? Be specific.

**Polish example:** "The UserService class has grown to 500 lines with mixed responsibilities"

**Overhaul example:** "The authentication module uses callbacks throughout, making error handling inconsistent and testing difficult"

### Goals (Required)
List specific, measurable goals. Each goal should be verifiable.

**Good goals:**
- Extract validation logic into separate UserValidator class
- Convert callback-based auth to async/await pattern
- Reduce cyclomatic complexity of processOrder from 15 to <5

**Bad goals:**
- Make the code better
- Clean things up
- Improve performance (without metrics)

### Approach (Required)
High-level description of how you'll achieve the goals.

**Polish approach:** "Extract validation methods to new class, update callers, run tests"

**Overhaul approach:** "Phase 1: Create async wrapper around existing callbacks. Phase 2: Convert internal methods to async. Phase 3: Update public API. Phase 4: Remove callback support."

### Affected Areas (Required)
List specific paths/modules that will change.

### Out of Scope (Required)
Explicitly state what you're NOT changing. Prevents scope creep.

### Success Criteria (Required)
How will you know the refactor is complete?

- All existing tests pass
- [Specific goal] is achieved
- [Metric] is improved by [amount]
- Documentation reflects new structure

### Docs to Update (Required)
List documentation files that need updating after refactor.

## State Update

Use `mcp__exarchos__exarchos_workflow` with `action: "set"` with the featureId:

```text
# First call: Set brief data
Use mcp__exarchos__exarchos_workflow with action: "set":
  updates: {
    "brief": {
      "problem": "<problem statement>",
      "goals": ["<goal 1>", "<goal 2>"],
      "approach": "<approach description>",
      "affectedAreas": ["<area 1>", "<area 2>"],
      "outOfScope": ["<exclusion 1>", "<exclusion 2>"],
      "successCriteria": ["<criterion 1>", "<criterion 2>"],
      "docsToUpdate": ["<doc 1>", "<doc 2>"]
    }
  }

# Second call: Transition phase
Use mcp__exarchos__exarchos_workflow with action: "set":
  phase: "polish-implement" (polish) or "overhaul-plan" (overhaul)
```

## Polish vs Overhaul Brief Depth

| Field | Polish | Overhaul |
|-------|--------|----------|
| Problem | 1-2 sentences | Paragraph with context |
| Goals | 1-3 items | 3-5 items |
| Approach | 1 sentence | Paragraph with phases |
| Affected Areas | File paths | Module/package paths |
| Out of Scope | 1-2 items | 3+ items |
| Success Criteria | 2-3 items | 4+ items |
| Docs to Update | 0-2 files | 2+ files |
