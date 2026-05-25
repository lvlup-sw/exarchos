# Hook Layer Is Observe-Only; Enforcement Moves Into the MCP Tools

**Date:** 2026-05-24
**Status:** Accepted
**Issue:** [#1476](https://github.com/lvlup-sw/exarchos/issues/1476)
**References:**
- [docs/research/2026-05-24-hooks-templating-and-invariants-onboarding.md](../research/2026-05-24-hooks-templating-and-invariants-onboarding.md) — Round 2, Directive A
- [docs/research/2026-05-14-entireio-cli-harness-strategy.md](../research/2026-05-14-entireio-cli-harness-strategy.md) — "Lesson E" (harness-control vs lifecycle-observer hooks)
- T-40 rehydration-machinery refactor (auto-resume → user-invoked `/checkpoint` + `/rehydrate`)

---

## Context

Exarchos shipped six hand-authored, Claude-only hooks in
[`hooks/hooks.json`](../../hooks/hooks.json). These split into two kinds:

| Hook event   | `exarchos` subcommand | Kind                                | Prior role                                                  |
|--------------|-----------------------|-------------------------------------|-------------------------------------------------------------|
| `PreToolUse` | `guard`               | **enforcement** (blocks tool exec)  | Intercepts every Exarchos MCP tool call, rejects out-of-phase calls at the harness boundary |
| `TaskCompleted` | `task-gate`        | **enforcement** (gates)             | Runs quality checks on task completion                      |
| `TeammateIdle`  | `teammate-gate`    | **enforcement** (verify)            | Verifies teammate work, emits team events                  |
| `SubagentStart` | `subagent-context` | **control** (injects context)       | Injects phase/role-filtered tool context into a subagent   |
| `SubagentStop`  | `subagent-stop`    | observer-ish (cleanup)              | Subagent completion cleanup                                 |
| `SessionEnd`    | `session-end`      | **observer** (cleanup)              | Session transcript capture / manifest completion           |

The hooks were hand-authored, Claude-shaped, and lived entirely outside the
per-runtime skill-templating pipeline, even though every `runtimes/<name>.yaml`
already declares a `hasHooks` capability (`true` only for `claude`). The renderer
*knew* which runtimes support hooks but had no pass that *emitted* hook config.

Two things were wrong with this posture:

1. **Enforcement at the hook layer is the wrong layer.** The `PreToolUse` guard is
   the only thing that *forces* the harness through Exarchos's phase guardrails, but
   the MCP tools already self-validate phase/role on every action. The hook is a
   second, Claude-only copy of a contract the tools own. It cannot be templated to
   the other tier-1 runtimes (Codex, Cursor, OpenCode, Copilot) without re-deriving
   the harness boundary per runtime — work that duplicates the in-tool validation.

2. **Hand-authored hooks drift.** They are off the templating pipeline, so the
   `hasHooks` flag is prose-only and nothing regenerates or guards the artifact.

## Decision

**The hook layer is observe-only. All enforcement moves entirely inside the MCP
tools.** Hooks become a first-class, per-runtime *templated* artifact produced by a
`buildAllHooks()` pass (sibling to `buildAllSkills()`), driven by the `hasHooks`
capability. The generated Claude artifact lands at the well-known `hooks/hooks.json`
plugin path so it stays auto-loaded; non-`hasHooks` runtimes emit nothing (or a
documented manual-steps note).

The four enforcement/control hooks (`guard`, `task-gate`, `teammate-gate`,
`subagent-context`) are retired along with their orphaned CLI handlers. The two
observer hooks (`SessionEnd` / `session-end`, `SubagentStop` / `subagent-stop`) are
kept and re-cast as pure observers.

### (a) The DROPPED `guard` `PreToolUse` enforcement contract

Retiring the `PreToolUse` guard means **out-of-phase MCP tool calls are no longer
pre-empted at the harness boundary.** The matcher
`mcp__(plugin_exarchos_)?exarchos__.*` was the only thing that blocked an
out-of-phase call *before* the tool ran.

This is **intentional behavior loss**, accepted by the maintainer. The new posture
is **observe, don't enforce at the hook layer**:

- The MCP tools still self-validate phase and role on every action (the dispatch
  layer rejects mutating actions for read-only roles, validates the current phase,
  etc.). Enforcement is not gone — it moves wholly into the tools, where it is
  runtime-agnostic and already exists.
- What is lost is the *pre-emption* at the harness boundary: an out-of-phase call
  now reaches the tool and is rejected *there* (advisory at the boundary, hard at
  the tool) rather than being blocked by the harness before the tool executes.
- This loss applies symmetrically across runtimes — there was never a Codex/Cursor/
  OpenCode/Copilot equivalent of the guard, so retiring it removes a Claude-only
  asymmetry rather than introducing one.

The same reasoning retires `task-gate`, `teammate-gate`, and `subagent-context`:
each is enforcement or context-injection that either belongs in the tools or is
superseded by the workflow-managed quality gates. `task-gate` already short-circuits
when an active Exarchos workflow is managing quality gates, so the workflow path is
the real enforcement surface.

### (b) The observer event set

The end-state observer set is fire-and-report signals on harness lifecycle events —
they record provenance/telemetry without blocking:

- **session start / session stop** — session lifecycle boundaries
- **subagent start / subagent stop** — subagent lifecycle boundaries
- **compaction** — context-window compaction events
- **tool-use error** — tool invocation failures

Today only the two pre-existing observers (`SessionEnd`/`session-end` and
`SubagentStop`/`subagent-stop`) are wired in the generated Claude artifact; the
remaining observer events are the templating target this `buildAllHooks()` spine is
designed to grow into. Observers never return a blocking/deny decision — they emit
and report.

### (c) Why re-introducing T-40-removed lifecycle events is justified now

T-40 (the rehydration-machinery refactor) deliberately removed the `SessionStart`
and `PreCompact` hooks because they were **auto-resume drivers** — the harness would
fire them and Exarchos would silently resume/rehydrate a workflow, which proved
fragile. Rehydration was moved to explicit, user-invoked `/checkpoint` + `/rehydrate`
commands.

Re-introducing session/compaction lifecycle events as part of the observer set does
**not** reverse that decision, because the new events are **observers/telemetry, not
auto-resume drivers.** They record that a session started or a compaction happened;
they do not trigger any state transition, resume, or rehydration. The thing T-40
removed (implicit auto-resume on lifecycle events) stays removed. What returns is a
strictly weaker, non-mutating signal. This is a cleaner justification than treating
them as a partial revert of T-40 — the auto-resume coupling that made the original
hooks fragile is exactly what is excluded.

## Consequences

- **Positive.** Hooks become a templated, per-runtime, CI-guarded artifact
  (`hooks:guard`). The `hasHooks` capability becomes load-bearing. Enforcement has a
  single home (the MCP tools). The Claude-only guard asymmetry is removed.
- **Negative / accepted.** No harness-boundary pre-emption of out-of-phase calls;
  enforcement is advisory at the boundary and hard at the tool. The four enforcement/
  control CLI handlers (`guard.ts`, the enforcement paths in `gates.ts`,
  `subagent-context.ts`) are deleted; they were only auto-fired by the retired hooks.
- **Follow-up.** The full observer event set (session start, compaction, tool-use
  error) is the `buildAllHooks()` templating target; only the two existing observers
  ship in this change. Lifecycle-observer expansion and any `settings.json` mutation
  remain out of scope (no direct config-file mutation — that is what the plugin format
  exists to avoid).
