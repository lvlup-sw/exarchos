# Windows Dogfood Findings — Verification & Remediation Plan

**Date:** 2026-05-13
**Source reports:**
- `docs/references/exarchos-install-skills-bug-report.md`
- `docs/references/2026-05-13-exarchos-dogfood-findings.md`

**Repo tag at time of report:** v2.10.0-preview.2 (commit `7a878e4`)
**Verification commit:** `7a878e4f` (HEAD on `main` at write time)
**Scope:** Verify each finding against the code, then synthesize remediation — short-term patches plus long-term invariants — split by repo target and risk.

---

## 0. Executive summary

| ID  | Reporter severity | Verified | Verdict | Remediation track |
|-----|-------------------|----------|---------|-------------------|
| INSTALL | High      | ✅ confirmed | Real, root cause is broader than reporter hypothesis: upstream `skills add` doesn't scan `skills/<runtime>/` at all; only `.claude/skills/` is visible to it. | CLI bug — patch in `src/install-skills.ts`. **High urgency.** |
| F1  | High              | ✅ confirmed | Real, code path traced end-to-end: rollback SHA captures cwd HEAD before the merge adapter's `git checkout target` fails on multi-worktree topology. | MCP bug — patch in `pure/execute-merge.ts` + `local-git-merge.ts`. **High urgency.** |
| F2  | Medium            | ⚠ observable, but algorithm in `dispatch-guard.ts` is correct. Likely Windows-specific worktree/ref-cache interaction. | Needs Windows repro with instrumentation; ship a structured-logging change first. | MCP investigation — add `merge.preflight.debug` payload. **Medium urgency.** |
| F3  | Medium            | ✅ confirmed | Real, two distinct sub-bugs: (a) projection drift relative to canonical `tasks[].status` because both projections rely on `task.assigned` events being emitted, and (b) snapshot cutoff lets `task.completed` events written after the snapshot timestamp go unfolded on read. | MCP bug — projection contract change. **Medium urgency.** |
| F4  | Medium            | ✅ confirmed | Real, with an exact list now in `schemas.ts:515-528`. No discovery surface. | Describe-surface change + skill doc. **Medium urgency.** |
| F5  | Medium            | ✅ confirmed | Real, the SKILL.md says "invoke from main worktree" but offers no guidance for the worktree-target topology that triggers F1. | Skill markdown rewrite. **Medium urgency** (pair with F1). |
| F6a | Low               | ✅ confirmed | Real, runbook registry has `delegate`/`review`/`synthesize` entries, no `merge-pending`. | Add a runbook entry. **Low urgency.** |
| F6b | Low               | ✅ confirmed | Real, telemetry middleware emits `tool.completed` for any return — including `{success: false, ...}`. Only thrown exceptions hit `tool.errored`. | Telemetry counter change. **Low urgency.** |

