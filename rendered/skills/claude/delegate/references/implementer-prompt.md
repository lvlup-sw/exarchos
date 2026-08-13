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

## Working Directory Setup (MANDATORY)

Your shell may have started in the parent repo cwd, depending on the runtime.
Native-isolation runtimes (Claude Code's `isolation: "worktree"`) chdir for
you; other runtimes (Copilot CLI, generic MCP, Cursor at the time of writing)
spawn subagents in the parent. Your FIRST command must be:

```bash
cd "<absolute worktree path>"             # bash / zsh / sh
```
```powershell
Set-Location "<absolute worktree path>"   # PowerShell
```

Where `<absolute worktree path>` is the path from the **Working Directory**
section above. After that, the verification block below confirms you landed
correctly.

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

## CRITICAL: Base Verification (MANDATORY)

Before making ANY file changes, verify your worktree is based on the **integration tip**, not a stale `main`. On native-isolation runtimes the worktree base depends on `worktree.baseRef` (see the delegation skill); this assert is the version-independent safety net that halts loud if the base is wrong — so you never build on a base missing prerequisite in-branch commits.

```bash
git merge-base --is-ancestor "[integration-tip]" HEAD \
  && echo "BASE OK" \
  || { echo "ERROR: worktree base is not a descendant of the integration tip — halting"; exit 1; }
```

`[integration-tip]` is the workflow's integration branch (or its tip SHA), supplied by the orchestrator at dispatch. If this fails, STOP and report — do NOT rebase or reset to self-heal; the orchestrator owns base correction.

## Task Description
[Full task description from implementation plan - never reference external files]

## Files to Modify

> Paths are **relative to your worktree** (the Working Directory above). Never an absolute parent-repo path — see Key Principle #3.

### Create/Modify:
- `[path/to/file.ts]` - [Brief description of changes]

### Test Files:
- `[path/to/file.test.ts]` - [Test file to create/modify]

## Code Comments

A comment states its constraint **in words** and names no planning ordinal. `DR-N`, `task N`, `T-N`, `wave N`, `slice N`, `epic #N`, `INV-N` and `docs/specs/…` paths do not belong in code — they identify this workflow's planning artifacts, which a future reader cannot resolve and which get renumbered. Write what is true of the code:

```ts
// ✅ the bytes are fsync'd before the rename, so a crash mid-write cannot expose a partial file
// ❌ DR-7 / task 014: fsync before rename
```

Durable external references stay welcome anywhere: a URL, `owner/repo#123`, a CVE, an RFC section. These name something outside this repository's planning cycle and a reader can follow them.

Provenance ordinals belong in the **completion event**, not the source. Report `implements: ["DR-N"]` through `task_complete` (see Provenance Reporting) — that is what the provenance chain reads, so a comment repeating it adds nothing and rots independently.

This applies to test files exactly as it does to production.

## Verification (tier-conditional)

<!--
  This section is ASSEMBLED FROM THE DELEGATION-RECORD STAMP, not pasted whole.
  `renderImplementerPrompt` (servers/exarchos-mcp/src/agents/definitions.ts) reads
  the task's `riskTier` / `boundaryTouching` — pure DATA, never a `workflow.type`
  branch (INV-6) — and selects exactly ONE of the tier blocks below, then appends
  the BOUNDARY block when `boundaryTouching` is true. Dispatch the SELECTED block
  only; do not ship every tier to the implementer.

  Evidence basis (TDAD): cutting a skill 107→20 lines QUADRUPLED resolution.
  Prompt bloat is a token AND an accuracy cost — so a low-risk task carries the
  terse note, not the full verification block.
-->

### [TIER: low] — static analysis suffices

Low blast-radius task: lean on static analysis (typecheck + lint). No test-first ceremony required; add a focused test only if behavior is non-obvious.

### [TIER: medium | high] — verification ladder (full block)

Cover the new/changed behavior with focused tests, judged by OUTCOME not by commit order — test-after is fine; the failing-test-first ordering ceremony is not required:

1. Implement the behavior for this task.
2. Add scoped tests named `[MethodName]_[Scenario]_[ExpectedOutcome]` that exercise it; run the project test command (from `.exarchos.yml`, e.g. `cargo test` / `pytest` / `dotnet test` / `npm run test:run`) and confirm they pass.
3. Refactor (SOLID, extract helpers) while the tests stay green.

Kill-probe: the `check_test_adequacy` gate runs after your tests — it reverts your source hunks (keeping the tests) and asserts at least one goes red. This recaptures test-first's one real guarantee — that a test can actually fail — at lower cost. Expect it to flag tests that pass against a stubbed-out implementation. (Granular per-behavior red-green is available as an opt-in if it helps, never a requirement.)

(For **high** tier, exercise real collaborators across the seam in your own scoped tests, not just unit isolation. Do **not** run the cumulative `check_integration_suite` gate — that is a wave-boundary backstop the lead runs once after the wave's merges land.)

### [BOUNDARY: append when boundaryTouching] — mock steer

Boundary task: mock only what you own. For a dependency you do NOT own, use a hermetic fixture or a contract-verified stub — never an unverified hand-mock that can drift from the real contract.

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

When this task has `testingStrategy.propertyTests: true`, write property tests alongside example tests during the RED phase. Use the patterns from `@skills/delegate/references/pbt-patterns.md`:

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

- [ ] Behavior covered by adequate tests (test-after is fine — no failing-test-first ceremony required)
- [ ] Tests can actually fail for the right reason (the test-adequacy kill-probe verifies this)
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

1. **implements** — Design requirement IDs you implemented (e.g., `["DR-1", "DR-3"]`). This is where a DR ordinal belongs. It is carried by the event, never by a code comment — see Code Comments.
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
Task({
  subagent_type: "exarchos-implementer",
  run_in_background: true,
  description: "Implement user validation",
  prompt: "<full prompt body — see template structure above>"
})

```

The prompt body itself is what makes the dispatch self-contained. A worked example payload follows:

```text
# Task: Implement User Email Validation

## Working Directory
/home/user/project/.worktrees/task-003

## Working Directory Setup (MANDATORY)

Your shell may have started in the parent repo cwd, depending on the runtime.
Native-isolation runtimes (Claude Code's `isolation: "worktree"`) chdir for
you; other runtimes (Copilot CLI, generic MCP, Cursor at the time of writing)
spawn subagents in the parent. Your FIRST command must be:

```bash
cd "/home/user/project/.worktrees/task-003"             # bash / zsh / sh
```
```powershell
Set-Location "/home/user/project/.worktrees/task-003"   # PowerShell
```

After that, the verification block below confirms you landed correctly.

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

## CRITICAL: Base Verification (MANDATORY) (Example)

Before making ANY file changes, verify your worktree is based on the **integration tip**, not a stale `main`:

```bash
git merge-base --is-ancestor "feat/registration" HEAD \
  && echo "BASE OK" \
  || { echo "ERROR: worktree base is not a descendant of the integration tip — halting"; exit 1; }
```

If this fails, STOP and report — do NOT rebase or reset to self-heal; the orchestrator owns base correction.

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

## Verification (verification ladder)

<!-- This task is high-tier + boundary-touching (MX lookup crosses an I/O seam),
     so the assembly selected the full block AND appended the boundary steer. -->

Cover the behavior with tests, judged test-after by outcome (no failing-test-first ceremony):

### Step 1: Implement the behavior

1. Write the implementation in src/validators/email.ts

### Step 2: Add scoped tests

1. Create test file at src/validators/email.test.ts
2. Write test: `validateEmail_InvalidFormat_ReturnsError`
3. Run the project test command (from `.exarchos.yml`, e.g. `cargo test` / `pytest` / `dotnet test` / `npm run test:run`) and confirm it passes

### Step 3: Refactor

1. Extract regex to constant
2. Run tests after change; they stay green

Kill-probe: the `check_test_adequacy` gate runs after your tests — it reverts your source and asserts at least one test goes red, flagging tests that pass against a stubbed-out implementation.

Boundary task: mock only what you own. The MX lookup is an unowned external dependency — use a hermetic fixture or a contract-verified stub, never an unverified hand-mock.

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

- [ ] Behavior implemented per the task description
- [ ] Scoped tests cover the new/changed behavior (order flexible — test-after is fine)
- [ ] Tests pass when run with the project test command
- [ ] Kill-probe holds: at least one test goes red when the implementation is reverted
- [ ] No extra code beyond requirements
- [ ] No comment names a planning ordinal (`DR-N`, `task N`, `INV-N`, a `docs/specs/…` path)
- [ ] All tests in worktree pass
```

## Key Principles

1. **Full Context** - Include everything the implementer needs
2. **No File References** - Don't say "see plan.md" - paste content
3. **Worktree-relative file paths** - Give an **absolute** path for the *working directory* (the `cd` target) only. Every file to read/edit/write must be a **path relative to that worktree** (e.g. `src/foo.ts`), **never** an absolute path into the parent/main repo. An `Edit`/`Write` resolves an absolute path literally and **ignores the agent's worktree cwd**, so an absolute parent-repo path silently writes into the orchestrator's main worktree. On Claude this is now enforced by a PreToolUse boundary hook that denies out-of-worktree writes; emitting relative paths keeps every runtime on the safe path.
4. **Verification scaled to risk** - Include the tier-appropriate verification block (the ladder), not blanket TDD
5. **Git-First** - Standard git commit + push. PR creation handled by synthesis phase.
6. **Clear Success Criteria** - Checkboxes for completion


## Agent Teams vs Subagent Mode

The table below shows which sections to include per dispatch mode. Unmarked sections (Verification, Files, Code Comments, Success Criteria, Completion) are **always included** in both modes.

| Section | Agent Teams Mode | Subagent Mode |
|---------|-----------------|---------------|
| Coordination (Native APIs) | Include in spawn prompt | Omit (not applicable) |
| Workflow Intelligence (Exarchos MCP) | Include in spawn prompt | Omit (hook injects) |
| Team Context | Include -- populated at spawn time | Omit (hook injects) |
| Historical Context | Include -- populated at spawn time | Omit (hook injects) |
| Quality Signals | Conditional -- include if hints non-empty | Conditional -- include if hints non-empty |
| Code Exploration Tools | Include | Include |
| Schema Sync | Include if task modifies API files | Include if task modifies API files |
| **Commit Strategy** | **Include -- REQUIRED** | **Include -- REQUIRED** |

## MCP Auto-Loading

Teammates automatically load project MCP servers (including Exarchos). The Coordination and Workflow Intelligence sections guide WHICH tools to use, not HOW to access them. Do not include MCP connection instructions or tool registration details in the spawn prompt.