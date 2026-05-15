# Exarchos MCP — Dogfood Findings, 2026-05-13

**Source session:** `ev2-mcp-output-contract-agent-surface` workflow rehydrate + wave-3a merges (Copilot CLI, Claude Opus 4.7, Windows 11).
**Method:** MCP self-service introspection (`describe`, `view pipeline`, `view telemetry`, `event query`) cross-referenced against observed responses and git state.
**Scope:** Six findings — three code bugs and three documentation gaps. One operator-error class (improvised action/event names) was self-corrected by the server's enumerated error responses and is not filed.

| #  | Bucket   | Severity | Title                                                                                            |
|----|----------|----------|--------------------------------------------------------------------------------------------------|
| F1 | 🐞 Code  | HIGH     | `merge_orchestrate` rolls back to an unrelated SHA when target branch is checked out elsewhere   |
| F2 | 🐞 Code  | MEDIUM   | Ancestry preflight false-positive on clean fast-forward branches                                 |
| F3 | 🐞 Code  | MEDIUM   | `rehydrate.taskProgress` and `view pipeline` counts diverge from canonical `tasks[].status`      |
| F4 | 📚 Docs  | MEDIUM   | `workflow update` reserved fields are not enumerated in `describe` or the workflow-state skill   |
| F5 | 📚 Docs  | MEDIUM   | `merge-orchestrator` skill is silent on multi-worktree target topology                           |
| F6 | 📚 Docs  | LOW      | Empty `merge-pending` runbook + `view telemetry` undercounts action-level errors                 |

**Filing notes**
- F1, F2, F3 → Exarchos MCP server repo.
- F4, F5, F6 → Exarchos skills/docs repo (or wherever `merge-orchestrator/SKILL.md` and `workflow-state/SKILL.md` live).
- Suggested priority: **F1 > F3 > F2 > F5 > F4 > F6**. F1 didn't corrupt data here only by luck — it returned a `rollbackSha` pointing at an unrelated commit on a third branch, which is a foot-gun for any operator who scripts further actions on it.
- F1 ↔ F5 are tightly coupled: closing one without the other still leaves a sharp edge.

---

## F1 — `merge_orchestrate` rolls back to an unrelated SHA when target branch is checked out elsewhere

**Bucket:** code-bug · **Severity:** HIGH
**Component:** exarchos-mcp / `merge_orchestrate`
**Suggested labels:** `bug`, `merge-orchestrator`, `multi-worktree`, `severity:high`
**Related:** F5 (skill docs gap), F2 (preflight)

### Summary

`merge_orchestrate` returned `MERGE_ROLLED_BACK / reason: merge-failed` even though the underlying merge was a **clean fast-forward with zero conflicts** (verified by manually running `git merge --no-ff` in the target worktree afterward). The reported `rollbackSha` pointed at a commit on the **invoker's currently-checked-out feature branch** — not on the merge target — which is a foot-gun: an operator inspecting `rollbackSha` could reasonably assume the integration branch had been touched and reset, when in fact nothing happened to it.

The trigger is a topology the skill doesn't address: the target branch is checked out in a sibling git worktree (e.g., `.worktrees/integration`), so the orchestrator's invoker process can't switch the main worktree onto it.

### Environment

- **OS:** Windows 11
- **Repo:** local-only feature branches (no `origin/feature/*` remotes)
- **Worktree layout:**
  - Main worktree: `C:\...\repo` on branch `dev/salusreed/refactor-dogfood-followups`
  - `.worktrees/integration` on branch `feature/ev2-mcp-output-contract/integration`
  - `.worktrees/wave-3a-cross-link` on branch `feature/ev2-mcp-output-contract/wave-3a-cross-link`

### Reproduction

1. From a repo where the target merge branch is checked out in a non-main worktree:
   ```
   git worktree list
   # /repo                     <sha> [some-feature-branch]
   # /repo/.worktrees/target   <sha> [target-branch]
   # /repo/.worktrees/source   <sha> [source-branch]
   ```
2. With main worktree on `some-feature-branch` (NOT `target-branch`), invoke:
   ```ts
   exarchos_orchestrate({
     action: "merge_orchestrate",
     featureId: "<id>",
     sourceBranch: "source-branch",
     targetBranch: "target-branch",
     strategy: "merge",
     repoRoot: "/repo"
   })
   ```
