---
alwaysApply: true
name: orchestrator-constraints
description: "Main Claude Code session coordinates but does not write implementation code."
---

# Orchestrator Constraints

The orchestrator (main Claude Code session) MUST NOT:
1. Write implementation code — all code via subagents in worktrees
2. Fix review findings directly — dispatch fixer subagents
3. Run integration tests inline — tests in subagent worktrees
4. Work in main project root — all implementation in worktrees

The orchestrator SHOULD: parse/extract plans, dispatch/monitor subagents, manage workflow state, chain phases, handle failures.

## Exception: Polish Track Refactors

During `polish-implement` phase ONLY, the orchestrator MAY write code directly. Guardrails: only polish track, stay within brief scope, follow TDD if changing behavior. Switch to overhaul if >5 files or cross-module changes.
