# Documentation Update Checklist

## Purpose

Every refactor MUST update affected documentation. This is not optional. Code without accurate documentation creates technical debt.

## Before Starting

1. Review `docsToUpdate` list from brief
2. Read each document to understand current state
3. Note specific sections that need changes

## Documentation Types

### Architecture Documentation

**When to update:** Structure, module organization, or dependencies changed

**What to check:**
- [ ] Component diagrams accurate
- [ ] Module descriptions current
- [ ] Dependency arrows correct
- [ ] Technology choices documented

### API Documentation

**When to update:** Public interfaces, method signatures, or behavior changed

**What to check:**
- [ ] Function/method signatures match code
- [ ] Parameter descriptions accurate
- [ ] Return value documentation correct
- [ ] Examples still work
- [ ] Error cases documented

### README Files

**When to update:** Setup, usage, or configuration changed

**What to check:**
- [ ] Installation steps current
- [ ] Configuration examples valid
- [ ] Usage examples work
- [ ] Prerequisites listed

### Inline Comments

**When to update:** Complex logic moved or rewritten

**What to check:**
- [ ] Comments explain "why" not "what"
- [ ] No stale comments referring to old code
- [ ] Complex algorithms documented
- [ ] TODO items addressed or updated

## Verification

After updating documentation:

1. [ ] Read each updated doc fresh
2. [ ] Verify code references are accurate
3. [ ] Test any code examples
4. [ ] Check links aren't broken

## State Update

After documentation is updated, use `mcp__workflow-state__workflow_set`:

```text
Use mcp__workflow-state__workflow_set with featureId:
  updates: {
    "validation.docsUpdated": true,
    "artifacts.updatedDocs": ["<doc1>", "<doc2>"]
  }
```

## If No Docs Need Updating

If `docsToUpdate` is empty, verify this is correct:

1. Review affected areas
2. Confirm no public interfaces changed
3. Confirm no architectural changes made
4. Document verification in state:

```text
Use mcp__workflow-state__workflow_set with featureId:
  updates: {
    "validation.docsUpdated": true,
    "artifacts.updatedDocs": []
  }
```

## Common Mistakes

| Mistake | Correction |
|---------|------------|
| "Docs don't need updating" | Always verify; code changes usually need doc updates |
| Update code examples only | Also update prose descriptions |
| Skip architecture docs | These are often most important |
| Leave TODO comments | Address or remove them |
| Assume readers know context | Document the "why" |
