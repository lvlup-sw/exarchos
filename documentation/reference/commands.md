# Commands

Exarchos provides 17 slash commands. As a Claude Code plugin, they are namespaced under `/exarchos:`.

## Workflow start commands

These commands initialize a new structured workflow and set the workflow type.

### `/exarchos:ideate`

Design exploration. Brainstorm approaches, select one, save a design document.

```bash
/exarchos:ideate "Add webhook support for order events"
```

Entry point for feature workflows. Walks through understanding, exploration, and design presentation phases. After the design document is saved, auto-chains to `/exarchos:plan`. No user confirmation required between ideate and plan.

### `/exarchos:debug`

Bug investigation. Triage, investigate root cause, fix, validate.

```bash
/exarchos:debug "Cart total wrong after removing items"
/exarchos:debug --hotfix "Production login returning 500 errors"
/exarchos:debug --escalate "Requires auth system redesign"
```

| Flag | Effect |
|------|--------|
| (none) | Thorough track -- full root cause analysis, no time limit |
| `--hotfix` | Fast path -- 15-minute time-boxed investigation |
| `--escalate` | Hand off to `/exarchos:ideate` with preserved context |
| `--switch-thorough` | Switch from hotfix to thorough track mid-workflow |

### `/exarchos:refactor`

Code improvement. Assess scope, write brief, implement, validate.

```bash
/exarchos:refactor "Restructure auth module into separate concerns"
/exarchos:refactor --polish "Extract validation logic into utilities"
```

| Flag | Effect |
|------|--------|
| (none) | Overhaul track -- full delegation workflow with worktree isolation |
| `--polish` | Direct implementation, 5 files or fewer, single concern |
| `--explore` | Assess scope before selecting a track |
| `--switch-overhaul` | Switch from polish to overhaul mid-workflow |

### `/exarchos:oneshot`

Lightweight in-session workflow for trivial changes. Plans, implements, and either direct-commits or opens a PR — all within a single TDD loop with no subagent dispatch. Introduced in v2.6.0.

```bash
/exarchos:oneshot "Fix typo in README install section"
/exarchos:oneshot --pr "Add missing null-check to formatDate"
```

| Flag | Effect |
|------|--------|
| (none) | Policy `on-request` (default) — direct-commit unless `request_synthesize` is called mid-stream |
| `--pr` | Policy `always` — always transition through `synthesize` to create a PR |
| `--no-pr` | Policy `never` — always direct-commit, ignore `synthesize.requested` events |

The fork after `implementing` is a pure event-sourced choice state. Call `exarchos_orchestrate { action: "request_synthesize" }` at any time during `plan` or `implementing` to opt into the PR path. Terminal `finalize_oneshot` resolves the decision. See [Oneshot Workflow](/guide/oneshot-workflow) for the full flow.

## Lifecycle commands

These commands move work through the structured workflow pipeline.

### `/exarchos:plan`

Create a TDD implementation plan from a design document. Decomposes features into parallelizable tasks with Red-Green-Refactor phases. After saving the plan, runs plan-review (delta analysis against the design). Auto-loops back to planning if gaps are found. User confirmation is required at the plan-review checkpoint before delegation.

```bash
/exarchos:plan docs/designs/2025-01-15-webhooks.md
```

### `/exarchos:delegate`

Dispatch tasks to agent teammates in isolated git worktrees.

```bash
/exarchos:delegate                    # Initial task delegation from plan
/exarchos:delegate --fixes            # Address review failures
/exarchos:delegate --pr-fixes [URL]   # Address PR feedback
```

Checks task status before dispatching. Skips completed tasks. After all tasks finish, auto-chains to `/exarchos:review` (normal and `--fixes` mode) or `/exarchos:synthesize` (`--pr-fixes` mode).

### `/exarchos:review`

Two-stage review dispatched to subagents. Stage 1 checks spec compliance. Stage 2 checks code quality. Reviews operate on the branch stack diff to minimize context.

- PASS -- auto-chains to `/exarchos:synthesize`
- NEEDS_FIXES -- auto-chains to `/exarchos:delegate --fixes`
- BLOCKED -- auto-chains back to `/exarchos:ideate` for redesign

### `/exarchos:synthesize`

Create a pull request from the feature branch. Runs pre-synthesis checks (tests, typecheck, stack health). Creates stacked PRs with auto-merge enabled. This is a human checkpoint: user confirms merge, requests feedback fixes, or pauses.

```bash
/exarchos:synthesize my-feature
```

### `/exarchos:shepherd`

Push PRs through CI and reviews to merge readiness. Operates as an iteration loop within the synthesize phase: assess stack, fix issues, resubmit, repeat. Maximum 5 iterations before escalating to the user.

```bash
/exarchos:shepherd my-feature
```

### `/exarchos:cleanup`

Resolve a merged workflow to completed state. Verifies PR merge status, removes worktrees, prunes branches, transitions workflow to `completed`.

```bash
/exarchos:cleanup my-feature
```

### `/exarchos:tdd`

Plan implementation using strict Red-Green-Refactor protocol. Each step is labeled with its TDD phase and includes test verification. Uses the implementation-planning skill.

```bash
/exarchos:tdd "Add rate limiting to API endpoints"
```

## Context management commands

These commands handle session persistence and context optimization.

### `/exarchos:checkpoint`

Save workflow state for session handoff. Captures current phase, task progress, artifacts, and worktree locations. Use when context is getting heavy, before long operations, or at natural workflow boundaries.

```bash
/exarchos:checkpoint
```

### `/exarchos:rehydrate`

Restore workflow state after context compaction or a session break. Discovers active workflows via the MCP pipeline view, fetches state and phase playbook, and renders a compact behavioral context block. Typically produces 2-3k tokens of output.

```bash
/exarchos:rehydrate
```

### `/exarchos:reload`

Re-inject behavioral guidance after context degradation. Lighter than rehydrate. Triggers the PreCompact hook to save state, then `/clear` restarts the session with the SessionStart hook injecting pre-computed context.

```bash
/exarchos:reload
```

### `/exarchos:autocompact`

Toggle autocompact on/off or set a threshold percentage. Manages the `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` setting.

```bash
/exarchos:autocompact status    # Show current state
/exarchos:autocompact on        # Enable at 95%
/exarchos:autocompact off       # Disable
/exarchos:autocompact 80        # Set to 80%
```

## Maintenance commands

### `/exarchos:prune`

Bulk-cancel stale non-terminal workflows from the pipeline view. Interactive dry-run → confirm → apply UX. Introduced in v2.6.0.

```bash
/exarchos:prune                        # dry-run, default 7-day threshold
/exarchos:prune --threshold 1440       # 1-day threshold (minutes)
/exarchos:prune --force                # bypass safeguards (still audited)
```

Invokes `exarchos_orchestrate { action: "prune_stale_workflows" }`. Safeguards skip workflows with open PRs or recent commits unless `--force` is passed. Each pruned workflow emits a `workflow.pruned` event carrying `stalenessMinutes`, `triggeredBy`, and optional `skippedSafeguards` for audit. See [prune_stale_workflows](/reference/tools/orchestrate#prune_stale_workflows) for the underlying action.

## Attribution

### `/exarchos:tag`

Retroactively attribute the current session to a feature, project, or concern. Emits a `session.tagged` event to a shared tags stream. Useful for ad-hoc work outside structured workflows.

```bash
/exarchos:tag "auth-migration"
```
