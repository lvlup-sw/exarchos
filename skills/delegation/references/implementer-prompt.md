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

## Property-Based Testing Patterns

When this task has `testingStrategy.propertyTests: true`, write property tests alongside example tests during the RED phase. Use the patterns from `@skills/delegation/references/pbt-patterns.md`:

- **Roundtrip:** For encode/decode pairs, verify `decode(encode(x)) === x` for all inputs
- **Invariant:** For operations with business rules, verify bounds/constraints hold for all inputs
- **Idempotence:** For normalization/formatting, verify `f(f(x)) === f(x)` for all inputs
- **Commutativity:** For order-independent operations, verify `f(a, b) === f(b, a)` for all inputs

**TypeScript:** Use `fast-check` with `fc.property`, `fc.assert`, or `it.prop`
**C#:** Use `FsCheck` with `Prop.ForAll` or `[Property]` attribute

Property tests complement example tests -- write both in the RED phase.

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

## Coordination (Native APIs)
<!-- Agent Teams mode only. Remove this section for subagent mode. -->
- Use `TaskList` to see available tasks and their statuses
- Use `TaskUpdate` to mark tasks `in_progress` when you start and `completed` when done
- Use `SendMessage` to communicate findings to teammates or the lead

## Workflow Intelligence (Exarchos MCP)
<!-- Agent Teams mode only. Remove this section for subagent mode. -->
- Use `exarchos_workflow get` to query current workflow state
- Use `exarchos_view tasks` to see task details across the team
- Use `exarchos_event append` to report TDD phase transitions:
    stream: "{featureId}"
    event: { type: "task.progress", taskId: "{taskId}", tddPhase: "red|green|refactor" }

## Team Context
<!-- Agent Teams mode only. Populated at spawn time by orchestrator. -->
{teamComposition}

> This data is injected at spawn time. The SubagentStart hook provides only live coordination updates (task status changes, newly unblocked tasks).

## Historical Context
<!-- Agent Teams mode only. Populated at spawn time by orchestrator. -->
{historicalIntelligence}

> This data is injected at spawn time. The SubagentStart hook provides only live coordination updates.

## Code Exploration Tools

For navigating and understanding code, prefer Serena MCP tools over grep/glob:
- `mcp__plugin_serena_serena__find_symbol` — Locate classes, functions, methods by name
- `mcp__plugin_serena_serena__get_symbols_overview` — Understand file structure without reading entire files
- `mcp__plugin_serena_serena__search_for_pattern` — Regex search across the codebase
- `mcp__plugin_serena_serena__find_referencing_symbols` — Find all callers/users of a symbol

## Schema Sync (If Modifying API Files)

If this task modifies any of these file patterns, run schema sync after implementation:
- `*Endpoints.cs` - API endpoint definitions
- `Models/*.cs`, `Requests/*.cs`, `Responses/*.cs`, `Dtos/*.cs` - DTOs

```bash
# From worktree root
npm run sync:schemas
npm run typecheck
```

This regenerates TypeScript types from the OpenAPI spec. Include generated files in your commit.

## Commit Strategy

After completing each logical task within your assignment:

1. Stage the relevant files: `git add <files>`
2. Create a stacked branch: `gt create <task-branch-name> -m "feat: <task summary>"`
3. Continue to the next task (you are now on a new branch stacked on the previous)

After all tasks are complete:
4. Submit the full stack: `gt submit --no-interactive --publish --stack`

**IMPORTANT:** When using Graphite, never use `git commit` or `git push`. Always use `gt create` and `gt submit`.

### Grouping Guidance

Stack branches should match logical review units, not individual TDD test cycles. Group related changes that form a coherent feature into one stack layer. For example, if you implement types + config + tests for a module, that's one `gt create`, not three.

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
5. **Graphite-First** - Include commit strategy section; always use `gt create` and `gt submit`
6. **Clear Success Criteria** - Checkboxes for completion

## Agent Teams vs Subagent Mode

The template sections marked "Agent Teams mode only" (Coordination, Workflow Intelligence, Team Context, Historical Context) should be **included only when dispatching via Agent Teams mode** (`Task` with `team_name`). When dispatching via subagent mode (`Task` with `run_in_background`), omit these sections -- the SubagentStart hook handles context injection for subagents.

| Section | Agent Teams Mode | Subagent Mode |
|---------|-----------------|---------------|
| Coordination (Native APIs) | Include in spawn prompt | Omit (not applicable) |
| Workflow Intelligence (Exarchos MCP) | Include in spawn prompt | Omit (hook injects) |
| Team Context | Include -- populated at spawn time | Omit (hook injects) |
| Historical Context | Include -- populated at spawn time | Omit (hook injects) |

## MCP Auto-Loading

Teammates automatically load project MCP servers (including Exarchos). The Coordination and Workflow Intelligence sections guide WHICH tools to use, not HOW to access them. Do not include MCP connection instructions or tool registration details in the spawn prompt.
