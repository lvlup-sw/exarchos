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
- [ ] ≤5 files affected
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

## Output

After exploration, update state with scope assessment:

```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.explore.scopeAssessment = {
    "filesAffected": ["<list>"],
    "modulesAffected": ["<list>"],
    "testCoverage": "good | gaps | none",
    "recommendedTrack": "polish | overhaul"
  } | .track = "<selected-track>" | .explore.completedAt = "<ISO8601>"'
```
