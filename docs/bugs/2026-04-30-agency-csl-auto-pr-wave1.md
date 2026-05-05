# Exarchos issues observed during `agency-csl-auto-pr` wave-1 delegation

**Session:** `e9caf7c0-b04e-40b1-84ed-2118a04bb651`
**Date:** 2026-04-30
**Workflow:** `agency-csl-auto-pr` (feature, delegate phase)
**Runtime:** GitHub Copilot CLI 1.0.40-2 on Windows
**Exarchos surfaces exercised:** `exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`

This document catalogs every issue I hit while taking three foundation tasks (T001 plugin scaffold, T002 Kusto schema, T022 DR-9 spike) from rehydrate → dispatch → gate → merge → checkpoint. None blocked completion, but each cost a turn or required a workaround. Items are ordered roughly by severity (impact × frequency).

---

## P1 — high impact, easy to hit

### 1. `setup_worktree` reports `.worktrees is gitignored` as PASS even when it is not
**Action:** `exarchos_orchestrate({ action: "setup_worktree", … })`
**Observed:** The setup report returned `**PASS**: .worktrees is gitignored` for all three wave-1 worktrees, but inspection of the repo's `.gitignore` showed no `.worktrees/` entry. Subsequent `merge_orchestrate` calls then failed preflight with `uncommitted changes: 1 file(s) [.worktrees/]` because the worktree directory appeared as untracked in the main repo status.
**Reproduction:**
```
exarchos_orchestrate setup_worktree --repoRoot <repo> --taskId 001 --taskName scaffold --baseBranch <integration>
# inspect: Get-Content .gitignore | Select-String "worktree"  # → empty
# inspect: git status                                         # → "Untracked files: .worktrees/"
```
**Expected:** Either (a) the action actually appends `.worktrees/` to `.gitignore` if missing (per the worktree-enforcement.md description), or (b) the check accurately reports `FAIL: .worktrees/ is not in .gitignore — add it before merging`.
**Workaround:** Append `.worktrees/` to `.gitignore` manually and commit before the first `merge_orchestrate`.