**Priority order for fix waves:** INSTALL (ships broken install path) → F1 + F5 (data-safety hazard with documentation that doesn't warn) → F3 + F4 (operator-trust hazards) → F2 (needs more diagnostic data) → F6a + F6b (polish).

**Beyond the eight findings** — §11 captures three systemic gaps that no per-bug fix addresses: (1) tests verify algorithms not operator-visible outcomes — needs a new outcome-test tier; (2) the eval suite is live but covers LLM behavior, not engineering correctness — elevate it taking inspiration from `github.com/dotnet/skills`; (3) no invariant for workflow-agnosticism — add INV-6 and audit existing drift. These tracks are sequenced into the wave plan in §11.4.

---

## 1. INSTALL — `install-skills` ships 1 skill instead of 17

### Verification

`src/install-skills.ts:298-311` builds the argv:

```ts
const skillsAgentId = mapRuntimeToSkillsCliAgent(runtime.name);  // copilot → github-copilot
const args = [
  '--yes', 'skills', 'add', 'github:lvlup-sw/exarchos',
  '--skill', '*',
  '--agent', skillsAgentId,
  '-y', '-g', '--copy',
];
```

No path filter. The upstream `skills` CLI clones the repo and scans for `SKILL.md` files. Direct evidence:

- `grep -c "^agents:" skills/copilot/*/SKILL.md` returns `0` for every file in the bundle — none of the 17 copilot SKILLs declare an `agents:` frontmatter field.
- `.claude/skills/design-invariants/SKILL.md` also has no `agents:` field. The reporter's hypothesis that this single file "happens to satisfy the filter" is empirically true but the mechanism is *upstream convention*, not Exarchos frontmatter — upstream `skills add` treats `.claude/skills/` as the canonical Claude Code skill root and walks that tree first.

**Net effect:** The runtime-specific bundle at `skills/copilot/` is invisible to the upstream CLI regardless of `--agent` value. Operators who run `exarchos install-skills --agent copilot|generic|opencode` get exactly the skills under `.claude/skills/` — currently one — and the success banner hides it.

This is a strictly broader root cause than the reporter's "agents-frontmatter mismatch": adding `agents:` to every copilot SKILL would still leave them in the wrong source tree from upstream's perspective.

### Recommendation — primary fix (high urgency)

**Stop delegating to `skills add` entirely.** Replace `npx skills add ...` with an in-process bundle copy from `skills/<runtime>/` for every runtime — including `claude`. Sourcing from the tagged release artifact makes the installer authoritative over what lands on disk; the `.claude/skills/` directory in the repo becomes invisible to installs because the installer never points there.

This is a stricter fix than the earlier "non-claude only" proposal — adopted after deciding to keep `.claude/skills/` committed in the repo for local dev use without distributing it. The only reliable way to ensure `.claude/skills/` never reaches a third-party install is to own the install transport ourselves.

Concrete steps:

1. Add a `downloadRuntimeBundle(runtime, version, dest)` helper in `src/install-skills.ts` that:
   - Downloads `https://github.com/lvlup-sw/exarchos/releases/download/v<version>/skills-<runtime>.tgz` (a new artifact emitted by the release workflow), or
   - Falls back to `git archive --remote=<repo> v<version> -- skills/<runtime>/` when the tarball isn't available.
2. In `installSkills()`, remove the runtime branching: every runtime calls `downloadRuntimeBundle` + copy into `expandTilde(runtime.skillsInstallPath, home)`. The MCP registration step for the `claude` runtime (`registerExarchosInClaudeJson`) stays as a separate post-install action.
3. Add a post-install validator: compare the installed directory listing against the manifest baked into the release tarball; if the set diverges by more than 0 entries, exit non-zero with a structured diff. The manifest is computed at release time from `find skills/<runtime>/ -name SKILL.md`.
4. Update the release workflow to emit `skills-<runtime>.tgz` for every supported runtime, plus a `manifest.json` per tarball.

This fix makes the `.claude/skills/` discoverability hazard structurally impossible: the installer's source-of-truth is the release tarball, not a repo clone. The directory can stay in source control unchanged and continue to power local dev with no exposure to third-party installs.

### Recommendation — defense in depth

- **Release workflow:** Add a CI step that runs `exarchos install-skills --agent <runtime>` for each supported runtime against a clean temp HOME, then asserts the installed skill count matches `ls skills/<runtime>/ | wc -l`. Fail the release if any runtime undershoots.
- **`--help` text:** Document `~/.agents/skills/` (or `runtime.skillsInstallPath`) as the install destination per runtime. The current help is silent and contributed to the diagnostic time in the report.
- **Side-observation `--yes` flag:** Either accept and forward `--yes` to the upstream CLI, or document why the CLI deliberately rejects it. The upstream contract advertises it, so silent rejection is surprising.

### Tests to add

- Unit test in `src/install-skills.test.ts` that asserts: given `agent: 'copilot'`, the implementation does NOT call `npx skills add` and DOES emit the same number of files as `skills/copilot/` ships.
- A repo-level integration test (`scripts/test-install-skills-fresh.sh`) that uses a temp HOME, runs the CLI for each runtime, and asserts a non-empty installed-skill set.

---

## 2. F1 — `merge_orchestrate` returns an unrelated SHA on rollback

### Verification

Code path traced bottom-up:

1. `pure/execute-merge.ts:30-46` — `recordRollbackPoint(gitExec, repoRoot)` runs `git rev-parse HEAD` in `repoRoot ?? process.cwd()`. **This captures the operator's cwd-worktree HEAD before any merge attempt** — independent of the target branch.

2. `pure/execute-merge.ts:108-115` — the captured SHA is persisted as `mergeOrchestrator.executing.rollbackSha` regardless of target.

3. `local-git-merge.ts:72` — the first thing the merge adapter does is `gitOrThrow(gitExec, repoRoot, ['checkout', targetBranch])`. **On multi-worktree topology with `target` already checked out elsewhere, git refuses the checkout** with `fatal: 'target' is already used by worktree at <path>`.

4. `local-git-merge.ts:42-54` (`gitOrThrow`) — throws on the non-zero exit.

5. `pure/execute-merge.ts:125-144` — the executor catches, calls `categorizeFailure(err)` which returns `'merge-failed'` (no `verification` substring, no timeout signal), then runs `git reset --hard <rollbackSha>` in the cwd worktree.

6. The reset succeeds *as a no-op* — HEAD never moved because the checkout failed at step 3. The recorded `rollbackSha` (operator's cwd-branch tip) is returned to the caller as if it had been the rolled-back state of the target branch.

This is exactly the foot-gun described in the report. The integration branch was never touched; the worktree containing it was never touched; nothing was rolled back. But the response shape says `phase: 'rolled-back'` with a SHA that points at a third branch.

### Recommendation — primary fix (high urgency)

Add a preflight guard `targetWorktreeAvailability` to the merge composer. Spec:

```ts
// new entry in pure/merge-preflight.ts, alongside detectDrift
export interface TargetWorktreeAvailabilityResult {
  readonly passed: boolean;
  readonly blocked?: boolean;
  readonly reason?: 'target-checked-out-elsewhere';
  readonly checkedOutAt?: string;       // sibling worktree absolute path
  readonly hint?: string;
}

export function checkTargetWorktreeAvailability(
  gitExec: GitExec,
  targetBranch: string,
  repoRoot: string,
): TargetWorktreeAvailabilityResult {
  const result = gitExec(repoRoot, ['worktree', 'list', '--porcelain']);
  if (result.exitCode !== 0) {
    return { passed: false, blocked: true, reason: 'target-checked-out-elsewhere',
             hint: `git worktree list failed: ${result.stdout.trim()}` };
  }
  // Parse porcelain output: blocks of `worktree <path>` / `HEAD <sha>` / `branch refs/heads/<name>`
  // For every block, if branch === targetBranch AND worktree !== repoRoot → fail.
  // ...
}
```

Wire it into `mergePreflight` between `worktree` and `drift`, surface in `merge.preflight` event, and treat its failure as a preflight blocker exactly like ancestry. Return:

```json
{
  "passed": false, "blocked": true,
  "reason": "target-checked-out-elsewhere",
  "checkedOutAt": ".worktrees/integration",
  "hint": "Re-invoke with repoRoot=<repo>/.worktrees/integration, OR detach the target branch from that worktree first."
}
```

**Crucially:** the new guard prevents F1 from ever capturing a rollbackSha at all. The handler returns `phase: 'aborted'` (preflight failure) with structured remediation, not a fake rollback.

### Recommendation — secondary defense

Even with the preflight guard, harden the executor:

1. **`recordRollbackPoint` should capture the target branch's tip, not the cwd HEAD.** Change `pure/execute-merge.ts:35` to `git rev-parse refs/heads/${targetBranch}` so that even if the cwd worktree is on an unrelated branch, the recorded rollback anchor is always the meaningful one. If that lookup fails, the executor should refuse to proceed (no rollback anchor = no safe merge).
2. **Categorize "branch already checked out" distinctly.** Extend `categorizeFailure` (or add a `categorizeCheckoutFailure` pre-pass) to detect `fatal: '<branch>' is already used by worktree at <path>` in the captured stderr, and surface it as a structured `categorizedReason: 'target-worktree-busy'` with the sibling path — not as `merge-failed`. Today it's indistinguishable from a real merge conflict in the event log.
3. **Stop returning `phase: 'rolled-back'` when nothing was rolled back.** If the reset is a no-op (HEAD before == HEAD after), surface a new terminal state `phase: 'aborted-pre-merge'` with the failed-precondition reason. The current shape implies state changed when it didn't.

### Tests to add

- `merge-orchestrate.multi-worktree.test.ts` — exercises the new preflight guard via a fake `gitExec` whose `worktree list --porcelain` returns target-checked-out-elsewhere; asserts no executor invocation, no `merge.requested`/`merge.executed` events, structured `phase: 'aborted'` ToolResult.
- A regression in `execute-merge.test.ts` — when the checkout step fails with the "already used by worktree" error, the executor must NOT emit `merge.rollback` and must NOT record a rollback SHA.
- An end-to-end test using a real git repo with two worktrees on Linux/macOS CI — the existing matrix should cover this without Windows-specific bits.

---

## 3. F2 — Ancestry preflight false-positive

### Verification — partial

Algorithm in `dispatch-guard.ts:59-106` is **semantically correct**:

```ts
gitExec(['merge-base', '--is-ancestor', upstream, integrationBranch]);
//                          ^target            ^source
//   exit 0 = target IS an ancestor of source (good for merge)
//   exit 1 = target is NOT an ancestor (missing)
//   other  = git-error
```

This is the exact two-arg form that the report's manual `git merge-base --is-ancestor target source` returns 0 for. The bug therefore is NOT in the algorithm.

The reporter's observation that running `git rebase target` (a no-op) "warms" the check is strong evidence that something git-state-adjacent is being read. From the code, the only state the check touches is `refs/heads/<branch>` (resolved by `git merge-base`). Two plausible Windows-specific causes I can't confirm without a live repro:

1. **Packed-refs lag.** On Windows, `refs/heads/<branch>` may live inside `.git/packed-refs` instead of as a loose ref. When a sibling worktree commits to that branch, the new tip is written as a loose ref AND eventually packed; in between, certain git operations may see the *packed* (older) tip. `git rebase` writes a reflog entry, which on some git versions triggers a ref-pack rewrite that resolves the discrepancy. The dogfood report shows the source tip and target tip were unchanged at all three preflight points, but doesn't show what `git rev-parse refs/heads/<target>` returned at each point — that's the bit needed to confirm.

2. **Worktree-local refs file collision.** When `target` is checked out in a worktree, git may write `.git/worktrees/<wt>/HEAD` containing a symbolic ref to `refs/heads/target`. Reads from main worktree should follow `refs/heads/target` directly, but some git versions have race conditions on Windows where `refs/heads/<branch>` is staged for update via a `.lock` file from the sibling worktree, causing concurrent `merge-base` calls from main worktree to read stale state.

Neither cause is reachable from the code without instrumentation. The dispatch-guard error-categorization at `dispatch-guard.ts:79-92` would translate either of those into either `reason: 'ancestry'` (exit 1 — the observed case) or `reason: 'git-error'`.

### Recommendation — staged investigation (medium urgency)

Don't blindly "rewrite" the check; instead, instrument it so the next failure produces actionable evidence:

1. **Phase 1 — capture (one PR):**
   - In `pure/merge-preflight.ts`, extend the `merge.preflight` event payload with a new optional `debug` block populated when `ancestry.passed === false`:
     ```ts
     debug: {
       gitVersion: <string>,
       repoRoot: <string>,
       worktreeList: <porcelain output>,
       refsHeadsSource: { sha, packed: boolean },
       refsHeadsTarget: { sha, packed: boolean },
       mergeBaseCommand: ['merge-base', '--is-ancestor', target, source],
       mergeBaseExitCode: <number>,
       mergeBaseStdout: <string>,
       mergeBaseStderr: <string>,
     }
     ```
   - Gate behind an env var (`EXARCHOS_PREFLIGHT_DEBUG=1`) so it doesn't pollute the event store by default.
   - Document the env var in the merge-orchestrator skill.

2. **Phase 2 — repro & fix:** Once we have one Windows-host event with that payload, we can decide between:
   - Switching to a single `git rev-list --count <target>..<source>` (zero output means target is ancestor of source) — different code path, different cache surface.
   - Adding a `git update-ref -d <stale>` warmup before the check.
   - Documenting an OS-conditional retry: on Windows, re-run the check once with a 100ms sleep if the first call returns "not an ancestor" but `git rev-parse refs/heads/<target>` matches the merge-base of (target, source).

3. **Phase 3 — workaround in docs:** Until the root cause is nailed, the merge-orchestrator skill should mention the `git rebase <target>` warmup as a known transient remediation. Today it doesn't.

### Tests to add

- Once root-caused, a regression test that sets up a synthetic `.git/packed-refs` (or whichever state triggers it) and asserts ancestry returns `passed: true`.

---

## 4. F3 — `rehydrate.taskProgress` + `view pipeline` stale relative to `tasks[].status`

### Verification

Both projections fold the *exact same event types* — `task.assigned`, `task.completed`, `task.failed` — and ignore `state.patched`'s `tasks[]` patch for status. Direct evidence:

- `projections/rehydration/reducer.ts:877-925` — the dispatcher switches on event type; `task.assigned` calls `upsertTaskProgress(progress, taskId, 'assigned')`, `task.completed` calls it with `'completed'`, etc.
- `views/pipeline-view.ts:74-90` — increments `taskCount` on `task.assigned`, `completedCount` on `task.completed`.
- `tasks[].status`, on the other hand, lives in canonical workflow state and is mutated by `workflow.update` (via `applyDotPath`, which emits `state.patched`).

There are **two independent sources of drift**:

1. **Missing `task.assigned` events.** Per `feedback_orchestrator_task_assigned_emission.md` in this repo's memory: "Emit task.assigned per dispatch — without it rehydration's taskProgress is silently empty; #1179/#1180 track the projection bugs." This is a known issue: orchestrators that dispatch via raw `TaskCreate` (or via the older `set({tasks})` path) update `tasks[].status` but never emit `task.assigned`. Both projections undercount as a result. The reporter's `view pipeline → taskCount: 53` vs `get → tasks.length === 67` matches this exactly — 14 tasks were created without `task.assigned`.

2. **Snapshot cutoff lag for rehydrate.** The projection produces a snapshot per `cadence.ts` schedule, then folds events newer than the snapshot on read. If the cadence interval is longer than the time between session end and the next rehydrate, the read sees only the snapshot. The reporter saw ~30 tasks marked `assigned` in `rehydrate` while `get` showed them `complete` — consistent with `task.completed` events being emitted *after* the snapshot but before the `_checkpoint.timestamp`, and the cadence not having re-snapshotted between them. The skill says "the rehydration projection folds events newer than the last snapshot" — empirically, the fold is either limited or the snapshot timestamp isn't what defines the fold cursor.

### Recommendation — primary fix (medium urgency)

**Fold from canonical state, not just events, for status fields.** Both projections should derive `taskCount`/`completedCount`/`taskProgress` from `state.patched`'s `tasks[]` patches *and* the `task.*` events, with event-derived state being authoritative when both exist (the reducer already documents this precedence at line 39-44, but only applies it to the seeding-pending half — extend it to the completion half too).

Concrete changes:

1. **`projections/rehydration/reducer.ts`:** in the `state.patched` handler that decodes `data.patch.tasks`, propagate task `status` changes into `taskProgress` — not just seeding `pending`. Keep the precedence rule: if a later `task.completed` event already promoted T1 to `completed`, a subsequent `state.patched` re-asserting `tasks: [{id:'T1', status:'complete'}]` is a no-op; if no event has been recorded, the `state.patched` status wins.

2. **`views/pipeline-view.ts`:** mirror the same change — fold `state.patched.tasks[].status` patches into `taskCount`/`completedCount`/`failedCount`. The current implementation only counts events.

3. **Snapshot fold cursor:** verify that `projectionSequence` in the rehydration document advances on each fold, and that `rehydrate` always re-folds tail events past `_eventSequence`. If the implementation has a shortcut path that returns the snapshot directly without the tail fold, remove it. The skill's documented behavior must be the actual behavior.

4. **Expose freshness.** Add `projectionAsOf: <ISO timestamp>` to both `rehydrate` and `view pipeline` outputs, computed from the `timestamp` of the latest folded event. If it's stale relative to `Date.now()` by more than 5 seconds, also surface a `_meta.projectionLag: <ms>` hint.

### Recommendation — defense in depth

- **Add an integration test:** create a task, complete it via `task_complete` (which auto-emits `task.completed`), immediately call `rehydrate` and `view pipeline`, assert both show the task as completed. The test must pass without an explicit `task.assigned` emission, because the orchestrator that runs in the wild often skips it.
- **Reconcile gate:** when the divergence detector fires (`reconcile_state` already returns a check matrix), surface a `projection-drift` finding when canonical tasks[].status doesn't match the pipeline view counts. Today it returns PASS 5/5 even in the presence of this drift.
- **Workflow-state skill update:** until the projection is fixed, the skill should explicitly say "trust `get` over `rehydrate`/`view pipeline` for task status." This is the operator's only safety rail.

### Tests to add

- `projections/rehydration/reducer.test.ts` — task moved from `pending` to `completed` solely via `state.patched` (no `task.completed` event) should appear as `completed` in the rehydration doc.
- `views/pipeline-view.test.ts` — same shape: `state.patched` with `tasks[].status === 'complete'` should increment `completedCount` even without a `task.completed` event.
- `rehydrate.snapshot-cursor.test.ts` — create a snapshot, append a `task.completed` event after the snapshot, call `rehydrate`, assert the folded result reflects the post-snapshot event.

---

## 5. F4 — Reserved fields are not discoverable

### Verification

Reserved set is defined at `servers/exarchos-mcp/src/workflow/schemas.ts:515-528`:

```ts
const IMMUTABLE_FIELDS = new Set(['phase', 'workflowType', 'featureId', 'createdAt', 'version']);

export function isReservedField(path: string): boolean {
  if (path === '') return false;
  const topLevel = path.split('.')[0];
  if (IMMUTABLE_FIELDS.has(topLevel)) return true;
  return path.startsWith('_') || path.split('.').some((part) => part.startsWith('_'));
}
```

The rule is: top-level immutable keys (`phase`/`workflowType`/`featureId`/`createdAt`/`version`) plus **anything containing an underscore-prefixed segment**. That covers `_checkpoint`, `_version`, `_esVersion`, `_perf`, `_meta`, `_eventHints`, `_cacheHints`, and any future `_*` field.

Discoverability surface check:

- `grep "reservedFields" servers/exarchos-mcp/src/describe/**` — no matches outside one test comment. The `describe` handler does not expose this list.
- `grep "reserved" skills-src/workflow-state/**` — no matches. The skill says nothing about which fields are off-limits.
- `state-store.ts:553-557` — `applyDotPath` throws `RESERVED_FIELD` with `Cannot update reserved field: <dotPath>` carrying only the rejected path, not the full set.

Confirmed: the reserved set is enforced but not surfaced anywhere a caller can discover it.

### Recommendation — primary fix (medium urgency)

**Three layered changes**:

1. **`describe` enumeration.** Extend `exarchos_workflow describe(actions: ['update'])`'s response schema to include:
   ```json
   {
     "action": "update",
     "args": { "...": "..." },
     "reservedFields": {
       "rule": "Top-level keys 'phase', 'workflowType', 'featureId', 'createdAt', 'version' are immutable; any dot-path containing an underscore-prefixed segment is server-managed.",
       "topLevelImmutable": ["phase", "workflowType", "featureId", "createdAt", "version"],
       "underscorePrefixed": "any path matching /(^_|\\._)/",
       "examples": ["_version", "_checkpoint.summary", "_eventHints"],
       "alternateWritePaths": {
         "phase": "exarchos_workflow({action: 'transition', target: '<phase>'})",
         "_checkpoint": "managed by prune_stale_workflows / checkpoint cadence",
         "_version, _esVersion, _perf, _meta, _eventHints": "server-managed; no write path"
       }
     }
   }
   ```
2. **Better error message.** Change `state-store.ts:553-557` to:
   ```ts
   throw new StateStoreError(
     ErrorCode.RESERVED_FIELD,
     `Cannot update reserved field: ${dotPath}`,
     {
       rejectedPath: dotPath,
       rule: 'top-level-immutable or underscore-prefixed segment',
       alternateWritePath: alternateForPath(dotPath),  // returns transition/checkpoint hint when applicable
     },
   );
   ```
   (extending `StateStoreError` to carry structured `data` — the MCP envelope already serializes a `data:` block on error).

3. **Skill-level documentation.** Add a "Reserved fields" subsection to `skills-src/workflow-state/SKILL.md` listing the rule, examples, and write paths. Cross-link from `merge-orchestrator/SKILL.md` (since `mergeOrchestrator` is one of the writeable nested objects).

### Tests to add

- `describe.test.ts` — assert `describe('update').reservedFields` is present and includes both rules.
- `state-store.reserved.test.ts` — assert `RESERVED_FIELD` error carries `rejectedPath`, `rule`, `alternateWritePath`.

---

## 6. F5 — `merge-orchestrator` skill silent on multi-worktree topology

### Verification

`skills-src/merge-orchestrator/SKILL.md:150`:

```
| Invoke from a subagent worktree | Preflight refuses (main-worktree assertion); invoke from the main worktree |
```

Confirmed: this is the only worktree-related anti-pattern. The skill says nothing about what to do when:

- the target (integration) branch lives in a sibling worktree, and
- the main worktree is on a different branch.

This is the topology that triggers F1. Operators following the skill end up at the foot-gun.

There is also documentation drift: the skill's anti-pattern row says "preflight refuses" subagent-worktree invocation, but `pure/merge-preflight.ts:243` calls `assertMainWorktree(repoRoot)` which is *advisory* — its `passed` is computed but `isMain` doesn't unconditionally block the overall preflight (see `merge-preflight.ts:246-250`). The reporter cited successful `merge.preflight` events run from inside `.worktrees/wave-1-foundation` from the prior day; that matches the advisory-only behavior. The skill claims a hard refuse that doesn't exist.

### Recommendation — pair with F1 fix (medium urgency)

Rewrite the relevant skill sections **after** the F1 preflight guard lands, so the new "Topology" section can refer to a real `targetWorktreeAvailability` guard rather than describing a workaround.

Concrete changes to `skills-src/merge-orchestrator/SKILL.md`:

1. **Replace line 150's anti-pattern row** with two rows that match what preflight actually does:
   ```
   | Invoke from a worktree where the target branch is NOT checked out | Re-invoke with repoRoot pointing at the worktree that has the target branch |
   | Invoke from the main worktree when target is parked in a sibling worktree | Same fix — repoRoot must match the worktree holding target |
   ```

2. **Insert a new "Topology" section between Step 2 and Step 3**, covering:
   - Where target should live (typically `.worktrees/integration`).
   - How to point `repoRoot` at the worktree that holds target.
   - What `targetWorktreeAvailability` preflight failures look like and how to recover.
   - Wave-level merges: per-wave merges in the `delegate` phase (without transitioning to `merge-pending`) are a supported pattern — document it explicitly so operators don't think they're skipping a required transition.

3. **Soften the "main worktree" language.** The preflight checks `assertMainWorktree`, but it's advisory; documenting it as a hard refuse misleads operators into trying workarounds that wouldn't be needed.

4. **Cross-link to F1's fix.** Once F1 lands, this skill should reference the structured preflight error as the canonical signal — not the rollback path.

After regeneration: `npm run build:skills` to propagate to every `skills/<runtime>/merge-orchestrator/SKILL.md`.

---

## 7. F6a — Empty `merge-pending` runbook

### Verification

`servers/exarchos-mcp/src/runbooks/definitions.ts` exports four runbook definitions: `TASK_COMPLETION` (delegate), `QUALITY_EVALUATION` (review), `AGENT_TEAMS_SAGA` (delegate), `SYNTHESIS_FLOW` (synthesize). No `merge-pending` runbook exists. `exarchos_orchestrate({action: 'runbook', phase: 'merge-pending'})` therefore returns `data: []`.

### Recommendation — low urgency

Add a `MERGE_ORCHESTRATION` runbook to `definitions.ts`:

```ts
export const MERGE_ORCHESTRATION: RunbookDefinition = {
  id: 'merge-orchestration',
  phase: 'merge-pending',
  description: 'Land a subagent worktree branch onto integration with preflight + recorded rollback.',
  steps: [
    { tool: 'exarchos_orchestrate', action: 'merge_orchestrate',
      params: { dryRun: true }, onFail: 'stop',
      note: 'Preflight-only: validates ancestry, target-worktree availability, current-branch, drift.' },
    { tool: 'exarchos_orchestrate', action: 'merge_orchestrate',
      onFail: 'continue',
      note: 'Real merge with rollback. On preflight failure → aborted (no executor). On merge failure → rolled-back (reset --hard rollbackSha).' },
    { tool: 'exarchos_workflow', action: 'transition',
      params: { target: 'delegate' }, onFail: 'continue',
      note: 'HSM exits merge-pending back to delegate regardless of merge outcome.' },
  ],
  templateVars: ['featureId', 'taskId', 'sourceBranch', 'targetBranch', 'strategy', 'repoRoot'],
  autoEmits: ['merge.preflight', 'merge.executed', 'merge.rollback', 'workflow.transition'],
};
```

Wire it into the registry, add it to the test suite (`decision-runbooks.test.ts`).

---

## 8. F6b — `view telemetry` undercounts action-level errors

### Verification

`telemetry/middleware.ts:138-145` (success branch):

```ts
await eventStore.append(TELEMETRY_STREAM, {
  type: 'tool.completed',
  data: { tool: toolName, durationMs, responseBytes, tokenEstimate },
})
```

`telemetry/middleware.ts:224-234` (catch branch):

```ts
await eventStore.append(TELEMETRY_STREAM, {
  type: 'tool.errored',
  data: { tool: toolName, durationMs, errorMessage: ... },
})
```

The middleware enters the catch branch **only when the handler throws**. Handlers that return `{success: false, error: {...}}` (the normal MCP envelope shape for structured errors — `MERGE_ROLLED_BACK`, `PREFLIGHT_FAILED`, `RESERVED_FIELD`, `UNKNOWN_ACTION`, etc.) exit through the success path and are counted as `tool.completed`. The `view telemetry`'s `errors` field aggregates over `tool.errored` events, so structured failures stay invisible.

Confirmed.

### Recommendation — low urgency

Two-line fix plus a breakdown surface:

1. **Detect `result.success === false` in the success branch.** Emit a `tool.action_errored` event alongside `tool.completed`:
   ```ts
   if (result.success === false) {
     const errorCode = (result as { error?: { code?: string } }).error?.code;
     eventStore.append(TELEMETRY_STREAM, {
       type: 'tool.action_errored',
       data: { tool: toolName, durationMs, errorCode: errorCode ?? 'UNKNOWN', responseBytes, tokenEstimate },
     }).catch(() => {});
   }
   ```

2. **`view telemetry` projection update.** Add `actionErrors` and `actionErrorBreakdown` aggregations:
   ```json
   {
     "tool": "exarchos_orchestrate",
     "invocations": 132,
     "errors": 0,
     "actionErrors": 3,
     "actionErrorBreakdown": { "MERGE_ROLLED_BACK": 1, "PREFLIGHT_FAILED": 2 }
   }
   ```

3. **Keep `errors` for transport failures.** Distinguishing `errors` (transport) from `actionErrors` (envelope `success: false`) lets dashboards differentiate "the wire was bad" from "the operator got a structured error". Both are signals worth tracking; conflating them loses information.

### Tests to add

- `telemetry/middleware.test.ts` — when the handler returns `{success: false, error: {code: 'X'}}`, a `tool.action_errored` event is appended with `errorCode: 'X'`.
- `telemetry-projection.test.ts` — `actionErrors` and `actionErrorBreakdown` are computed correctly across mixed `tool.completed` + `tool.action_errored` streams.

---

## 9. Cross-cutting recommendations

These don't map to a single finding but emerged from verification:

1. **Windows CI gate.** Memory note `project_windows_ci_gap.md` already captures the problem; the install bug + F1 + F2 all surfaced on Windows and would have been caught (or at least partially caught) by a smoke-test job that runs `exarchos install-skills` + a trivial merge_orchestrate scenario against a fresh Windows runner. Worth promoting from "known gap" to "blocker for v2.10 GA."

2. **`reconcile_state` should detect projection drift.** Today it returns PASS 5/5 even when `view pipeline.completedCount` disagrees with canonical `tasks[].status`. Adding a check matrix entry would have caught F3 the first time the operator ran reconcile.

3. **Phase A→C event-sourcing posture for merge_orchestrate is solid.** I noted while tracing F1 that the orchestrator already commits `merge.requested` durably before the executor's side effect (the two-event split at `merge-orchestrate.ts:586-686`), and the executor's idempotency is genuine. F1 isn't an event-sourcing bug — it's a *git-mechanics* bug exposed by a topology assumption. The fix should land in the executor's preflight, not in the saga.

4. **Skill rendering pipeline is fine; the source-of-truth bundle isn't reaching the installer.** Memory note `project_skills_runtime_cache.md` was the first hint. Long-term: consider whether `npx skills add` is the right transport for non-Claude runtimes at all, given the upstream's `.claude/skills/`-centric scan policy. The in-process copy proposed in §1 is simpler *and* lets us ship a runtime bundle's CI check that catches the next case of "directory scanned vs directory authored" mismatch.

---

## 10. Suggested issue split

| Repo | Issue title | Findings | Suggested labels |
|------|-------------|----------|------------------|
| exarchos (root CLI) | `install-skills: silently installs wrong skill set for non-claude runtimes` | INSTALL | `bug`, `install`, `severity:high`, `windows` |
| exarchos-mcp | `merge_orchestrate captures unrelated rollback SHA when target branch is in sibling worktree` | F1 | `bug`, `merge-orchestrator`, `multi-worktree`, `severity:high` |
| exarchos-mcp | `merge_orchestrate preflight: ancestry false-positive on Windows worktree topologies — needs instrumentation` | F2 | `bug`, `merge-orchestrator`, `preflight`, `severity:medium`, `windows`, `needs-repro` |
| exarchos-mcp | `rehydrate.taskProgress and view pipeline diverge from canonical tasks[].status` | F3 | `bug`, `projection`, `rehydrate`, `severity:medium` |
| exarchos-mcp | `workflow.update reserved fields: surface in describe + skill docs` | F4 | `bug`, `workflow`, `schema`, `severity:medium` |
| exarchos (skills) | `merge-orchestrator skill: multi-worktree topology section` | F5 | `docs`, `merge-orchestrator`, `multi-worktree`, `severity:medium` |
| exarchos-mcp | `merge-pending runbook entry missing from registry` | F6a | `docs`, `runbook`, `severity:low` |
| exarchos-mcp | `view telemetry: surface action-level errors alongside transport errors` | F6b | `bug`, `telemetry`, `observability`, `severity:low` |

Recommended bundling for waves:
- **Wave 1 (data safety):** INSTALL, F1, F5. Ship together — F1 fix and F5 skill rewrite are co-dependent.
- **Wave 2 (operator trust):** F3, F4. Same projection surface; same describe surface as defense.
- **Wave 3 (diagnostics & polish):** F2 (Phase 1 only — instrumentation), F6a, F6b.

---

## 11. Systemic gaps — beyond the individual findings

The eight findings share three structural causes that no per-bug fix addresses. These deserve their own remediation track.

### 11.1 Tests verify algorithms, not operator-visible outcomes

Direct evidence:
- `src/install-skills.test.ts` — 23 test cases. Every assertion is against the constructed `npx` argv or a mocked spawn. No test runs the real CLI against a fresh `$HOME` and asserts the installed file count. INSTALL was invisible to this suite by design.
- `merge-orchestrate.integration.test.ts` — header comment: *"The only DI overrides are at the VCS / git boundary (we cannot run real git or hit a real PR provider)."* The test mocks `vcsMerge` and `gitExec` — the exact two seams where F1 lives. Calling it "integration" is misleading; structurally it's a unit test with one less mock.

Every gate verified that the code matched the spec; nothing verified the spec matched reality.

**Recommendation — add an outcome-test tier.** Linux-only (no Windows host required), runs against real git in tmpdir, with its own `npm run test:outcome` script gated in CI separately from unit/integration.

| Test | What it does | Catches |
|------|---------------|---------|
| `tests/outcome/install-skills.test.ts` | `mkdtemp` $HOME, run real CLI for each runtime, count installed SKILL.md files vs `skills/<runtime>/` manifest | INSTALL-class regressions |
| `tests/outcome/merge-orchestrate-multiworktree.test.ts` | `mkdtemp` + `git init`, set up sibling worktrees with target checked out elsewhere, run real `handleMergeOrchestrate` (no DI), assert preflight blocks with `target-checked-out-elsewhere` and no `merge.requested` event fires | F1-class topology bugs |
| `tests/outcome/rehydrate-projection-drift.test.ts` | Drive a workflow through the real MCP surface end-to-end, assert `rehydrate.taskProgress` and `view pipeline.completedCount` track `get.tasks[].status` at every step | F3-class projection drift |

Acceptance criteria for the tier: a known-failing baseline (the current main branch + the F1 / INSTALL bugs) must fail the suite; the proposed fixes from §1, §2, §4 must make it pass.

### 11.2 Eval suite is healthy but covers a different dimension; elevate it

The eval suite is already live: `.github/workflows/eval-gate.yml` runs `bun dist/evals/run-evals-cli.js` on PRs that touch `skills/`, `commands/`, `evals/`, playbooks, or CLI commands. The harness, graders, calibration, and dataset-loader all exist under `servers/exarchos-mcp/src/evals/`. Regression layer is blocking; capability layer is advisory.

But evals grade *LLM behavior against skills* — they're a behavioral-regression gate, not an engineering-correctness gate. None of INSTALL/F1/F2/F3/F4/F6 are reachable by an eval; an LLM following a perfect SKILL.md still hits the same server bugs. F5 is the one finding where an eval *could* catch the drift (an eval prompting "you're on a feature branch and integration is in a sibling worktree, what do you invoke?" would surface the gap) — worth auditing the catalog.

**Recommendation — elevate the suite, taking inspiration from `github.com/dotnet/skills`.** That project's eval framework is a useful reference for what a robust suite looks like in this category. Concrete elevation steps:

1. **Versioned dataset baseline.** Commit dataset snapshots under `evals/datasets/<date>-<topic>.jsonl`. Updates to the baseline require an explicit PR with calibration evidence — not a silent regeneration.
2. **HTML dashboard from CI.** Have the eval runner emit a static HTML report (per-skill pass rates, calibration drift, capability vs regression breakdown, time-series). Publish to GitHub Pages or as a PR artifact. The `reporters/` directory already exists; finish wiring it.
3. **Calibration drift gate.** `calibration-metrics.ts` and `calibration-split.ts` exist; surface their output as a CI signal. If grader agreement drifts past threshold vs the previous baseline, gate the run.
4. **Cross-runtime eval coverage.** Today the harness exercises Claude-centric skill content. Add at minimum one Copilot-runtime smoke eval per workflow type so the agent-flavored variants (`skills/copilot/`, `skills/codex/`, etc.) are part of the regression surface — would catch SKILL-rendering drift the per-runtime variants introduce.
5. **F5-class coverage audit.** Walk the catalog. For every code-path with operator-facing behavior (merge_orchestrate, install-skills, prepare_delegation, ...), ensure at least one eval exercises the failure topology, not just the happy path. The dogfood findings are a good source of negative cases.

The outcome-test tier (§11.1) and the elevated eval suite (this section) are *peers*, not alternatives. Outcome tests catch binary-correctness bugs; evals catch SKILL-behavior drift. Both gates are needed.

### 11.3 Add INV-6 (workflow-agnosticism) and audit the existing surface for drift

Today's invariants (INV-1 event-sourcing, INV-2 facade-equivalence, INV-3 basileus-forward, INV-4 platform-agnosticity, INV-5a-d agent-first) name platform-agnosticity but not workflow-agnosticism. Direct evidence the gap matters:

```
$ grep -h "phase-affinity:" skills-src/*/SKILL.md | sort -u
  phase-affinity: completed
  phase-affinity: delegate
  phase-affinity: gathering
  phase-affinity: ideate
  phase-affinity: merge-pending
  phase-affinity: plan
  phase-affinity: review
  phase-affinity: synthesize
```

`merge-pending` exists only in the `feature` workflow type. `merge-orchestrator/SKILL.md` lines 35-38 say "Activate this skill when the HSM is parked in `feature/merge-pending`" — explicitly typed. The *behavior* the skill describes (preflight + rollback for a local merge) is workflow-agnostic; only the trigger is coupled.

**Recommendation — codify INV-6 and run an audit pass.**

1. **Write `skills-src/design-invariants/references/INV-6-workflow-agnosticism.md`** capturing the rule:
   - A skill prescribing a **behavior** describes its triggers in workflow-neutral terms (e.g., "activated when `next_actions` surfaces verb X with idempotency key Y") — workflow-typed triggers belong in the *playbook*, not the skill.
   - A skill that *is* workflow-specific declares `workflow-type:` in frontmatter so the audit can distinguish "intentionally specific" from "leaky abstraction."
   - Add deterministic checks: grep for `feature/`, `featureId`, workflow-type literals in non-`_shared/` skill bodies; flag instances missing the `workflow-type:` declaration.
2. **Update `skills-src/design-invariants/SKILL.md`** — extend the audit checklist to walk INV-6 alongside INV-1..5, mirror the existing anti-pattern table format.
3. **Run the audit and remediate drift.** Likely targets from this verification pass:
   - `merge-orchestrator/SKILL.md` — describe behavior generically; move "HSM merge-pending entry/exit guard" to a playbook reference or to a workflow-type-specific shim skill.
   - `delegation/SKILL.md`, `synthesis/SKILL.md`, `oneshot-workflow/SKILL.md`, `workflow-state/SKILL.md` — surveyed grep hits suggest workflow-type coupling worth review.
   - `workflow-state/references/phase-transitions.md` — likely documents `feature` topology only; either generalize or declare it as the feature-typed reference.
4. **Add a CI lint** that fails when a non-`_shared/` SKILL body contains a workflow-type-literal not declared via `workflow-type:` frontmatter. Reuses the placeholder-lint + vocabulary-lint plumbing already in place.

This is the only one of the three systemic recommendations whose payoff scales with skill count — the more skills we ship, the more workflow-coupling-by-accident there is to catch.

### 11.4 Sequencing

These three tracks unblock each other:

1. **Outcome-test tier first** (§11.1) — gates the F1/F3/INSTALL code fixes. Without it, the same class of bug recurs in the next refactor.
2. **INV-6 + audit** (§11.3) — gates the F5 skill rewrite. Without the invariant in place, the rewritten skill will drift back the same way.
3. **Eval suite elevation** (§11.2) — runs alongside; doesn't block any individual fix but compounds their value.

Bake these into the Wave 1 / Wave 2 plan from §10:

| Wave | Code fixes | Systemic track |
|------|-----------|----------------|
| 1 (data safety) | INSTALL, F1, F5 | Outcome-test tier scaffolded + INSTALL outcome-test as proof point |
| 2 (operator trust) | F3, F4 | F3 outcome-test as proof point; INV-6 written and merge-orchestrator audit landed |
| 3 (diagnostics & polish) | F2, F6a, F6b | Full skill-catalog INV-6 audit; eval dashboard wired |

---

## Appendix — Verification artifacts

Files inspected during verification (paths relative to repo root):

- `src/install-skills.ts` — install bug source.
- `.claude/skills/design-invariants/SKILL.md` — frontmatter sample (no `agents:`).
- `skills/copilot/*/SKILL.md` — 17 files, all without `agents:` frontmatter (verified via `grep -c "^agents:" skills/copilot/*/SKILL.md` returning 0 across the board).
- `servers/exarchos-mcp/src/verbs/merge/merge-orchestrate.ts` — F1 orchestrator handler.
- `servers/exarchos-mcp/src/verbs/pure/execute-merge.ts` — F1 executor.
- `servers/exarchos-mcp/src/verbs/merge/local-git-merge.ts` — F1 merge adapter (defensive `git checkout target` at line 72 is the trigger).
- `servers/exarchos-mcp/src/verbs/pure/execute-merge.ts` — F1 rollback SHA capture (line 35).
- `servers/exarchos-mcp/src/verbs/pure/merge-preflight.ts` — F2 ancestry call site (line 218-222).
- `servers/exarchos-mcp/src/verbs/team/dispatch-guard.ts` — F2 algorithm (lines 65-106).
- `servers/exarchos-mcp/src/projections/rehydration/reducer.ts` — F3 rehydration handlers (lines 802-925).
- `servers/exarchos-mcp/src/views/pipeline-view.ts` — F3 pipeline view (lines 74-90).
- `servers/exarchos-mcp/src/workflow/schemas.ts` — F4 reserved-field rule (lines 515-528).
- `servers/exarchos-mcp/src/workflow/state-store.ts` — F4 enforcement (lines 552-557).
- `servers/exarchos-mcp/src/runbooks/definitions.ts` — F6a runbook registry.
- `servers/exarchos-mcp/src/telemetry/middleware.ts` — F6b telemetry middleware.
- `skills-src/merge-orchestrator/SKILL.md` — F5 skill source.
