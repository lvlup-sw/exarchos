# Agents

Exarchos defines three typed agents as Claude Code native `.md` agent specs. All agents run in isolated git worktrees, use the `opus` model, and have access to the Exarchos MCP server.

Agent specs are served dynamically via:

```
exarchos_orchestrate({ action: "agent_spec", agentType: "implementer" })
```

## Implementer

TDD implementation in isolated worktrees.

- **Role:** Write production code following Red-Green-Refactor protocol
- **Tools:** Read, Write, Edit, Bash, Grep, Glob
- **Disallowed:** Agent (no sub-spawning)
- **Hooks:** Runs `npm run test:run` after Bash commands
- **Key constraints:**
  - No production code without a failing test first
  - Each test must fail before writing implementation
  - Atomic commits per TDD cycle
  - Must verify worktree path contains `.worktrees/` before making changes
- **Output:** JSON completion report with `status`, `implements`, `tests`, `files`

## Fixer

Diagnose and repair failed tasks.

- **Role:** Resume failed implementer tasks with full context and adversarial verification
- **Tools:** Read, Write, Edit, Bash, Grep, Glob
- **Disallowed:** Agent (no sub-spawning)
- **Hooks:** Runs `npm run test:run` after Bash commands
- **Key constraints:**
  - Must reproduce the failure before applying a fix
  - Never suppress or skip failing tests
  - Prefer targeted fixes over broad changes
  - Run full test suite to verify no regressions
  - If fix introduces new failures, revert and retry
- **Output:** JSON completion report with `status`, `implements`, `tests`, `files`

## Reviewer

Read-only code quality analysis.

- **Role:** Design compliance, test coverage, code quality checks
- **Tools:** Read, Grep, Glob, Bash (read-only operations only)
- **Disallowed:** Write, Edit, Agent
- **Key constraints:**
  - Never modify code
  - Bash restricted to read-only commands (git diff, git log, dry-run test runners)
  - Specific findings with file paths and line references
  - Categorize findings: critical, warning, suggestion
- **Output:** JSON completion report with `status`, `implements`, `tests`, `files`

## Isolation Model

All agents use `isolation: worktree`, which means each agent operates in its own git worktree. This prevents interference between parallel tasks and keeps the main working tree clean. The orchestrator creates worktrees before dispatch and cleans them up after the workflow completes.
