# Explore Phase

## Purpose

Assess refactoring scope to determine appropriate track (polish vs overhaul).

## Entry Conditions

- Refactor workflow initiated via `/exarchos:refactor`
- Target area identified (file, directory, or module)

## Process

### Step 1: Scope Discovery

Use exploration tools to understand the impact:

```bash
# Find files that will be affected
# Use Glob to find files in target area
# Use Grep to find references to target code
```

Questions to answer:
1. How many files will be modified?
2. How many modules/packages are affected?
3. Are there cross-module dependencies?
4. What's the test coverage of affected code?

### Step 2: Concern Analysis

Identify what types of changes are needed:

- [ ] Renaming (variables, functions, files)
- [ ] Extracting (new functions, classes, modules)
- [ ] Moving (relocating code between files/modules)
- [ ] Restructuring (changing architecture)
- [ ] Cleaning (removing dead code, improving style)

Count distinct concerns - multiple indicates overhaul track.

### Step 3: Test Assessment

Evaluate existing test coverage:

```bash
# Check for test files covering affected code
# Review test coverage if available
```

| Coverage Level | Implication |
|----------------|-------------|
| Good (>80%) | Either track viable |
| Gaps (50-80%) | Overhaul recommended (need test additions) |
| Poor (<50%) | Overhaul required (significant test work) |

### Step 4: Documentation Check

Identify docs that reference affected code:

- Architecture documentation
- API documentation
- README files
- Inline comments with explanations

Significant doc updates → overhaul track indicator.

## Track Decision Matrix

| Criterion | Polish | Overhaul |
|-----------|--------|----------|
| Files affected | <=5 | >5 |
| Concerns | 1 | >1 |
| Cross-module | No | Yes |
| Test gaps | No | Yes |
| Doc updates | Minor | Significant |

**Rule**: If ANY criterion indicates overhaul, use overhaul track.

## Output

**Save assessment and advance to brief:**

```
action: "set", featureId: "refactor-<slug>", updates: {
  "explore": {
    "filesAffected": <count>,
    "filesList": ["<path1>", "<path2>"],
    "modulesAffected": ["<module1>"],
    "concerns": ["<concern1>", "<concern2>"],
    "crossModule": <true|false>,
    "testCoverage": "<good|gaps|none>",
    "docsImpacted": ["<doc1>"],
    "recommendedTrack": "<polish|overhaul>",
    "completedAt": "<ISO8601>"
  }
}, phase: "brief"
```

## Exit Conditions

- Scope assessment complete
- Track recommendation recorded
- State updated with findings
- Ready to proceed to brief phase

## If --explore-only Flag

When `--explore-only` is specified:

1. Complete assessment as normal
2. Output summary to user
3. Do NOT transition to brief phase
4. Keep phase as "explore" in state

```markdown
## Exploration Summary

**Target:** <target path>
**Recommended Track:** <polish|overhaul>

### Scope Assessment
- Files: <count>
- Modules: <list>
- Concerns: <list>
- Cross-module: <yes|no>
- Test coverage: <good|gaps|none>
- Docs to update: <list>

### Rationale
<explanation of track recommendation>
```
