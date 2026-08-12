# Wave 0 follow-ups — stack execution plan

**Feature ID:** `wave-0-followups`
**Workflow type:** refactor
**Authored:** 2026-05-13
**Stacks on:** [PR #1369 — Wave 0 carrier swap](https://github.com/lvlup-sw/exarchos/pull/1369) (OPEN at plan time)
**Execution mode:** strictly sequential A → B → C (no overlap)
**Base strategy:** start now on `feature/v2-10-wave-0-carrier-swap`; retarget to `main` when #1369 merges

This plan is the **stack-level glue** for three already-authored per-PR briefs:

- [PR-A brief — #1367 formatResult cleanup](../followups/2026-05-13-pr-a-1367-formatresult-cleanup.md) (5 phases, ~3–5 h)
- [PR-B brief — #1368 CLI wiring](../followups/2026-05-13-pr-b-1368-cli-wiring.md) (4 phases, ~4–6 h)
- [PR-C brief — #1366 Zod v4 migration](../followups/2026-05-13-pr-c-1366-zod-v4-migration.md) (8 phases, ~16–24 h)

The per-PR briefs already enumerate task IDs (A1.1…A5.4, B1.1…B4.4, C1.1…C8.5), acceptance criteria, and risks. This plan does NOT re-author them — it sequences them, defines integration branches, gates the transitions, and orchestrates merges.

---

## 1. Stack topology

```
main
 └── feature/v2-10-wave-0-carrier-swap          (PR #1369, OPEN)
      └── refactor/wave-0-followups/1367-formatresult-cleanup       (PR-A, base ↑)
           └── refactor/wave-0-followups/1368-cli-toCliResult-wiring (PR-B, base ↑)
                └── refactor/wave-0-followups/1366-zod-v4-migration   (PR-C, base ↑)
```

**Retarget rule:** if #1369 merges into `main` before PR-A is open, point PR-A at `main` and skip the retarget step. If #1369 merges while PR-A is open, GitHub auto-retargets PR-A to `main`; run `gh pr update-branch --rebase` on PR-A immediately and `git rebase origin/refactor/wave-0-followups/1367-formatresult-cleanup` on PR-B/PR-C heads in sequence.

---

## 2. Sequencing — why strictly sequential

**Conflict surface** (files touched by ≥2 PRs):

| File | PR-A | PR-B | PR-C |
|---|---|---|---|
| `servers/exarchos-mcp/src/format.ts` | deletes `formatResult` | imports `toEnvelope` | migrates all Zod usage |
| `servers/exarchos-mcp/src/adapters/cli.ts` | — | rewrites `emitResult` | migrates Zod usage in shared types |
| `servers/exarchos-mcp/src/adapters/mcp.ts` | — | — | rewrites validation paths |
| `servers/exarchos-mcp/src/workflow/tools.ts` | deletes `registerWorkflowTools` | — | Zod sweep |
| `servers/exarchos-mcp/src/views/tools.ts` | deletes `registerViewTools` | — | Zod sweep |
| `servers/exarchos-mcp/src/stack/tools.ts` | deletes `registerStackTools` | — | Zod sweep |
| `servers/exarchos-mcp/src/parity*.test.ts` (~20 files) | possibly deletes 1–2 | rewrites ~61 assertions | Zod-idiom updates if any |

PR-A removes call sites; PR-B rewires the surface PR-A just narrowed; PR-C rewrites the type machinery underpinning everything. Running these in parallel guarantees three-way conflicts in `format.ts`, the tools files, and the parity suite. Strictly sequential is the only safe order.

**Implication for wall-clock:** ~25–35 h serialized. The user has authorized this in exchange for zero merge-conflict thrash.

---

## 3. Phase-by-phase execution (orchestrator playbook)

### 3.1 Pre-flight (orchestrator inline, ≤15 min)

| Step | Action |
|---|---|
| P0.1 | Verify clean working tree on `feature/v2-10-wave-0-carrier-swap` (`git status` clean; current branch matches). |
| P0.2 | Confirm `npm run test:run` green from MCP server AND root on the current branch — this is the baseline. Any regression in PR-A/B/C is "from here." |
| P0.3 | Re-check #1369 state with `gh pr view 1369 --json state,mergeable`. If `MERGED`, switch base strategy to `main` and skip §6 retarget step. |
| P0.4 | Commit this plan: `docs(wave-0-followups): stack execution plan` on `feature/v2-10-wave-0-carrier-swap`. Emit `state.patched` updating `artifacts.plan` to this file's path. |

### 3.2 PR-A execution — `#1367 formatResult cleanup`

Reference: [PR-A brief](../followups/2026-05-13-pr-a-1367-formatresult-cleanup.md) §"Implementation plan" phases 1–5.

| Wave | Brief tasks | Dispatch shape |
|---|---|---|
| A-W1 | A1.1 – A1.4 (audit) | Single scaffolder/researcher agent, output `docs/followups/2026-05-13-pr-a-audit.md`. **Gate:** audit doc committed before W2 dispatch. |
| A-W2 | A2.1 – A2.3 (port unique coverage) | Single implementer agent if A1.2 manifest non-empty; otherwise skip. |
| A-W3 | A3.1 – A3.4 (delete legacy wrappers) | Single implementer agent. Per-tool atomic commits. |
| A-W4 | A4.1 – A4.3 + A5.1 – A5.4 (residual sweep + delete `formatResult`) | Single implementer agent. Commits as per brief. |
| A-W5 | PR creation | `gh pr create --base feature/v2-10-wave-0-carrier-swap --head refactor/wave-0-followups/1367-formatresult-cleanup` with body referencing #1367 + acceptance checklist from PR-A brief. |

**A-exit gate (all must hold before starting PR-B):**

- [ ] All A-brief acceptance boxes checked (grep proofs ran clean)
- [ ] `npm run test:run` green (MCP server + root)
- [ ] `npx tsc --noEmit` clean (MCP server + root)
- [ ] PR-A is open, CI green
- [ ] `npm run skills:guard` passes if any skill content touched (unlikely for this PR)

### 3.3 PR-B execution — `#1368 CLI wiring`

Reference: [PR-B brief](../followups/2026-05-13-pr-b-1368-cli-wiring.md) §"Implementation plan" phases 1–4.

| Wave | Brief tasks | Dispatch shape |
|---|---|---|
| B-W0 | Branch from `refactor/wave-0-followups/1367-formatresult-cleanup` | Orchestrator inline. |
| B-W1 | B1.1 – B1.3 (wire `emitResult`) | Single implementer agent. Expect ~61 RED parity tests after this commit lands — that is the failing-test state per brief. |
| B-W2 | B2.1 – B2.4 (parity test updates, parallelized **per file within PR-B only**) | Up to ~10 implementer agents in parallel waves per the brief's grouping table. **Each agent's scope is one or two test files.** Parallelism is internal to PR-B; this does NOT relax §2's stack-level serialization. |
| B-W3 | B3.1 – B3.4 (activate `CliParity_VwLs_ByteEqualEnvelope_AcrossCarriers`) | Single implementer agent. |
| B-W4 | B4.1 – B4.4 (verification + `EXARCHOS_CLI_ENVELOPE=0` comment update) | Orchestrator inline. |
| B-W5 | PR creation | `gh pr create --base refactor/wave-0-followups/1367-formatresult-cleanup --head refactor/wave-0-followups/1368-cli-toCliResult-wiring` referencing #1368. |

**B-exit gate (all must hold before starting PR-C):**

- [ ] All B-brief acceptance boxes checked
- [ ] `npm run test:run` green (MCP server + root) — all 61 parity tests pass on envelope shape
- [ ] `CliParity_VwLs_ByteEqualEnvelope_AcrossCarriers` is live and green; banner block at `cli-parity.test.ts:20-36` removed
- [ ] `npx tsc --noEmit` clean
- [ ] PR-B is open, CI green
- [ ] INV-2 facade equivalence officially "respected" (not "partial")

### 3.4 PR-C execution — `#1366 Zod v4 migration`

Reference: [PR-C brief](../followups/2026-05-13-pr-c-1366-zod-v4-migration.md) §"Implementation plan" phases 1–8.

| Wave | Brief tasks | Dispatch shape |
|---|---|---|
| C-W0 | Branch from `refactor/wave-0-followups/1368-cli-toCliResult-wiring` | Orchestrator inline. |
| C-W1 | C1.1 – C1.5 (audit + decision points) | Single researcher agent. **Output:** `docs/research/2026-05-13-zod-v4-breaking-changes.md` + decision record covering the three "Decision points" listed in PR-C brief §"Decision points the user may want to weigh in on". **Gate:** decision record committed; orchestrator surfaces decisions to user for confirmation before C-W2 starts. |
| C-W2 | C2.1 – C2.7 (foundation: bump dep + adapter rewrite) | Single implementer agent. **Iron Law gate:** capture full `npx tsc --noEmit` error list as the failing-test surrogate before any source change. |
| C-W3 | C3.1 – C3.4 (`contract/schemas/envelope.ts`) | Single implementer agent. |
| C-W4 | C4 (`registry.ts`) | Single implementer agent. **Critical file** — most complex Zod introspection. |
| C-W5 | C5.1 – C5.4 (adapters/mcp.ts + cli.ts + cli-format.ts) | Single implementer agent. |
| C-W6 | C6.1 – C6.7 (sweep remaining surfaces) | **Parallel agents, internal to PR-C only** — up to 5–7 agents per the brief's wave table. Stack-level serialization is preserved. Per-agent scope: one directory subtree, runs `tsc --noEmit && vitest run <scope>` until GREEN. |
| C-W7 | C7.1 – C7.3 (snapshot updates with manual diff review) | Single agent, requires orchestrator-inline diff inspection per snapshot per brief §"Risks". |
| C-W8 | C8.1 – C8.5 (final verification + live integration test for native 2020-12) | Orchestrator inline. |
| C-W9 | PR creation | `gh pr create --base refactor/wave-0-followups/1368-cli-toCliResult-wiring --head refactor/wave-0-followups/1366-zod-v4-migration` referencing #1366. |

**C-exit gate (all must hold before merge):**

- [ ] All C-brief acceptance boxes checked
- [ ] `npm run test:run` green (MCP server + root)
- [ ] `npx tsc --noEmit` clean (MCP server + root)
- [ ] Live integration test confirms `tools/list` advertises native `$schema: https://json-schema.org/draft/2020-12/schema` via SDK converter (not wrapper relabel)
- [ ] All snapshot diffs manually reviewed and approved (regressions rejected per §"Risks")
- [ ] PR-C is open, CI green

---

## 4. Subagent dispatch conventions (per [CLAUDE.md](../../CLAUDE.md) and memory)

Apply at every wave that spawns subagents:

- **Pre-dispatch:** commit design/plan/research artifacts on the integration branch before spawning. The `feedback_orchestrator_commit_before_dispatch` memory warns that recovery sequences scrub untracked files in the main worktree.
- **Branch reset in prompt:** every implementer agent boots in `.claude/worktrees/agent-*` branched from `main`. Prompt MUST include explicit `git checkout -B <work-branch> <integration-branch>` reset. The integration branch for each PR is its own head branch — A's tasks reset to PR-A's head, B's to PR-B's head, C's to PR-C's head.
- **Nested install:** each subagent worktree needs `cd servers/exarchos-mcp && npm install` before scoped tests — otherwise Zod-v4 (PR-C) and parity-test (PR-B) suites will fail with fake module-resolution errors.
- **No `git stash`:** stash storage is shared across worktrees per `feedback_subagent_stash_hazard`. If a subagent needs to set aside WIP, instruct it to commit-then-reset, not stash.
- **Emit `task.assigned` per dispatch:** `feedback_orchestrator_task_assigned_emission` — rehydration's `taskProgress` is silently empty without it.
- **Validation-gate caveats:**
  - `check_static_analysis` runs in the main worktree — does NOT catch typecheck regressions on the agent's worktree. Run `npx tsc --noEmit` explicitly after agent completion before merging into the integration branch.
  - `check_tdd_compliance` false-negatives on canonical RED→GREEN when GREEN modifies only source files (`feedback_tdd_gate_per_commit`). Inspect RED commit manually if the gate balks.
  - For PR-C specifically: a major-version Zod bump has broad blast radius (`feedback_tdd_gate_blast_radius`). Run **full** `npm run test:run` between waves C-W4, C-W5, C-W6, not just per-task scope.
- **State source for `post_delegation_check`:** pass explicit `stateFile=workflow-state/wave-0-followups.state.json` per `feedback_post_delegation_state_source`.

---

## 5. Iron Law TDD discipline per PR

- **PR-A** — failing test is "registry composes without the deleted symbols and the suite stays green." Audit phase establishes the manifest; subsequent deletes proven by suite green.
- **PR-B** — failing tests ALREADY exist after B1.1 lands the wiring change. ~61 parity tests go RED; B2 takes them to GREEN one file at a time. RED-first order is preserved.
- **PR-C** — failing tests are the `npx tsc --noEmit` error list captured after C2.1's dep bump. Each subsequent wave brings a typed surface back to GREEN; per-wave scoped vitest run confirms.

---

## 6. Merge orchestration

After all three PRs are open and individually CI-green:

1. `gh pr merge 1367 --auto --squash` (PR-A) — GitHub auto-retargets PR-B to `feature/v2-10-wave-0-carrier-swap`.
2. Watch PR-B CI; if conflicts surface from the retarget, `gh pr update-branch --rebase` on PR-B.
3. `gh pr merge 1368 --auto --squash` (PR-B) — GitHub auto-retargets PR-C.
4. Watch PR-C CI; rebase if needed.
5. `gh pr merge 1366 --auto --squash` (PR-C).

If #1369 has not merged by the time PR-A is ready: hold PR-A merge until #1369 merges, then PR-A auto-retargets to `main` and the rest of the stack collapses one level.

Use `/exarchos:shepherd` to babysit CI on each PR rather than polling manually.

---

## 7. Acceptance — when this workflow is done

- [ ] Three PRs merged: #1367 + #1368 + #1366
- [ ] Wave 0 carrier swap deliverables formally complete (PR-A removes legacy paths; PR-B respects INV-2; PR-C lands native 2020-12)
- [ ] No `formatResult` symbol in MCP server source
- [ ] No `register*Tools` legacy wrappers in MCP server source
- [ ] No `zod-to-json-schema` dependency in `servers/exarchos-mcp/package.json`
- [ ] `tools/list` advertises native draft 2020-12 (not relabeled) — verified by live integration test
- [ ] `npm run test:run` green at the merged tip on `main` (MCP server + root)
- [ ] Workflow `wave-0-followups` transitioned to `completed` via `/exarchos:cleanup`

---

## 8. Risk register (stack-level only — per-PR risks remain in their briefs)

| Risk | Mitigation |
|---|---|
| PR-A's audit (A1.2) finds substantial unique coverage in legacy tests, ballooning A2 scope | Acceptable — A2 is bounded by what A1.2 catalogs. If catalog is huge, surface to user before A-W2. |
| PR-B's parity test rewrite uncovers a real data-shape mismatch (not just envelope wrapping) | Treat as an escape — pause the wave, file an issue, surface to user. Do not silently mask the assertion. |
| PR-C's Zod v4 introduces a behavioral diff in `_zod.def.type` introspection that breaks `buildRegistrationSchema` semantics | C-W4 is the single most fragile wave. Budget full re-design if `_def`→`_zod.def` is non-isomorphic. Researcher in C-W1 must catalog every `_def` site. |
| #1369 merges with conflicts mid-stack | Standard rebase-cascade per §6. Document any non-trivial conflict resolutions on the merge commit. |
| User cancels mid-stack | Each PR is independently mergeable in its own right (modulo retargeting). Cancellation point should snapshot which PRs are ready-to-merge vs in-flight. |
| Snapshot regression in PR-C masks a real schema change | C-W7 mandates manual diff review per snapshot — no `-u --force`. Reject any snapshot that drops required fields. |

---

## 9. Out of scope for this stack

- Migrating other lvlup-sw workspaces from Zod v3 (basileus, root installer)
- Removing the `EXARCHOS_CLI_ENVELOPE=0` opt-out flag (PR-B brief §"Out of scope" defers this to v2.11.0)
- Re-introducing strict 2020-12 validation at the `tools/list` boundary (PR-C brief §"Out of scope")
- Refactoring the `handle*` business-logic functions in `workflow/`, `views/`, `stack/` (PR-A §"Out of scope")

---

## 10. Workflow event hygiene

Throughout execution, the orchestrator MUST:

- Emit `task.assigned` on every subagent dispatch (per memory; otherwise rehydration silently misses progress)
- Emit `task.completed` on every successful subagent return with the agent's commit SHAs
- Emit `task.failed` on any non-green completion with the failure summary
- Emit `phase.advanced` at PR creation for each PR
- Emit `state.patched` whenever an artifact path is finalized

Reference: `feedback_orchestrator_task_assigned_emission` and `feedback_tdd_gate_per_commit` memories.
