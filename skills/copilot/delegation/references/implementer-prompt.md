# Implementer Prompt Template

**Note:** On runtimes with native agent definitions (e.g. Claude Code), this template is compiled into `servers/exarchos-mcp/src/agents/definitions.ts` (IMPLEMENTER spec) and the rendered agent file (e.g. `agents/exarchos-implementer.md`) is generated from the registry at build time. This reference document is the canonical prompt evolution record and is used directly by runtime clients without native agent support (Cursor, Copilot CLI, etc.).

Use this template when dispatching tasks via the runtime's spawn primitive.

## Quality Hints Integration

Before dispatch, query `exarchos_view` with `action: 'quality_hints'` and `skill: '<skill-name>'` to retrieve quality signals for the target skill. If the returned `hints` array is non-empty, include the **Quality Signals** section in the prompt. If empty, omit it entirely.

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

## Testing Approach (Testing Trophy)

Prefer **integration tests with real collaborators** (sociable tests). Mock only at infrastructure boundaries (HTTP, database, filesystem). This gives the best confidence-per-effort ratio.

- **Acceptance test tasks** (`testLayer: acceptance`): Use real collaborators throughout. No mocks except true external boundaries. This test stays RED until inner tasks complete — it is the "north star."
- **Integration test tasks** (`testLayer: integration`): Default layer. Use real collaborators, mock only infrastructure boundaries.
- **Unit test tasks** (`testLayer: unit`): For isolated complex logic only. Mocking is acceptable here.

## Characterization Testing

When a task has `characterizationRequired: true`, capture existing behavior BEFORE modifying code:

1. Write tests that document what the code **currently does** (not what it should do)
2. Use snapshot-style assertions: capture output, assert it matches
3. Make your changes — any characterization test failure means behavior changed
4. Document which characterization test failures are intentional vs accidental

## Acceptance Test Completion Check

When a task has `acceptanceTestRef`, run the parent acceptance test after completing your inner task:
- Still failing → expected (other inner tasks may not be complete yet)
- Now passing → the feature may be complete; report this in your completion output

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


## Quality Signals
<!-- Populated at dispatch time by orchestrator when quality hints are available. -->
<!-- Query: exarchos_view with action: 'quality_hints' and skill: '<skill-name>' -->
<!-- If hints array is non-empty, include this section. If empty, omit entirely. -->

Based on historical quality data for this skill:

{{#each hints}}
- **{{category}}** ({{severity}}): {{hint}}
{{/each}}

Use these signals to guide your implementation. Address warnings proactively.

## Code Exploration Tools

For navigating and understanding code:
- `Grep` — Search for patterns across the codebase
- `Glob` — Find files by name pattern
- `Read` — Read file contents (prefer targeted reads over full-file reads)

When Serena MCP is available, prefer semantic tools for precision:
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
<!-- REQUIRED in both Agent Teams and Subagent modes. Never omit this section. -->

After completing each logical task within your assignment:

1. Stage the relevant files: `git add <files>`
2. Commit with a descriptive message: `git commit -m "feat: <task summary>"`
3. Continue to the next task

After all tasks are complete:
4. Push your branch: `git push -u origin <branch-name>`

PR creation is handled during the synthesis phase — do not create PRs from implementation tasks.

### Grouping Guidance

Commits should match logical review units, not individual TDD test cycles. Group related changes that form a coherent feature into one commit. For example, if you implement types + config + tests for a module, that's one commit, not three.

## Provenance Reporting

When completing a task, include structured provenance data in your completion report. This data flows into the `task.completed` event for traceability through the provenance chain.

### Required Fields

1. **implements** — Design requirement IDs you implemented (e.g., `["DR-1", "DR-3"]`)
2. **tests** — Tests written, each with name and file path
3. **files** — Files created or modified
4. **acceptanceTestRef** — (optional) Task ID of the parent acceptance test, if this task has an `acceptanceTestRef` field

### Structured Format

Report provenance as a JSON object in your task completion call:

```json
{
  "implements": ["DR-1", "DR-3"],
  "acceptanceTestRef": "task-000",
  "tests": [
    { "name": "validateEmail_InvalidFormat_ReturnsError", "file": "src/validators/email.test.ts" },
    { "name": "validateEmail_ValidFormat_ReturnsSuccess", "file": "src/validators/email.test.ts" }
  ],
  "files": ["src/validators/email.ts", "src/validators/email.test.ts"]
}
```

### Passing Provenance in Task Completion

When using Exarchos MCP to mark a task complete, pass provenance fields in the `result` parameter:

```typescript
exarchos_orchestrate({
  action: "task_complete",
  taskId: "task-001",
  streamId: "<featureId>",
  result: {
    summary: "Implemented email validation with TDD",
    implements: ["DR-1"],
    acceptanceTestRef: "task-000",
    tests: [{ name: "validateEmail_InvalidFormat_ReturnsError", file: "src/validators/email.test.ts" }],
    files: ["src/validators/email.ts", "src/validators/email.test.ts"]
  }
})
```

These fields are extracted by `handleTaskComplete` and included in the `task.completed` event, enabling the ProvenanceView to trace requirements through to implementation.

## Completion

When done, report:
1. Test file path and test name
2. Implementation file path
3. Test results (pass/fail)
4. Provenance: implements (requirement IDs), acceptanceTestRef (if present), tests (name + file), files (paths)
5. Any issues encountered
```

## Usage Example

Build the prompt body (worktree path, task description, files, TDD phases, expected test, success criteria) following the template above, then dispatch via the runtime's spawn primitive. The macro expands to whichever invocation form your runtime uses (`Task({ description, prompt })` on Claude/Cursor/OpenCode, `spawn_agent({ message })` on Codex, `task --agent <name> '<message>'` on Copilot):

```typescript
task --agent implementer 'Implement user validation: <full prompt body — see template structure above>'
```

The prompt body itself is what makes the dispatch self-contained. A worked example payload follows:

```text
# Task: Implement User Email Validation

## Working Directory
/home/user/project/.worktrees/task-003

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
Implement email validation for user registration. The validator should:
- Check email format using regex
- Verify domain has MX record (mock in tests)
- Return validation result with error messages

## Files to Modify

### Create/Modify:
- `src/validators/email.ts` - Email validation function

### Test Files:
- `src/validators/email.test.ts` - Validation tests

## TDD Requirements (MANDATORY)

You MUST follow strict Test-Driven Development:

### Phase 1: RED - Write Failing Test

1. Create test file at src/validators/email.test.ts
2. Write test: `validateEmail_InvalidFormat_ReturnsError`
3. Run tests: `npm run test:run`
4. VERIFY test fails for the expected reason

### Phase 2: GREEN - Minimum Implementation

1. Write minimum code in src/validators/email.ts
2. Run tests: `npm run test:run`
3. VERIFY test passes

### Phase 3: REFACTOR - Clean Up

1. Extract regex to constant
2. Run tests after change
3. VERIFY tests stay green

## Expected Test

```typescript
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
```

## Success Criteria

- [ ] Test written BEFORE implementation
- [ ] Test fails for the right reason
- [ ] Implementation passes test
- [ ] No extra code beyond requirements
- [ ] All tests in worktree pass
```

## Key Principles

1. **Full Context** - Include everything the implementer needs
2. **No File References** - Don't say "see plan.md" - paste content
3. **Explicit Paths** - Absolute paths to working directory and files
4. **TDD Mandatory** - Always include TDD requirements
5. **Git-First** - Standard git commit + push. PR creation handled by synthesis phase.
6. **Clear Success Criteria** - Checkboxes for completion