3. (Preflight passes after addressing ancestry / drift — see F2 and F4.)

### Observed

```json
{
  "success": false,
  "error": {
    "code": "MERGE_ROLLED_BACK",
    "message": "Merge of source-branch into target-branch rolled back: merge-failed"
  },
  "data": {
    "phase": "rolled-back",
    "rollbackSha": "<HEAD of some-feature-branch>",   // ← SURPRISE
    "reason": "merge-failed"
  }
}
```

After the call:

- `target-branch` HEAD is **unchanged** (no merge attempted, no rollback needed).
- `some-feature-branch` HEAD is **also unchanged** (the "rollback" was a no-op `git reset --hard HEAD`).
- The integration worktree (`.worktrees/target`) is untouched.
- No `merge.executed` event in the stream; a `merge.rollback` event with `rollbackSha` pointing at the unrelated branch's tip.

### Server-side evidence (this session)

`merge.rollback` event (sequence 271):
```json
{
  "type": "merge.rollback",
  "data": {
    "sourceBranch": "feature/ev2-mcp-output-contract/wave-3a-cross-link",
    "targetBranch": "feature/ev2-mcp-output-contract/integration",
    "rollbackSha": "2fd03bd3fddc1d8811296248a037c37d70d2272b",
    "reason": "merge-failed"
  }
}
```
`2fd03bd` is the tip of `dev/salusreed/refactor-dogfood-followups` (a `chore(gitignore)` commit I had just made). It is **not** an ancestor of `feature/ev2-mcp-output-contract/integration`. Resetting integration to that SHA would have been destructive — it just happens that nothing ran the reset.

The same pattern appears in event sequence 101 from the prior day for a `wave-2a-skills` attempt, suggesting this is reproducible whenever the invoker isn't on the target branch.

### Expected

One of:

