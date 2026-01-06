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