### 2. Implementer-prompt template causes agents to abort on the first turn (Copilot CLI runtime)
**Surface:** `references/implementer-prompt.md` worktree-verification block
**Observed:** The template tells the agent to `pwd` and `STOP` if the path doesn't contain `.worktrees`. On Copilot CLI's `general-purpose` subagent, the spawned subprocess inherits the parent's cwd (the main repo root, not the worktree). Two of three agents (impl-t001-scaffold, impl-t002-kusto-schema) aborted on turn 0 with `ERROR: Working directory is not the <id> worktree. Aborting.` and never did any work. I had to send a follow-up `write_agent` message instructing each to `Set-Location $WT` first.
**Expected:** The template's first instruction should be **`cd` into the worktree**, then verify. Phrased as a recovery instead of an abort prevents the dead-on-arrival failure mode on runtimes that don't natively chdir agents into a working directory.
**Suggested patch:** Add to template, before the verification block:
```
Your shell may have started in the parent repo cwd. Your FIRST command must be:

  Set-Location "<absolute worktree path>"   # PowerShell
  cd "<absolute worktree path>"             # bash

Only after that, verify pwd contains .worktrees and proceed.
```
**Note:** Native-isolation runtimes (e.g., Claude Code's `isolation: worktree`) won't see this issue; the bug is specific to runtimes that spawn subagents in the parent cwd.

### 3. `prepare_delegation` blocks with `Plan artifact is missing` even when `artifacts.plan` is set
**Action:** `exarchos_orchestrate({ action: "prepare_delegation", featureId, tasks, … })`
**Observed:** With `workflow.artifacts.plan` set to either a repo-relative path (`docs/plans/2026-04-29-agency-csl-auto-pr.md`) or an absolute path (`C:/…/docs/plans/2026-04-29-agency-csl-auto-pr.md`), and the file confirmed present (`Test-Path` → True), `prepare_delegation` returns:
```json
{ "ready": false, "blockers": ["Plan artifact is missing"] }
```
The parallel `exarchos_view delegation_readiness` view does NOT report this blocker — only `prepare_delegation` does — which suggests `prepare_delegation` runs an extra file-existence check resolving the path against an unexpected root (likely the MCP server's cwd, not the repo root or `featureId`-derived location).
**Expected:** Use the same path resolution as the readiness view, or fall back to "exists in workflow state" when filesystem check is ambiguous, or accept a `repoRoot` parameter to disambiguate.
**Workaround:** Ignore the false negative and proceed manually with `setup_worktree` + dispatch.

### 4. `prepare_delegation`'s `worktrees.expected` counts ALL `task.assigned` events, not just the wave being prepared
**Action:** `exarchos_orchestrate({ action: "prepare_delegation", featureId, tasks: [3 wave-1 entries], … })`
**Observed:** Even when `tasks` was a 3-entry array, the response shows `worktrees: { expected: 33, ready: 0 }` — i.e., the readiness view treats the 33 pre-emitted `task.assigned` events as the canonical "expected worktree count" and ignores the `tasks` arg as a filter. This produces blocker `"33 worktrees pending"` and `ready: false` whenever delegation is dispatched in waves (which the design doc explicitly recommends for any plan over a handful of tasks).
**Expected:** The `tasks` arg should narrow the `worktrees.expected` count to the wave being prepared. Or, if the design intent is "prepare = prepare-everything-up-front", the skill docs should call this out and the workflow should support multiple `prepare_delegation` invocations across waves.
**Workaround:** Pass `nativeIsolation: true` (which is documented for runtimes with native worktree isolation, but happens to also bypass the count check). Then run `setup_worktree` manually for each wave's tasks.

---

## P2 — moderate impact, predictable

### 5. `setup_worktree` ignores planned branch names from workflow state
**Action:** `exarchos_orchestrate({ action: "setup_worktree", taskId, taskName, baseBranch, … })`
**Observed:** Workflow state has `tasks[id=001].branch = "feature/agency-csl-auto-pr/t001-scaffold"` (set by the planning skill / state-reconciliation). `setup_worktree` creates a branch named `feature/001-scaffold` (literal `feature/<taskId>-<taskName>`) and ignores the planned name. The action's schema has no `branch` parameter to override the default.
**Expected:** Either accept a `branch` parameter, or default to reading `workflow.tasks[id=<taskId>].branch` when present.
**Impact:** Cosmetic — merges still work. But planning artifacts and audit trails reference a different branch name than what actually exists, which is confusing for a reviewer.

### 6. `merge_orchestrate` ancestry check is strict and forces a rebase per merge when integration advances
**Action:** `exarchos_orchestrate({ action: "merge_orchestrate", sourceBranch, targetBranch, … })`
**Observed:** After a non-task commit lands on the integration branch (e.g., the `.gitignore` chore commit I added to fix issue #1), every wave-1 source branch failed the ancestry check with `ancestry missing: feature/agency-csl-auto-pr` because the source branches were created from the original integration HEAD. I had to `git fetch && git rebase feature/agency-csl-auto-pr && git push --force-with-lease` before each merge.
**Expected:** Optional auto-rebase (with rollback SHA captured as today), or fall back to `--no-ff` merge after a fast-forward catch-up, or document the strict-ancestry contract clearly so the user knows to rebase up front.
**Impact:** Three rebase round-trips for three wave-1 tasks; would have been nine for nine tasks.

### 7. `task.completed` with worktree association does not visibly trigger the `merge-pending` HSM detour
**Skill claim** (`delegation/SKILL.md` § "Worktree-Bearing Tasks: Auto-Detour to merge-pending"):
> When a `task.completed` event carries a worktree association (`data.worktree` or `data.worktreePath`), the HSM auto-transitions through `feature/merge-pending` … `next_actions` projection surfaces a `merge_orchestrate` verb …
**Observed:** I included both `worktree` and `worktreePath` in the `task_complete` `result` payload for all three wave-1 tasks. After each call, `next_actions` was `[]` and the workflow phase stayed at `delegate`. I had to invoke `merge_orchestrate` manually.
**Expected:** Either the verb appears in `next_actions`, or the skill docs are updated to say "manual merge step" for runtimes that don't consume `next_actions` (Copilot CLI is one).

### 8. `prepare_delegation` does not document its overlap with `delegation_readiness` view
**Surface:** Skill docs + tool descriptions
**Observed:** Both `exarchos_orchestrate prepare_delegation` and `exarchos_view delegation_readiness` query the same plan/quality/worktree readiness state, but they apply different blocker rules (delegation_readiness reports 1 of the 2 blockers I hit; prepare_delegation reports both). Without reading both, I almost concluded the plan artifact path was actually broken.
**Expected:** Either consolidate to one source of truth, or document the difference in the skill so it's clear which one is authoritative.

---

## P3 — low impact, surface polish

### 9. `exarchos_workflow set` `updates` syntax for adding new array entries is undocumented
**Surface:** `workflow-state/SKILL.md` § "Update State" + `tasks[id=NNN].field` examples
**Observed:** The docs show updating existing array entries (`tasks[id=001].status: "complete"`) but never demonstrate adding a new array entry. To add T032 + T033 to the tasks array (closing a state-vs-plan desync from plan-review revision 2), I serialized the entire 33-entry tasks array and pushed it as `updates: { "tasks": [...] }` rather than risk that `tasks[id=032]: {...}` would silently fail or overwrite the wrong entry.
**Expected:** Document the supported syntax for array insertion explicitly. Or surface it via `exarchos_workflow describe action=set`.

### 10. State-vs-plan desync after plan-review revision is silent
**Observed:** Plan-review revision 2 (recorded in state checkpoint summary) added T032 + T033 to the plan, bringing total tasks from 31 → 33. But `workflow.tasks` still had only 31 entries when I rehydrated. There's no view or check that flags `plan.taskCount (33) != state.tasks.length (31)`.
**Expected:** A diagnostic in `delegation_readiness` view, or in `prepare_delegation`, that flags this drift. Alternatively, the plan-review skill could emit a `state.tasks_synced` event after revision approval, and absence of that event would be a missing-events hint.

### 11. `_eventHints` `task.assigned` `requiredFields` does not include `branch`
**Surface:** `_eventHints` from `exarchos_workflow get`
**Observed:** Event hint says `task.assigned requiredFields: ["taskId", "title"]`. But `workflow.tasks[].branch` is structured data and consumers like `setup_worktree` could (per issue #5) honor it. If `branch` is a useful field on the assignment event, list it; if it isn't, having it in the workflow state but not in the event creates two sources of truth.
**Impact:** Minor consistency. I included `branch` in my batch_append payload anyway since the workflow state had it.

### 12. `setup_worktree` "PASS: install" is silently skipped for non-Node repos
**Observed:** The setup report says `**SKIP**: install — No project markers detected. Add a .exarchos.yml with test/typecheck/install commands or pass an override.` This worked fine for our case (this is an Azure infra repo — Bicep/PowerShell/KQL, no `package.json`). But the SKIP message implies users should usually have an `.exarchos.yml` — and there's no doc link in the message pointing to the schema for that file.
**Expected:** Include a link or example fragment in the SKIP message.

### 13. Static analysis check passes vacuously when no toolchain is detected
**Action:** `check_static_analysis`
**Observed:** Returns `**PASS**: 0/0 checks — no applicable toolchain detected` for repos with no `package.json` / `*.csproj` / `go.mod` / `Cargo.toml`. The integration branch in this case has KQL, PowerShell tests, and JSON manifests — none of which trigger the toolchain detection.
**Expected:** Either treat as `SKIP` rather than `PASS` (so dimension D2 gate is honestly inconclusive rather than falsely green), or extend the toolchain detection to PowerShell (PSScriptAnalyzer) and KQL (any KQL linter).
**Impact:** D2 dimension shows green in convergence view despite no analysis having occurred.

---

## Things that worked well (so the report isn't all complaints)

- `exarchos_workflow rehydrate` returned a clean, compact view of the workflow with task-progress projection — perfect for restarting context after a session boundary.
- `exarchos_event batch_append` for 33 events took 25ms total. Excellent throughput.
- `merge_orchestrate` with `dryRun: true` showed the rollback SHA up front — gave me confidence to land each merge.
- `check_tdd_compliance` correctly classified non-code commits (T022 design-doc-only) as SKIP rather than failing them, and correctly classified T001's manifest-and-test commit as PASS.
- `_eventHints` next-step suggestions ("emit team.spawned, team.task.planned, team.teammate.dispatched") are exactly what an orchestrator needs to know what saga events to emit. Don't lose this pattern.
- `exarchos_workflow checkpoint` accepted my long summary verbatim — useful for handoffs across sessions.

---

## Suggested triage

If I had to prioritize fixes, this is the order:

1. **Issue #1 (gitignore false PASS)** — easy to fix in `setup_worktree`, blocks every `merge_orchestrate` until manually resolved.
2. **Issue #2 (implementer prompt cwd)** — single-line patch to the prompt template, eliminates the most common dead-on-arrival failure on non-native-isolation runtimes.
3. **Issue #4 (prepare_delegation expects all worktrees)** — actively works against the documented "wave-by-wave" dispatch pattern.
4. **Issue #3 (Plan artifact missing false negative)** — shows up alongside #4; if both are fixed, `prepare_delegation` becomes useful instead of a thing to bypass.
5. **Issue #6 (ancestry strictness)** — predictable but expensive when the integration branch advances.
6. Everything else is polish.
