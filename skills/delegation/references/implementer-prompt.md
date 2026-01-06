# Implementer Prompt Template

Use this template when dispatching tasks via the Task tool.

## Template

```markdown
# Task: [Task Title]

## Working Directory
[Absolute path to worktree or project root]

## CRITICAL: Worktree Verification (MANDATORY)

Before making ANY file changes, you MUST verify you are in a worktree:

1. Run: `pwd`
2. Verify the path contains `.worktrees/`
3. If NOT in a worktree directory:
   - STOP immediately
   - Report: "ERROR: Working directory is not a worktree. Aborting task."
   - DO NOT proceed with any file modifications

**Example verification:**
```bash
pwd | grep -q "\.worktrees" || { echo "ERROR: Not in worktree!"; exit 1; }
```

This check prevents accidental modifications to the main project root, which would cause merge conflicts with other parallel tasks.

## Task Description
[Full task description from implementation plan - never reference external files]

## Files to Modify

### Create/Modify:
- `[path/to/file.ts]` - [Brief description of changes]

### Test Files:
- `[path/to/file.test.ts]` - [Test file to create/modify]

## TDD Requirements (MANDATORY)

You MUST follow strict Test-Driven Development:

### Phase 1: RED - Write Failing Test

1. Create test file at the specified path
2. Write test with name: `[MethodName]_[Scenario]_[ExpectedOutcome]`
3. Run tests: `npm run test:run`
4. **VERIFY test fails for the expected reason**
5. Do NOT proceed until you've witnessed the failure

### Phase 2: GREEN - Minimum Implementation

1. Write the minimum code to make the test pass
2. No additional features or optimizations
3. Run tests: `npm run test:run`
4. **VERIFY test passes**

### Phase 3: REFACTOR - Clean Up

1. Apply SOLID principles if applicable
2. Extract helpers for clarity
3. Run tests after each change
4. **VERIFY tests stay green**

## Expected Test

```typescript
describe('[ComponentName]', () => {
  it('should [expected behavior] when [condition]', async () => {
    // Arrange
    [Setup code]

    // Act
    [Execution code]

    // Assert
    expect(result).[matcher](expected);
  });
});
```

## Success Criteria

- [ ] Test written BEFORE implementation
- [ ] Test fails for the right reason
- [ ] Implementation passes test
- [ ] No extra code beyond requirements
- [ ] All tests in worktree pass

## Completion

When done, report:
1. Test file path and test name
2. Implementation file path
3. Test results (pass/fail)
4. Any issues encountered
```

## Usage Example

```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",
  description: "Implement user validation",
  prompt: `
# Task: Implement User Email Validation

## Working Directory
/home/user/project/.worktrees/task-003

## CRITICAL: Worktree Verification (MANDATORY)

Before making ANY file changes, you MUST verify you are in a worktree:

1. Run: \`pwd\`
2. Verify the path contains \`.worktrees/\`
3. If NOT in a worktree directory:
   - STOP immediately
   - Report: "ERROR: Working directory is not a worktree. Aborting task."
   - DO NOT proceed with any file modifications

**Example verification:**
\`\`\`bash
pwd | grep -q "\\.worktrees" || { echo "ERROR: Not in worktree!"; exit 1; }
\`\`\`

This check prevents accidental modifications to the main project root, which would cause merge conflicts with other parallel tasks.

## Task Description
Implement email validation for user registration. The validator should:
- Check email format using regex
- Verify domain has MX record (mock in tests)
- Return validation result with error messages

## Files to Modify

### Create/Modify:
- \`src/validators/email.ts\` - Email validation function

### Test Files:
- \`src/validators/email.test.ts\` - Validation tests

## TDD Requirements (MANDATORY)

You MUST follow strict Test-Driven Development:

### Phase 1: RED - Write Failing Test

1. Create test file at src/validators/email.test.ts
2. Write test: \`validateEmail_InvalidFormat_ReturnsError\`
3. Run tests: \`npm run test:run\`
4. VERIFY test fails for the expected reason

### Phase 2: GREEN - Minimum Implementation

1. Write minimum code in src/validators/email.ts
2. Run tests: \`npm run test:run\`
3. VERIFY test passes

### Phase 3: REFACTOR - Clean Up

1. Extract regex to constant
2. Run tests after change
3. VERIFY tests stay green

## Expected Test

\`\`\`typescript
describe('validateEmail', () => {
  it('should return error when email format is invalid', async () => {
    // Arrange
    const invalidEmail = 'not-an-email';

    // Act
    const result = validateEmail(invalidEmail);

    // Assert
    expect(result.valid).toBe(false);
    expect(result.error).toContain('format');
  });
});
\`\`\`

## Success Criteria

- [ ] Test written BEFORE implementation
- [ ] Test fails for the right reason
- [ ] Implementation passes test
- [ ] No extra code beyond requirements
- [ ] All tests in worktree pass
`
})
```

## Key Principles

1. **Full Context** - Include everything the implementer needs
2. **No File References** - Don't say "see plan.md" - paste content
3. **Explicit Paths** - Absolute paths to working directory and files
4. **TDD Mandatory** - Always include TDD requirements
5. **Clear Success Criteria** - Checkboxes for completion
