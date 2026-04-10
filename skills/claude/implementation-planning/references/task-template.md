# TDD Task Template

## Task Format

Each task follows this structure:

```markdown
### Task [N]: [Brief Description]

**Phase:** [RED | GREEN | REFACTOR]
**Test Layer:** [acceptance | integration | unit | property]
**Acceptance Test Ref:** [Task ID of parent acceptance test, or omit]
**Implements:** [DR-N identifiers]

**TDD Steps:**
1. [RED] Write test: `TestName_Scenario_ExpectedOutcome`
   - File: `path/to/test.ts`
   - Expected failure: [Specific failure reason]
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `path/to/implementation.ts`
   - Changes: [Brief description]
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up (optional)
   - Apply: [SOLID principle or improvement]
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** [Task IDs this depends on, or "None"]
**Parallelizable:** [Yes/No]
```

## Test Layer Selection

Each task must declare its test layer. This determines the scope and style of testing:

| Layer | Scope | When to use |
|---|---|---|
| `acceptance` | Feature-level behavior from user perspective | First task per feature or DR-N cluster. Uses real collaborators, no mocks. Remains RED until inner tasks complete. |
| `integration` | Multiple components working together | **Default for most tasks.** Uses real collaborators, mocks only at infrastructure boundaries. |
| `unit` | Single function/class in isolation | Complex algorithmic logic, pure functions, parsers. |
| `property` | Invariants across input space | Transformations, state machines, serialization (auto-determined via testingStrategy). |

**Acceptance Test Ref:** Inner tasks that implement toward an acceptance test should declare `**Acceptance Test Ref:** [Task ID]` linking to the parent acceptance test task. This creates the provenance chain: `DR-N → Acceptance Test → Inner Tests → Code`.

## Characterization Testing

When a task modifies existing code behavior, the planner should set `characterizationRequired: true` in the testingStrategy. The implementer captures current behavior as characterization tests before making changes, providing a safety net against unintended regressions.

## Test Naming Convention

Follow: `MethodName_Scenario_ExpectedOutcome`

**Examples:**
- `CreateUser_ValidInput_ReturnsUserId`
- `CreateUser_EmptyEmail_ThrowsValidationError`
- `GetUser_NonExistentId_ReturnsNull`
