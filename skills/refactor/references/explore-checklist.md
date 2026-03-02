---
name: explore-checklist
---

# Refactor Exploration Checklist

## Scope Assessment

### Files Analysis
- [ ] List all files that will be modified
- [ ] Count total files affected
- [ ] Identify file types (source, test, config, docs)

### Module Analysis
- [ ] List modules/packages affected
- [ ] Identify cross-module dependencies
- [ ] Check for circular dependencies that might complicate refactor

### Test Coverage
- [ ] Check test coverage of affected code
- [ ] Identify test gaps
- [ ] Note tests that will need updating

### Documentation Impact
- [ ] List documentation that references affected code
- [ ] Identify architecture docs that may need updates
- [ ] Check for API documentation impacts

## Track Selection

### Polish Track Indicators (all must be true)
- [ ] <=5 files affected
- [ ] Single concern being addressed
- [ ] No cross-module changes
- [ ] Good test coverage exists
- [ ] Documentation changes are minor

### Overhaul Track Indicators (any one triggers)
- [ ] >5 files affected
- [ ] Multiple concerns being addressed
- [ ] Cross-module changes required
- [ ] Test coverage gaps exist
- [ ] Architectural documentation needs updating

## Deterministic Scope Assessment

Run the scope assessment script for a deterministic track recommendation:

```typescript
exarchos_orchestrate({
  action: "run_script",
  script: "assess-refactor-scope.sh",
  args: ["--files", "<file1,file2,...>"]
})
// or
exarchos_orchestrate({
  action: "run_script",
  script: "assess-refactor-scope.sh",
  args: ["--state-file", "<path>"]
})
```

**On `passed: true`:** Polish recommended — scope is contained (<=5 files, single module).
**On `passed: false`:** Overhaul recommended — scope exceeds polish limits (>5 files or cross-module).

## Output

**Save assessment and advance to brief:**

```
action: "set", featureId: "refactor-<slug>", updates: {
  "explore.scopeAssessment": {
    "filesAffected": ["<list>"],
    "modulesAffected": ["<list>"],
    "testCoverage": "good | gaps | none",
    "recommendedTrack": "polish | overhaul"
  },
  "track": "<selected-track>",
  "explore.completedAt": "<ISO8601>"
}, phase: "brief"
```
