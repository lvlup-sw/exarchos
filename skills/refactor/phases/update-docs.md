# Update-Docs Phase

## Purpose

Ensure all affected documentation is updated after refactoring. This phase is REQUIRED for both polish and overhaul tracks.

## Entry Conditions

- Polish track: Validation phase passed
- Overhaul track: Review phase passed
- `docsToUpdate` list available from brief

## Core Principle

**Every refactor MUST update affected documentation.**

Documentation debt is technical debt. Code without accurate documentation creates maintenance burden and knowledge gaps.

## Process

### Step 1: Review Documentation List

Retrieve docs identified during brief phase:

```bash
docs=$(~/.claude/scripts/workflow-state.sh get <state-file> '.brief.docsToUpdate')
```

If list is empty, still verify no docs need updating (see Step 5).

### Step 2: Assess Each Document

For each document in the list:

| Check | Question |
|-------|----------|
| Still accurate? | Does the doc still describe reality? |
| References valid? | Do code references point to correct locations? |
| Examples work? | Do code examples still function? |
| Diagrams current? | Do architecture diagrams reflect changes? |

### Step 3: Make Updates

Update each document to reflect the refactoring:

#### Architecture Documentation

```markdown
## Before
UserService handles authentication, validation, and persistence.

## After
UserService handles persistence.
UserValidator handles input validation.
AuthService handles authentication.
```

#### API Documentation

```markdown
## Before
`UserService.validate(user)` - Validates user input

## After
`UserValidator.validateUser(user)` - Validates user input
(Note: UserService.validate is deprecated, use UserValidator)
```

#### README Updates

```markdown
## Project Structure (Updated)

src/
  services/
    UserService.ts      # Persistence only
    AuthService.ts      # Authentication
  validators/
    UserValidator.ts    # Input validation (NEW)
```

#### Inline Comments

Review and update inline comments in refactored code:
- Remove comments that reference old code
- Update comments that explain changed logic
- Add comments for new complex logic

### Step 4: Verify Updates

After updating, verify each document:

```bash
# Check for broken links
# Verify code examples compile/run
# Review diagrams for accuracy
```

| Document | Updated | Verified |
|----------|---------|----------|
| architecture.md | ✓ | ✓ |
| api.md | ✓ | ✓ |
| README.md | ✓ | ✓ |

### Step 5: Verify "No Docs Needed" (If Applicable)

If `docsToUpdate` was empty, verify this is correct:

```markdown
## Documentation Verification

Checked the following and confirmed no updates needed:

- [ ] Architecture docs - No structural changes
- [ ] API docs - No interface changes
- [ ] README - No setup/usage changes
- [ ] Inline comments - Reviewed and current

Rationale: <why no docs needed>
```

Document this verification in state.

## Documentation Types Checklist

### Architecture Documentation
- [ ] Component diagrams accurate
- [ ] Module descriptions current
- [ ] Dependency relationships correct
- [ ] Technology decisions documented

### API Documentation
- [ ] Function signatures match code
- [ ] Parameter descriptions accurate
- [ ] Return values documented
- [ ] Error cases listed
- [ ] Examples work

### README Files
- [ ] Installation steps current
- [ ] Usage examples valid
- [ ] Configuration documented
- [ ] Prerequisites listed

### Code Comments
- [ ] Comments explain "why" not "what"
- [ ] No stale comments
- [ ] Complex logic documented
- [ ] TODO items addressed

## State Update

### Docs Updated Successfully
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.validation.docsUpdated = true |
   .artifacts.updatedDocs = ["<doc1>", "<doc2>"] |
   .phase = "<complete|synthesize>"'
```

Phase transitions:
- Polish track → `complete` (ready for human checkpoint)
- Overhaul track → `synthesize` (create PR)

### No Docs Needed (Verified)
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.validation.docsUpdated = true |
   .validation.docsVerification = "No updates needed: <reason>" |
   .artifacts.updatedDocs = [] |
   .phase = "<complete|synthesize>"'
```

## Output

```markdown
## Documentation Update Summary

**Docs Updated:** <count>

| Document | Changes Made |
|----------|--------------|
| architecture.md | Updated component diagram, module descriptions |
| README.md | Updated project structure section |

**Verification:** All updates verified accurate

**Next Phase:** <complete|synthesize>
```

## Common Mistakes

| Mistake | Correction |
|---------|------------|
| "No docs need updating" | Always verify; refactors usually affect docs |
| Update code examples only | Also update prose descriptions |
| Skip architecture docs | These are often most important |
| Leave TODO comments | Address or remove them |
| Assume context obvious | Document the "why" for future readers |

## Exit Conditions

- All identified docs updated
- Updates verified accurate
- State records completion
- Ready for final phase (complete or synthesize)
