# Orchestrator Constraints

The orchestrator (main Claude Code session) MUST NOT:

1. **Write implementation code** — All code changes via subagents
2. **Fix review findings directly** — Dispatch fixer subagents
3. **Run tests inline** — Tests run in subagent worktrees or during review
4. **Work in main project root** — All implementation in worktrees

The orchestrator SHOULD:

1. **Parse and extract** — Read plans, extract task details
2. **Dispatch and monitor** — Launch subagents, track progress
3. **Manage state** — Update workflow state file
4. **Chain phases** — Invoke next skill when phase completes
5. **Handle failures** — Route failures back to appropriate phase

**Exception:** For `/refactor --polish` only, the orchestrator MAY write code directly during `implement` phase (small scope, single concern).

For exceptions (polish track), guardrails, and verification steps, see `skills/delegation/references/orchestrator-constraints.md`.