1. **Auto-detect the target worktree.** If `git worktree list` shows the target branch checked out at a sibling worktree, run the merge there (where it's safe and natural) instead of the invoker's cwd worktree.
2. **Fail preflight cleanly.** Add a guard `targetWorktreeAvailability` that returns:
   ```json
   {
     "passed": false, "blocked": true,
     "reason": "target-branch-checked-out-elsewhere",
     "checkedOutAt": ".worktrees/target",
     "hint": "Re-invoke with repoRoot=.worktrees/target, or detach the target branch from that worktree first."
   }
   ```
   Crucially: do **not** capture a `rollbackSha` from an unrelated branch and then claim a rollback "succeeded".

Either fix avoids the silent foot-gun in current behavior.

### Workaround (used in-session)

```powershell
cd .worktrees/integration
git merge --no-ff feature/ev2-mcp-output-contract/wave-3a-cross-link
# clean merge, 1133/1133 tests pass
```
…then manually `exarchos_event append({type:"merge.executed", ...})` to keep the event stream coherent. The merge-orchestrator skill labels this as recovery-only — that label should soften if F1 isn't fixed.

---

## F2 — Ancestry preflight false-positive on clean fast-forward branches

**Bucket:** code-bug · **Severity:** MEDIUM
**Component:** exarchos-mcp / `merge_orchestrate` / `preflight.ancestry`
**Suggested labels:** `bug`, `merge-orchestrator`, `preflight`, `severity:medium`

### Summary

`merge_orchestrate` preflight reports `ancestry.passed: false` with `missing: ["<targetBranch>"]` and the hint "source branch ... is not a descendant of target" — even when the source IS a clean linear descendant of the target (verifiable via `git merge-base --is-ancestor target source` returning 0).

The check passes after running `git rebase <target>` in the source worktree, **even though that rebase is reported as a no-op** ("Current branch is up to date"). This indicates the check is sensitive to git state that gets touched by `rebase` but not actually changed by it (likely `ORIG_HEAD`, `MERGE_HEAD`, reflog, or similar markers — not the branch ref itself).

### Reproduction

1. Create a target branch with one commit:
   ```bash
   git checkout -b target && git commit --allow-empty -m "target tip"
   ```
2. Branch a source from target's tip and add 2 commits:
   ```bash
   git checkout -b source target
   git commit --allow-empty -m "src 1"
   git commit --allow-empty -m "src 2"
   ```
3. Verify ancestry the git way:
   ```bash
   git merge-base --is-ancestor target source && echo "target IS ancestor of source"
   git merge-base source target  # prints target's tip SHA
   ```
4. Invoke preflight:
   ```ts
   exarchos_orchestrate({
     action: "merge_orchestrate", featureId: "<id>",
     sourceBranch: "source", targetBranch: "target",
     strategy: "merge", dryRun: true, repoRoot: "<path>"
   })
   ```

### Observed

```json
{
  "preflight": {
    "passed": false,
    "ancestry": {
      "passed": false, "blocked": true, "reason": "ancestry",
      "missing": ["target"],
      "hint": "source branch source is not a descendant of target. Rebase manually with: git rebase target (run from the source worktree)."
    }
  }
}
```

Then in the source worktree:
```bash
$ git rebase target
Current branch source is up to date.
```
…re-invoke preflight → `ancestry.passed: true`. Same git refs, same SHAs.

### Server-side evidence (this session)

Three consecutive `merge.preflight` events on the same branch pair, no other repo changes between them:

| Seq | Time     | `ancestry.passed` | Action between events                                      |
|-----|----------|-------------------|------------------------------------------------------------|
| 263 | 18:24:50 | `false`           | (initial call)                                             |
| 265 | 18:26:09 | `true`            | ran `git rebase` in source worktree (no-op)                |
| 267 | 18:27:30 | `true`            | committed `.gitignore` cleanup on a *third* branch (unrelated) |

Source branch tip (`4c3f83a`) at all three points, target branch tip (`fec128e`) at all three points, `git merge-base 4c3f83a fec128e == fec128e` at all three points. The only thing that changed was something inside `.git/` that `git rebase` touches as bookkeeping.

### Hypothesis (root cause candidates)

Rough order of likelihood:

1. **Wrong direction or wrong refs.** The check might run `git rev-list source..target` and consider non-empty output as "missing commits" — correct semantics for "source contains all of target's commits," but if it's reading from the cwd worktree (which was on a third branch), the comparison resolves against unexpected HEAD context.
2. **Stale ref cache.** The orchestrator may cache branch tips on first invocation per process; a no-op `rebase` invalidates whatever cache key git uses, forcing a re-read.
3. **Symbolic ref dependence.** The check reads `ORIG_HEAD` or another symbolic ref that doesn't exist until a rebase/merge runs once.
4. **Origin-tracking assumption.** If the check looks for `refs/remotes/origin/<targetBranch>` and falls back to local on absence, the local-only feature-branch repo may trip a code path that mis-reports.

### Expected / Suggested fix

Replace the current ancestry implementation with a direct `git merge-base --is-ancestor <target> <source>` call (exit 0 = pass, exit 1 = fail) executed inside `repoRoot` with the worktree of the source or target branch (not the invoker's arbitrary cwd worktree). This is the simplest correct semantics for "source can be merged into target without rewriting target's history."

Add a regression test that invokes preflight from a worktree on an unrelated third branch, with source as a clean fast-forward of target.

### Workaround

Run `git rebase <target>` in the source worktree before each preflight attempt — it's a no-op when ancestry is already clean, but "warms" whatever the buggy check is reading.

---

## F3 — `rehydrate.taskProgress` and `view pipeline` counts diverge from canonical `tasks[].status`

**Bucket:** code-bug · **Severity:** MEDIUM
**Component:** exarchos-mcp / projections (`rehydrate`, `view pipeline`)
**Suggested labels:** `bug`, `projection`, `rehydrate`, `severity:medium`
**Related:** F4 (workflow-state skill)

### Summary

Two read paths for task status report stale data:

1. **`exarchos_workflow rehydrate`** returns a `taskProgress` array whose `status` values lag behind the persisted `tasks[].status` from `exarchos_workflow get`. In this session, ~30 tasks were marked `assigned` in `taskProgress` while `get` showed them as `complete` — a difference of ~10 minutes to ~24 hours, depending on the task.
2. **`exarchos_view pipeline`** returns `taskCount: 53, completedCount: 20` for a workflow whose `get` shows 67 tasks with 56 complete.

The workflow-state skill explicitly claims "the rehydration projection folds events newer than the last snapshot." Observed behavior contradicts this — folding is either not happening or not capturing `task.completed` events.

This is a safety issue for multi-agent workflows: an agent that uses `rehydrate` (the documented entry point for resuming after context loss) and trusts `taskProgress` as ground truth could redo completed work or dispatch sub-agents to tasks that are already done.

### Reproduction

1. Start a workflow with at least one task:
   ```ts
   exarchos_workflow({ action: "init", featureId: "demo", workflowType: "feature" });
   exarchos_workflow({ action: "update", featureId: "demo", updates: {
     tasks: [{ id: "T1", title: "demo", status: "pending" }]
   }});
   ```
2. Mark it complete via the canonical path:
   ```ts
   exarchos_orchestrate({ action: "task_complete", streamId: "demo", taskId: "T1",
     evidence: { type: "test", output: "ok", passed: true }});
   ```
3. Verify it's complete via `get`:
   ```ts
   exarchos_workflow({ action: "get", featureId: "demo", query: "tasks" });
   // → [{ id: "T1", status: "complete" }]
   ```
4. Trigger projection rebuild boundary (or wait long enough that snapshot is older than the task.completed event), then:
   ```ts
   exarchos_workflow({ action: "rehydrate", featureId: "demo" });
   // → taskProgress: [{ id: "T1", status: "assigned" }]   // ← STALE
   ```
5. Same divergence in pipeline view:
   ```ts
   exarchos_view({ action: "pipeline" });
   // → workflow shows completedCount lower than actual tasks[].status counts
   ```

### Observed (this session)

`rehydrate` output (fresh call):
```json
{
  "taskProgress": [
    {"id": "B1", "status": "assigned"},
    {"id": "B2", "status": "assigned"},
    /* ... B3-B7, C1-C7, D1-D9, H1-H9 all "assigned" ... */
    {"id": "G6", "status": "pending"}
  ]
}
```

`get` for the same workflow, same instant:
```json
{
  "tasks": [
    {"id": "B1", "status": "complete"},
    {"id": "B2", "status": "complete"}
    /* ... all the "assigned" ones above are actually "complete" ... */
  ],
  "_version": 60,
  "_checkpoint": { "summary": "55/67 tasks complete", "timestamp": "2026-05-13T18:16:50.187Z" }
}
```

`view pipeline` snippet:
```json
{
  "featureId": "ev2-mcp-output-contract-agent-surface",
  "phase": "delegate",
  "taskCount": 53, "completedCount": 20
}
```
…vs. `get`'s `tasks.length === 67` with 56 complete. The pipeline counts are stale and use a different `taskCount` (53 vs 67), suggesting it reads from yet a third projection.

### Root cause hypothesis

Three plausible candidates:

1. **Snapshot-only path.** `rehydrate` returns a cached projection snapshot and skips the documented "fold newer events" step. Code may have a fast path that the spec contradicts.
2. **Different update path.** Tasks were marked complete via `exarchos_orchestrate task_complete` (auto-emits `task.completed`). If the projection only folds `state.patched` events (from `workflow.update`) and not `task.completed` events, that explains the divergence — the canonical state moved but the projection's sources didn't.
3. **CAS race.** The previous session's checkpoint at `2026-05-13T18:16:50.187Z` may have shipped before all the `task.completed` events were durably indexed by the projector. Subsequent reads see the snapshot but miss the trailing events.

If (2): either fold `task.completed` into the projection, or have the projection aggregate from `tasks[]` directly.

### Expected / Suggested fix

- `rehydrate.taskProgress` reflects the latest `task.completed` / `task.failed` events at the moment of the call. The skill says it does — make it true.
- `view pipeline`'s `taskCount` and `completedCount` match `tasks[].length` and the count of `tasks[].status === "complete"` in canonical state.
- If the projection is intentionally event-store-only, document that limitation explicitly. Today the skill makes the opposite claim.

Add an integration test: create a task, complete it via `task_complete`, then assert `rehydrate.taskProgress[0].status === "complete"` immediately afterward. Same assertion for `view pipeline.completedCount`.

If the projection is intentionally async, surface a freshness indicator (`projectionAsOf: <timestamp>`) so callers can detect stale reads.

### Workaround

Trust `exarchos_workflow get` over `rehydrate` and `view pipeline` for task status. The workflow-state skill should be updated to say so until the projections are fixed.

---

## F4 — `workflow update` reserved fields are not enumerated in `describe` or the workflow-state skill

**Bucket:** documentation · **Severity:** MEDIUM
**Component:** skills / `workflow-state` + `exarchos_workflow describe`
**Suggested labels:** `docs`, `workflow-state`, `schema`, `severity:medium`

### Summary

`exarchos_workflow update` rejects writes to certain top-level keys with `RESERVED_FIELD: Cannot update reserved field: <key>`. The set of reserved fields is not documented anywhere a caller would look:

- `exarchos_workflow describe(actions: ["update"])` returns the schema for `updates` as `Record<string, unknown>` with no enum or per-key constraint.
- `@skills/workflow-state/SKILL.md` lists writable fields (`artifacts.design`, `tasks[i].status`, `worktrees.<id>.status`, etc.) but says nothing about which keys are off-limits.
- The error message lists the rejected key but does not enumerate the full reserved set, so the caller has to trial-and-error to discover the boundary.

### Reproduction

```ts
exarchos_workflow({
  action: "update", featureId: "<id>",
  updates: { "_checkpoint.summary": "anything" }
});
```

Returns:
```json
{
  "success": false,
  "error": { "code": "RESERVED_FIELD", "message": "Cannot update reserved field: _checkpoint.summary" }
}
```

### Observed (this session)

I attempted to write a checkpoint-style summary by setting `_checkpoint.summary` (a field clearly visible in `get` output, surrounded by other keys I had been editing successfully). The prior session's persisted state shows a populated `_checkpoint.summary`, so the field is settable *somehow* — just not via this tool.

Other underscore-prefixed keys observed in `get` output that look reserved:
- `_version` (CAS version)
- `_esVersion` (event-store version)
- `_checkpoint.{summary, timestamp, phase, operationsSince, ...}`
- `_perf` (per-call telemetry; possibly response-only)
- `_meta`, `_eventHints`, `_cacheHints` (response envelope; not state)

No documentation distinguishes which are response-envelope vs persisted state, and which persisted ones are settable vs server-managed.

After `RESERVED_FIELD` rejection, removing only that one key and resubmitting the same payload succeeded — so the rejection is per-key, not per-call. Good defensive behavior, just opaque about scope.

### Expected / Suggested fix

Pick at least (1) + (3):

1. **Authoritative enumeration in `describe`.** Add `reservedFields: ["_checkpoint", "_version", "_esVersion", ...]` to the `update` action's describe output. This is the canonical surface — any caller can discover the full list with one call.
2. **Skill-level documentation.** Add a "Reserved fields" subsection to `workflow-state/SKILL.md` listing reserved keys and the alternate write path for each (e.g., "_checkpoint.summary is set automatically by the checkpoint pruner; use `exarchos_orchestrate prune_stale_workflows` to trigger a snapshot").
3. **Better error message.** Have `RESERVED_FIELD` return `{ rejectedKey: "...", reservedFields: [...], allowedAlternative: "..." }` so callers don't have to grep docs after each rejection.

Pair with F3: if `_checkpoint.summary` is intended to be auto-managed, callers shouldn't be tempted to write it manually. Document the boundary in `get`'s output too (e.g., return reserved fields under a `_serverManaged: { ... }` envelope).

---

## F5 — `merge-orchestrator` skill is silent on multi-worktree target topology

**Bucket:** documentation · **Severity:** MEDIUM
**Component:** skills / `merge-orchestrator`
**Suggested labels:** `docs`, `merge-orchestrator`, `multi-worktree`, `severity:medium`
**Related:** F1 (orchestrator code bug)

### Summary

The merge-orchestrator skill prescribes "invoke from the main worktree" (anti-pattern table, line 150 of `SKILL.md`). It does not describe what to do when:

- The main worktree is on a branch other than the merge target, AND
- The merge target is checked out in a sibling git worktree (e.g., `.worktrees/integration`).

This topology is common in delegated multi-task workflows where the main worktree holds the operator's day-to-day branch and integration is parked in a dedicated worktree to keep the operator's working tree stable across sub-agent runs. In that topology, current skill guidance directly leads to F1 (opaque rollback).

There is also an internal contradiction with the actual successful behavior recorded in `merge.preflight` events from prior sessions, where the orchestrator was invoked from inside subagent worktrees (`.worktrees/wave-1-foundation`, `.worktrees/wave-2a-skills`) and succeeded — even though the skill's anti-pattern table says that's wrong.

### Observed (this session)

Successful `merge.preflight` events from the prior day (sequences 52, 99, 107):
```json
{
  "worktree": { "actual": "C:\\...\\.worktrees\\wave-1-foundation",
                "expected": "main worktree (no .claude/worktrees/ in path)",
                "isMain": true },
  "passed": true
}
```
The `actual` path is inside `.worktrees/`, the `expected` says "main worktree", and the result is `passed: true`. The check the skill describes as a guard appears to be advisory — the orchestrator runs in whatever cwd the operator gives it. So the skill's anti-pattern row is documentation drift.

Failed `merge.preflight` events from this session (sequence 263+):
```json
{
  "worktree": { "actual": "C:\\Users\\salusreed\\Work\\isce\\SCS-ISCE-Ev2Tooling",
                "expected": "main worktree (no .claude/worktrees/ in path)",
                "isMain": true },
  "passed": false,
  "failureReasons": ["uncommitted changes: 2 file(s)", "ancestry missing: ..."]
}
```
Same `expected`, different `actual`, and the failures had nothing to do with the worktree assertion — they were caused by drift and the bogus ancestry check (F2).

### What the skill should say

A new "Topology" section between "Step 2" and "Step 3" of the runbook, covering at minimum:

1. **Where target should live.** Strongly prefer that the target branch (typically `integration`) is checked out at a dedicated worktree (e.g., `.worktrees/integration`) so it can be inspected and updated without disturbing the operator's main working tree.
2. **Where to invoke from.** Invoke `merge_orchestrate` with `repoRoot` pointing at the worktree where the target branch is currently checked out. If target is checked out in `.worktrees/integration`, set `repoRoot: "<repo>/.worktrees/integration"`. If target is on the main worktree, use the main worktree.
3. **What to do if target is checked out elsewhere from where you're invoking.** Today the orchestrator silently fails; documenting (a) re-invoke from the target's worktree, or (b) detach the branch from its worktree first, would unblock operators. Pair with F1 fix that turns this into a clean preflight error.
4. **Wave-level merges.** This workflow merges per-wave (multiple tasks per merge), not per-task as the playbook implies. Skill should note that per-wave merges in the `delegate` phase (without transitioning to `merge-pending`) are a supported pattern, OR explicitly require the `delegate → merge-pending → delegate` round-trip.

### Suggested fix

1. Replace the anti-pattern row "Invoke from a subagent worktree" with two rows:
   - "Invoke from a worktree where the target branch is **not** checked out" → "Re-invoke with `repoRoot` pointing at the worktree that has the target branch."
   - "Invoke from the main worktree when target is parked in a sibling worktree" → "Same fix."
2. Add a "Topology" section as outlined above.
3. Cross-link to F1 (or its resolution) so operators understand the failure mode they're avoiding.

---

## F6 — Empty `merge-pending` runbook + `view telemetry` undercounts action-level errors

**Bucket:** documentation · **Severity:** LOW
**Component:** exarchos-mcp / `runbook` + `view telemetry`
**Suggested labels:** `docs`, `runbook`, `telemetry`, `severity:low`

Two small, independent gaps that both undermine the dogfood/postmortem flow. Bundled because either alone is a one-liner fix and both have the same root pattern: the server's introspection surface doesn't fully reflect what's prescribed in skill docs.

### Gap A — Empty `merge-pending` runbook

`exarchos_orchestrate({ action: "runbook", phase: "merge-pending" })` returns `data: []`.

Other phases — `delegate`, `plan`, `synthesize` — return populated runbook entries. `merge-pending` is the only phase whose playbook references a non-trivial skill (`@skills/merge-orchestrator/SKILL.md`, ~12KB of operator guidance) but has no corresponding runbook.

**Expected:** A merge-pending runbook with at least:
- The four preflight gates (ancestry, current-branch, worktree, drift) with `decide` branches per failure mode.
- The three terminal phases (`completed` / `aborted` / `rolled-back`) and the `onFail` directives for each.
- Strategy choice (`squash` vs `merge` vs `rebase`) with `decide` guidance.

The skill content (`@skills/merge-orchestrator/SKILL.md` Step 2 + 3 tables) is essentially a runbook in prose form — porting it to the structured runbook format would be straightforward.

**Suggested fix:** Add a `merge-pending` entry to the runbook registry. If the existing runbook engine doesn't support free-form prose well, even a stub that points to `@skills/merge-orchestrator/SKILL.md` would beat the current empty array.

### Gap B — `view telemetry` undercounts action-level errors

`exarchos_view({ action: "telemetry" })` reports per-tool error counts:
```json
{ "tool": "exarchos_orchestrate", "invocations": 132, "errors": 0 }
```

But this session had **at least three** action-level failures from `exarchos_orchestrate`:
- `MERGE_ROLLED_BACK` (F1)
- `PREFLIGHT_FAILED` (twice — once for ancestry, once for drift)
- `UNKNOWN_ACTION: merge_branch` (operator typo)

And `exarchos_event` shows `errors: 0` despite:
- `MCP error -32602: Invalid arguments for tool exarchos_event` (the `tail` typo)
- `UNKNOWN_EVENT_TYPE: workflow.handoff` (operator confusion)

It looks like the telemetry counter increments only on protocol-level (transport) errors — not on responses where the data envelope returns `success: false` with a structured error code. From a post-hoc analysis perspective, those structured failures are exactly what we want to track.

**Expected:** A per-call success/failure status that counts:
- Protocol-level errors (transport, parse) — already counted today.
- Action-level errors (response with `success: false` or `error.code` populated) — currently uncounted.

Optionally split the two so dashboards can distinguish "the wire was bad" vs "the operator got back a structured error." Both are worth surfacing.

**Suggested fix:** Extend the telemetry counter to also tick on `success: false` responses. Optionally add an `actionErrors` field alongside `errors`:

```json
{
  "tool": "exarchos_orchestrate",
  "invocations": 132,
  "errors": 0,           // protocol/transport
  "actionErrors": 3,     // success: false with error code
  "actionErrorBreakdown": { "MERGE_ROLLED_BACK": 1, "PREFLIGHT_FAILED": 2 }
}
```

The breakdown is gold for dogfood retrospectives — it lets a downstream skill say "you hit MERGE_ROLLED_BACK once this session" without scanning conversation history.

---

## Appendix — methodology and self-correcting cases

### How the findings were collected

Per the dogfood skill's process:

1. **MCP self-service first.** Used `exarchos_workflow describe(topology|playbook|actions)`, `exarchos_orchestrate describe(actions)`, `exarchos_event describe(eventTypes|emissionGuide)`, and `exarchos_orchestrate runbook(phase)` to establish authoritative ground truth.
2. **Cross-referenced with event log.** Used `exarchos_event query(stream, filter)` to retrieve `merge.preflight`, `merge.executed`, and `merge.rollback` events from this session and the prior day's session. Sequence numbers and timestamps in the report come from these.
3. **State reconciliation.** Used `exarchos_orchestrate reconcile_state` (returned PASS 5/5) to confirm git ↔ workflow-state consistency before and after manual interventions.
4. **Conversation supplement.** Cross-checked tool-call errors from the session transcript against server-side state.

### Cases not filed as issues

Operator-error class — improvised action / event names that the server's enumerated error responses immediately corrected:

| Improvised | Correct | Discovery path |
|---|---|---|
| `exarchos_orchestrate({action:"merge_branch"})` | `merge_orchestrate` | Error listed valid actions |
| `exarchos_event({action:"tail"})` | `query` with filter | Error listed valid actions |
| `exarchos_event describe(eventTypes:["workflow.handoff"])` | (no such event — handoff lives in workflow state) | Error listed valid event types |

These are operator mistakes, not server defects. The server's behavior was excellent in each case (clear error code, full enumeration of valid alternatives). No issue warranted — though F4-style "where do handoffs live" docs would help.

### Playbook adherence note (not a blocker)

The workflow stayed in `delegate` throughout this session and the prior day, never entering `merge-pending`. The feature playbook prescribes `delegate → merge-pending → delegate` per worktree merge, but `merge_orchestrate`'s `describe` accepts `delegate` as a valid phase. Per-wave merges in `delegate` appear to be a supported but undocumented pattern. Captured under F5.

`task.progressed` events were never emitted — every Exarchos response carried `_eventHints.missing: [task.progressed]` and the delegation playbook lists them under `delegate`. The G6 task was completed without TDD-phase events, but `check_tdd_compliance` passed (it inspects commits, not events). Either make `task.progressed` mandatory with an explicit checklist, or deprecate the advisory if commit-based checks are sufficient. Not filed as a separate issue — it's a pattern question rather than a defect.
