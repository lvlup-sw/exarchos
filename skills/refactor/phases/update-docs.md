# Update Docs Phase

## Purpose

Ensure all documentation remains accurate after refactoring. This phase updates affected documentation to reflect the new code structure, APIs, and architecture.

## MANDATORY REQUIREMENT

**Documentation updates are NOT optional for refactors.**

Every refactor changes existing code structure. If documentation exists for that code, it MUST be updated. Skipping this phase results in documentation drift, which compounds over time and misleads future developers.

The `docsToUpdate` field in the brief identifies documents requiring updates. If this field is empty, the phase still runs to VERIFY no documentation needs updating.

## Entry Conditions

### Polish Track

- `validate` phase complete
- All tests passing
- Goals verified

### Overhaul Track

- `review` phase complete
- All quality checks passed
- Code merged to feature branch

## Process

### Step 1: Review Documentation List

Read the brief's `docsToUpdate` field using `mcp__exarchos__exarchos_workflow` with `action: "get"`:

```text
Use mcp__exarchos__exarchos_workflow with action: "get", featureId and query: ".brief.docsToUpdate"
```

If the list is empty, proceed to Step 4 (Verification).

### Step 2: Read Each Document

For each document in the list:

1. Read the current content
2. Identify sections affected by the refactor
3. Note what needs to change

```typescript
Read({ file_path: "/path/to/affected-doc.md" })
```

### Step 3: Update Affected Sections

Update each document to reflect the new code structure:

| Change Type | Documentation Update |
|-------------|---------------------|
| Renamed file/class | Update all references |
| Moved location | Update paths and imports |
| Changed API | Update signatures and examples |
| New architecture | Add/update diagrams |
| Removed code | Remove obsolete references |

**Update Guidelines:**

- Keep updates minimal and focused
- Match the existing document style
- Update code examples if affected
- Verify links still work

### Step 4: Verification

Verify documentation accuracy against the new code:

| Check | How to Verify |
|-------|---------------|
| File paths | Confirm paths in docs exist |
| Code examples | Examples compile/run correctly |
| API signatures | Match actual implementation |
| Diagrams | Reflect current architecture |
| Links | All internal links resolve |

If `docsToUpdate` was empty, verify:
- Search for references to changed code
- Confirm no documentation references outdated patterns
- If documentation gaps found, update immediately

## Documentation Types

### Architecture Documentation

Update when:
- Module structure changes
- Dependencies change
- Component relationships change

Typical locations:
- `docs/architecture/*.md`
- `docs/adrs/*.md`
- `README.md` architecture sections

### API Documentation

Update when:
- Function signatures change
- Types/interfaces change
- Endpoints change

Typical locations:
- Inline JSDoc/TSDoc comments
- `docs/api/*.md`
- OpenAPI/Swagger specs

### README Files

Update when:
- Setup process changes
- Usage patterns change
- Dependencies change

Typical locations:
- Project root `README.md`
- Module-level `README.md` files

### Inline Comments

Update when:
- Complex logic moves
- Algorithms change
- Important context relocates

**Note:** Avoid over-commenting. Only update comments that explain WHY, not WHAT.

## State Updates

Record updated documents using `mcp__exarchos__exarchos_workflow` with `action: "set"`:

```text
# Add each updated document
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: { "artifacts.updatedDocs": ["docs/architecture/modules.md"] }

# Mark docs updated
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: { "validation.docsUpdated": true }

# Update phase - Polish track
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  phase: "completed"

# Update phase - Overhaul track
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  phase: "synthesize"
```

## Exit Conditions

### Polish Track

After completing documentation updates:

1. All listed documents updated
2. Verification complete
3. State updated with `docsUpdated = true`
4. **CHECKPOINT: Human approval required**

Present summary to user:
```text
Documentation Update Complete
-----------------------------
Updated docs:
- docs/architecture/modules.md (updated paths)
- README.md (updated examples)

Verification: All links and examples verified

Ready to complete refactor? [Approve / Request changes]
```

### Overhaul Track

After completing documentation updates:

1. All listed documents updated
2. Verification complete
3. State updated with `docsUpdated = true`
4. **Auto-chain to synthesize phase**

```text
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  phase: "synthesize"
```

5. Auto-invoke synthesize immediately:
```typescript
Skill({ skill: "synthesize", args: "<feature-name>" })
```

This is NOT a human checkpoint - workflow continues autonomously.

## Common Issues

### No Documentation Exists

If refactored code has no documentation:
- This is acceptable for refactors
- Creating new documentation is a separate task
- Note the gap in the state for future reference

### Documentation Scope Creep

If updating one document reveals many need updates:
- Update only what's necessary for this refactor
- Note other gaps for future work
- Stay focused on the brief's scope

### Conflicting Documentation

If documentation conflicts with new code:
- Trust the code (you just validated it)
- Update documentation to match
- Add clarifying notes if needed

## Checklist

Before exiting this phase:

- [ ] Reviewed all documents in `docsToUpdate`
- [ ] Updated affected sections in each document
- [ ] Verified file paths and links
- [ ] Verified code examples work
- [ ] Updated state with `artifacts.updatedDocs` list
- [ ] Set `docsUpdated = true`
- [ ] Transitioned to next phase (completed or synthesize)
