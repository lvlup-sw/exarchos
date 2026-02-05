# Orchestrator Constraints

The orchestrator (main Claude Code session) MUST NOT:

1. **Write implementation code** — All code changes via subagents
2. **Fix review findings directly** — Dispatch fixer subagents
3. **Run integration tests inline** — Dispatch integration subagent
4. **Work in main project root** — All implementation in worktrees

The orchestrator SHOULD:

1. **Parse and extract** — Read plans, extract task details
2. **Dispatch and monitor** — Launch subagents, track progress
3. **Manage state** — Update workflow state file
4. **Chain phases** — Invoke next skill when phase completes
5. **Handle failures** — Route failures back to appropriate phase

## Exceptions

### Polish Track Refactors

For `/refactor --polish` (polish track) ONLY, the orchestrator MAY write implementation code directly during the `implement` phase.

**Rationale:** Polish refactors are small enough (≤5 files, single concern) that delegation overhead exceeds benefit. Setting up worktrees and dispatching subagents for a simple rename or extraction adds ceremony without value.

**Guardrails:**
1. **Only during implement phase** — Not during explore, brief, validate, or update-docs
2. **Only for polish track** — Overhaul track MUST use delegation
3. **Stay within brief scope** — If scope expands beyond brief, switch to overhaul track
4. **Must follow TDD** — Write/update tests first if changing behavior
5. **Commit incrementally** — Commit after each logical change

**Scope Expansion Triggers:**
- More than 5 files need modification
- Changes cross module boundaries
- Test coverage gaps discovered
- Architectural decisions needed

If any trigger fires, stop and run:
```bash
/refactor --switch-overhaul
```

**Verification:**
Before starting implementation, verify using `mcp__workflow-state__workflow_get`:
1. Track is "polish" in state file (query: `.track`)
2. Phase is "implement" (query: `.phase`)
3. Brief goals are captured

## Rationale

The orchestrator acts as a coordinator, not an implementer. This separation:
- Preserves context window for coordination tasks
- Enables parallel execution via worktrees
- Creates clear boundaries for recovery after context compaction
- Ensures all changes are testable and reviewable

## Enforcement

When tempted to write code directly, ask:
1. Can this be delegated to a subagent?
2. Is this a coordination task or implementation task?
3. Will this consume significant context?

If in doubt, delegate.
