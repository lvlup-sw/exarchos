# Implementation Plan — Wave 1 Substrate (PR1)

**Design:** [`docs/designs/2026-05-14-wave1-data-safety-substrate.md`](../designs/2026-05-14-wave1-data-safety-substrate.md)
**Date:** 2026-05-14
**Workflow:** `wave1-substrate`
**Epic:** [#1354](https://github.com/lvlup-sw/exarchos/issues/1354)
**Issues in PR1:** [#1361](https://github.com/lvlup-sw/exarchos/issues/1361) (INV-6), [#1358](https://github.com/lvlup-sw/exarchos/issues/1358) (outcome-test tier)
**PR2 issues (out of scope here):** #1355, #1356, #1357 — separate `wave1-fixes` workflow once PR1 merges
**Iron Law:** NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST

## Surface inventory

- **Skill content (DR-1):** `skills-src/design-invariants/` (source-of-truth) → `.claude/skills/design-invariants/` (rendered) via `npm run build:skills`. Existing structural test at `scripts/design-invariants-skill.test.ts` enumerates `INV-1..INV-5d`; add `INV-6` to that enumeration.
- **Test tier infra (DR-2):** Root `vitest.config.ts` already declares two projects (`unit`, `process`). Adding a third `outcome` project + `tests/outcome/` directory + helpers + CI job.
- **Seed tests (DR-3):** Three new files under `tests/outcome/` exercising real OS state (mkdtemp, real git, real CLI). All wrapped in `it.failing()` so they run RED on main without breaking CI.
- **Lint script (DR-1):** New `scripts/lint-inv6.mjs` — greps non-`_shared/` skills for workflow-type literals; advisory exit 0 in PR1.
- **Documentation (DR-7):** New `tests/outcome/_helpers/README.md` documenting `it.failing()` choreography.

## Phase map

```text
Phase A — INV-6 codification (DR-1)         ────────────────────┐
                                                                 ├──→ Phase E. Integration: skills:guard + CI
Phase B — Outcome-tier scaffolding (DR-2)  ──┐                   │
                                              ├──→ Phase C — RED seed tests (DR-3)  ──┘
Phase D — Helpers README (DR-7)            ──┘
```

- **Phase A** is independent (skill content + lint).
- **Phase B** is independent of Phase A (test infra; different files entirely).
- **Phase C** depends on Phase B (seed tests need `tests/outcome/_helpers/`).
- **Phase D** depends on Phase B (README cites helpers).
- **Phase E** is the final integration step (skills:guard + CI gate).
- **Phases A + B** can run in parallel as **Group 1**.
- **Phases C + D** can run in parallel as **Group 2** (after B).

## Provenance map (DR → tasks)

| DR | Tasks | PR |
|---|---|---|
| DR-1 | T-001, T-002, T-003, T-004, T-005, T-006, T-007 | PR1 |
| DR-2 | T-008, T-009, T-010, T-011, T-012, T-013, T-014 | PR1 |
| DR-3 | T-015, T-016, T-017, T-018 | PR1 |
| DR-7 | T-019 | PR1 |

---

## Phase A — INV-6 codification (DR-1)

All tasks edit source-of-truth at `skills-src/design-invariants/` and rebuild via `npm run build:skills`. Structural tests live at `scripts/design-invariants-skill.test.ts` (existing) and `scripts/lint-inv6.test.ts` (new).

### Task T-001: [Phase A] Extend `INVARIANT_IDS` with `INV-6`

Extends the existing structural invariant enumeration to include INV-6, then authors the reference doc that the test asserts exists. This is the foundational step that makes every subsequent INV-6 task possible.

**Phase:** RED → GREEN
**Implements:** DR-1

1. [RED] Update `scripts/design-invariants-skill.test.ts`: add `'INV-6'` to the `INVARIANT_IDS` const array (line 20-29).
   - Expected failure: `ReferenceFiles_AllInvariantsPresent` test fails because `references/INV-6-*.md` does not exist.
2. [GREEN] Create `skills-src/design-invariants/references/INV-6-workflow-agnosticism.md` with sections matching INV-4 reference doc shape: Rule, Examples (positive + negative), Deterministic checks, Audit recipe.
3. Run `npm run build:skills` to render INV-6 reference into `.claude/skills/design-invariants/references/INV-6-workflow-agnosticism.md`.

**Dependencies:** None.
**Parallelizable:** Yes (Group 1).
**Testing strategy:** structural-snapshot.

### Task T-002: [Phase A] Add `INV-6` to `design-invariants/SKILL.md` invariant list + audit checklist

Updates the design-invariants SKILL frontmatter and audit checklist body so reviewers walking the skill encounter INV-6 alongside INV-1..INV-5d. Without this, INV-6 exists as a reference doc but is not invoked by the audit flow.

**Phase:** RED → GREEN
**Implements:** DR-1

1. [RED] Add a structural test `Skill_DescriptionMentionsINV-6` in `scripts/design-invariants-skill.test.ts` asserting the SKILL.md frontmatter `description` field contains `"INV-6"` and the body contains a `## INV-6` walk section.
   - Expected failure: SKILL.md doesn't mention INV-6 yet.
2. [GREEN] Edit `skills-src/design-invariants/SKILL.md`:
   - Update `description:` frontmatter to enumerate INV-6 alongside INV-1..INV-5d.
   - Extend the audit checklist body to walk INV-6 (mirror existing INV-4 walk format).
   - Add INV-6 row to the "How to invoke" Step 2 enumeration.
   - Update the "Invariant references" list with the link to `references/INV-6-workflow-agnosticism.md`.
3. Run `npm run build:skills` to render.

**Dependencies:** T-001 (reference doc must exist for the cross-link to validate).
**Parallelizable:** No (within Phase A, sequential after T-001).
**Testing strategy:** structural.

### Task T-003: [Phase A] Add INV-6 anti-pattern row to complementarity matrix

Adds a representative INV-6 entry to the complementarity matrix table so reviewers can match a finding type ("workflow-type literal in skill body") to the invariant. Mirrors the format of existing INV-1..INV-5d rows.

**Phase:** RED → GREEN
**Implements:** DR-1

1. [RED] Add test `ComplementarityMatrix_HasINV-6Row` in `scripts/design-invariants-skill.test.ts` asserting the SKILL.md complementarity matrix table includes at least one row with INV-6 in the "Design invariant" column.
   - Expected failure: matrix has no INV-6 row.
2. [GREEN] Add at least one row to the matrix in `skills-src/design-invariants/SKILL.md` with a representative example (e.g., "Skill body references `feature/merge-pending` without `workflow-type:` declaration" → axiom `—` / invariant `INV-6`).
3. Run `npm run build:skills` to render.

**Dependencies:** T-002.
**Parallelizable:** No (sequential within Phase A).
**Testing strategy:** structural.

### Task T-004: [Phase A] Implement `scripts/lint-inv6.mjs` (advisory grep)

Implements the advisory grep that flags workflow-type literals in non-`_shared/` skill bodies, scaffolding the deterministic check INV-6 prescribes. Output shape mirrors axiom-style finding format for downstream tool reuse.

**Phase:** RED → GREEN
**Implements:** DR-1

1. [RED] Write test `LintINV6_FlagsWorkflowTypeLiterals_NonZeroFindings` in `scripts/lint-inv6.test.ts`:
   - Set up a tmpdir with two synthetic skill SKILL.md files: one with `feature/merge-pending` literal in body and no `workflow-type:` frontmatter (expected flag); one with `workflow-type: feature` declared (expected pass).
   - Run the lint via `child_process.execFileSync('node', ['scripts/lint-inv6.mjs', tmpdir])`.
   - Assert findings array contains exactly one finding pointing at the flagged file with `rule: 'workflow-type-literal-without-declaration'`.
   - Expected failure: script does not exist.
2. [GREEN] Implement `scripts/lint-inv6.mjs`:
   - Walk `skills-src/**/SKILL.md` (or directory passed as arg, defaulting to `skills-src/`).
   - Skip `_shared/` directory.
   - Per file: parse frontmatter; if `workflow-type:` declared, skip body check.
   - Else: grep body for `feature/`, `featureId`, and the literal phase names (`merge-pending`, `delegate`, `synthesize`, `review`, `gathering`); record findings.
   - Emit JSON `{findings: [{file, line, snippet, rule}], advisory: true}` to stdout.
   - Exit 0 always (advisory).
3. [REFACTOR] Confirm output shape matches `axiom`-style finding format (severity / file / line / description) for downstream tool reuse.

**Dependencies:** None (independent of T-001..T-003 — operates on file shapes that exist already).
**Parallelizable:** Yes within Phase A (could run simultaneously with T-001).
**Testing strategy:** unit (synthetic fixtures in tmpdir).

### Task T-005: [Phase A] Wire `lint-inv6` into existing skill validation

Registers the lint as an advisory step in the existing skill validation pipeline so it runs without blocking CI. Promotion to blocking is deferred to a separate follow-up issue once the catalog audit closes.

**Phase:** RED → GREEN
**Implements:** DR-1

1. [RED] Write test `LintINV6_RunsAdvisoryAgainstRealCatalog_ExitsZero` in `scripts/lint-inv6.test.ts`:
   - Run `node scripts/lint-inv6.mjs skills-src/` against the real catalog.
   - Assert exit code 0 (advisory) regardless of finding count.
   - Findings count is informational only; do not assert specific number (the merge-orchestrator skill in PR2 will reduce findings; PR1 just establishes the baseline).
   - Expected failure: T-004 must be done.
2. [GREEN] Add `lint:inv6` script to root `package.json` invoking `node scripts/lint-inv6.mjs skills-src/`.
3. Add an advisory call to `npm run lint:inv6` from `npm run skills:guard` (or equivalent skill validation entry point) — output captured but exit code from lint:inv6 not propagated. Skill validator continues to gate on its existing checks.

**Dependencies:** T-004.
**Parallelizable:** No (within Phase A — sequential after T-004).
**Testing strategy:** integration (against real repo state).

### Task T-006: [Phase A] Run `npm run build:skills`; verify per-runtime variants regenerated

Regenerates per-runtime skill outputs so INV-6 reference content propagates from `skills-src/` to `skills/<runtime>/` for every runtime. This is the build-pipeline glue the source-of-truth convention requires.

**Phase:** GREEN-only (regeneration step)
**Implements:** DR-1

1. Run `npm run build:skills`.
2. Verify `skills/<runtime>/design-invariants/references/INV-6-workflow-agnosticism.md` exists for every runtime in `runtimes/`.
3. Verify `skills/<runtime>/design-invariants/SKILL.md` body contains `INV-6` walk content.
4. Stage all regenerated `skills/<runtime>/design-invariants/**` files.

**Dependencies:** T-001, T-002, T-003.
**Parallelizable:** No (final regeneration step in Phase A).
**Testing strategy:** integration (build pipeline).

### Task T-007: [Phase A] Run `npm run skills:guard` — confirm no drift

Runs the skills-drift gate to confirm the regenerated outputs are clean and committed. Catches any `git diff skills/` divergence that would fail the same gate in CI.

**Phase:** GREEN-only (gate)
**Implements:** DR-1

1. Run `npm run skills:guard`. Expected: passes — `git diff skills/` clean after T-006 commit.
2. If drift detected: re-run `npm run build:skills`, re-stage, re-commit.

**Dependencies:** T-006.
**Parallelizable:** No.
**Testing strategy:** integration (CI gate equivalent).

---

## Phase B — Outcome-test tier scaffolding (DR-2)

All tasks add new `outcome` project to `vitest.config.ts`, create `tests/outcome/_helpers/`, wire CI. Independent of Phase A.

### Task T-008: [Phase B] Add `outcome` project to root `vitest.config.ts`

Declares a new vitest project named `outcome` alongside the existing `unit` and `process` projects, with longer timeouts and no file parallelism appropriate for real-OS-state tests.

**Phase:** RED → GREEN
**Implements:** DR-2

1. [RED] Write test `VitestConfig_DeclaresOutcomeProject_Exists` in `test/setup/vitest-config.test.ts` (or extend an existing config-shape test):
   - Import the resolved config; assert `config.test.projects` contains an entry with `name === 'outcome'`.
   - Expected failure: only `unit` and `process` declared today.
2. [GREEN] Add a third project entry to `vitest.config.ts`:
   ```ts
   {
     test: {
       name: 'outcome',
       include: ['tests/outcome/**/*.test.ts'],
       testTimeout: 30000,
       fileParallelism: false,
     },
   },
   ```

**Dependencies:** None.
**Parallelizable:** Yes (Group 1, parallel with Phase A).
**Testing strategy:** structural.

### Task T-009: [Phase B] Add `npm run test:outcome` script

Registers the script that runs the outcome project in isolation so contributors and CI can invoke it independently of the main test suite. Mirrors the existing `test:unit` / `test:process` convention.

**Phase:** RED → GREEN
**Implements:** DR-2

1. [RED] Write test `PackageJson_TestOutcomeScript_Exists` in `test/setup/package-scripts.test.ts` (or new):
   - Read `package.json`; assert `scripts['test:outcome']` exists and equals `vitest run --project outcome`.
   - Expected failure: script not declared.
2. [GREEN] Add `"test:outcome": "vitest run --project outcome"` to root `package.json`.

**Dependencies:** None (independent of T-008 — pure script registration).
**Parallelizable:** Yes within Phase B (alongside T-008).
**Testing strategy:** structural.

### Task T-010: [Phase B] Implement `tests/outcome/_helpers/tmp-home.ts`

Implements the `withTmpHome` helper that isolates `HOME` to a fresh tmpdir for the duration of the callback, restoring the original `HOME` on cleanup. Used by install-skills outcome tests to verify per-runtime installs land where expected without polluting the developer's HOME.

**Phase:** RED → GREEN
**Implements:** DR-2

1. [RED] Write test `TmpHome_CreatesIsolatedHomeDir_AndCleansUpOnDispose` in `tests/outcome/_helpers/tmp-home.test.ts`:
   - Call `withTmpHome(async (home) => { ... })`.
   - Assert `home` is an absolute path; assert `process.env.HOME === home` inside the callback; assert `process.env.HOME` reverts to original after callback resolves; assert directory deleted after callback.
   - Expected failure: helper does not exist.
2. [GREEN] Implement `tests/outcome/_helpers/tmp-home.ts`:
   - Export `async function withTmpHome<T>(fn: (home: string) => Promise<T>): Promise<T>`.
   - Uses `fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-outcome-'))`; saves prior `HOME`; sets `HOME` to tmp; calls fn; restores HOME in finally; `fs.rmSync(tmp, { recursive: true, force: true })`.

**Dependencies:** T-008 (outcome project must exist for the test to run).
**Parallelizable:** No (within Phase B, after T-008).
**Testing strategy:** unit (the helper itself is the SUT).

### Task T-011: [Phase B] Implement `tests/outcome/_helpers/tmp-git.ts`

Implements `withTmpGit` and `addSiblingWorktree` helpers for spinning up real git repositories in tmpdir with optional sibling-worktree topology. Used by merge-orchestrate seed tests to reproduce the multi-worktree failure mode end-to-end.

**Phase:** RED → GREEN
**Implements:** DR-2

1. [RED] Write tests in `tests/outcome/_helpers/tmp-git.test.ts`:
   - `TmpGit_InitsRepo_HasGitDir`: assert `withTmpGit(async (repo) => ...)` creates a real git repo with `.git/` directory.
   - `TmpGit_AddSiblingWorktree_TargetCheckedOutElsewhere`: assert `addSiblingWorktree(repo, 'integration')` creates `<repo>.worktrees/integration/`, `git worktree list --porcelain` shows two entries.
   - Expected failure: helper does not exist.
2. [GREEN] Implement `tests/outcome/_helpers/tmp-git.ts`:
   - `async function withTmpGit<T>(fn: (repoPath: string) => Promise<T>): Promise<T>` — mkdtemp + `git init` + initial commit on main.
   - `async function addSiblingWorktree(repoPath: string, branchName: string): Promise<string>` — `git -C repoPath worktree add ../worktrees/<branch> -b <branch>`; returns absolute worktree path.
   - Cleanup hook removes both repoPath and sibling worktree dir.

**Dependencies:** T-008.
**Parallelizable:** Yes within Phase B (parallel with T-010 — different files).
**Testing strategy:** unit.

### Task T-012: [Phase B] Add `tests/outcome/_helpers/README.md` placeholder

Creates a placeholder README in the helpers directory to anchor the documentation expanded later in T-019. Ensures the `_helpers/` directory is a first-class committed surface even if T-019 hasn't expanded it yet.

**Phase:** GREEN-only
**Implements:** DR-2 (helper directory needs an entry-point doc)

1. Create `tests/outcome/_helpers/README.md` (placeholder; expanded in T-019) with one-line description of each helper. Confirms the `_helpers/` directory is committed even if T-019 hasn't expanded it yet.

**Dependencies:** T-010, T-011.
**Parallelizable:** No.
**Testing strategy:** none (doc placeholder).

### Task T-013: [Phase B] Wire `outcome-tests` CI job

Adds a Linux-only CI job that runs the outcome project on every PR and is marked required in branch protection. Closes the loop between the local `npm run test:outcome` and the CI signal that gates merges.

**Phase:** RED → GREEN
**Implements:** DR-2

1. [RED] Write test `CIWorkflow_OutcomeTestsJob_IsLinuxOnly` in `scripts/ci-workflow-shape.test.ts` (or new):
   - Read `.github/workflows/ci.yml` (YAML parse).
   - Assert a `jobs.outcome-tests` entry exists with `runs-on: ubuntu-latest` (or matrix gated to Linux).
   - Assert it invokes `npm run test:outcome`.
   - Expected failure: job not present.
2. [GREEN] Add `outcome-tests` job to `.github/workflows/ci.yml`:
   - `runs-on: ubuntu-latest`
   - Steps: checkout, setup-node, `npm ci`, `npm run build`, `npm run test:outcome`.
   - Job marked required in branch protection (separate manual step, captured in PR description).

**Dependencies:** T-009 (script must exist).
**Parallelizable:** No (within Phase B).
**Testing strategy:** structural (YAML parse).

### Task T-014: [Phase B] Smoke-test `npm run test:outcome` with no tests yet

Runs the new script before any seed tests are authored to verify the project plumbing exits 0 with `passWithNoTests` semantics. Catches misconfigured project entries before Phase C lands.

**Phase:** GREEN-only (gate)
**Implements:** DR-2

1. Run `npm run test:outcome` locally — expected output: "no test files found" exit 0 (per vitest's default; if not, configure `passWithNoTests: true` in the outcome project entry).
2. If exit non-zero: add `passWithNoTests: true` to the outcome project config in T-008 (mirror the `process` project's pattern from `package.json:test:process`).

**Dependencies:** T-008, T-009.
**Parallelizable:** No.
**Testing strategy:** integration.

---

## Phase C — Three RED `it.failing()` seed tests (DR-3)

All tasks author files in `tests/outcome/`. Each test is wrapped in `it.failing()`. Tests fail on current main with their expected failure mode (regression baseline).

### Task T-015: [Phase C] Author `tests/outcome/install-skills.test.ts`

Authors the install-skills outcome seed test with one `it.failing()` case per runtime, asserting the installed manifest matches `skills/<runtime>/`. Encodes the #1355 regression class as an executable spec PR2's fix must satisfy.

**Phase:** RED-only (tests are RED by design until PR2)
**Implements:** DR-3

1. Author the test:
   ```ts
   import { describe, it, expect } from 'vitest';
   import { withTmpHome } from './_helpers/tmp-home.js';
   import { execFileSync } from 'node:child_process';
   import * as fs from 'node:fs';
   import * as path from 'node:path';

   const RUNTIMES = ['claude', 'copilot', 'codex', 'cursor', 'opencode', 'generic'];

   describe('install-skills outcome', () => {
     for (const runtime of RUNTIMES) {
       it.failing(`InstallSkills_${runtime}_FullManifestInstalled`, async () => {
         await withTmpHome(async (home) => {
           const manifestExpected = fs.readdirSync(path.resolve(`skills/${runtime}`)).filter(d =>
             fs.existsSync(path.resolve(`skills/${runtime}/${d}/SKILL.md`))
           );
           execFileSync('node', ['dist/bin/cli.js', 'install-skills', '--agent', runtime], { env: { ...process.env, HOME: home } });
           const installed = /* walk runtime.skillsInstallPath under home */;
           expect(installed).toEqual(expect.arrayContaining(manifestExpected));
         });
       });
     }
   });
   ```
2. Run `npm run test:outcome` — assert all 6 cases report as expected failures (vitest output: "6 expected failures").

**Dependencies:** T-010 (tmp-home helper), T-014 (outcome project runs).
**Parallelizable:** Yes within Phase C.
**Testing strategy:** outcome (real CLI, real fs).

### Task T-016: [Phase C] Author `tests/outcome/merge-orchestrate-multiworktree.test.ts`

Authors the merge-orchestrate seed test that drives real `handleMergeOrchestrate` against a sibling-worktree topology and asserts the preflight aborts cleanly. Encodes the #1356 regression class as an executable spec.

**Phase:** RED-only
**Implements:** DR-3

1. Author the test:
   ```ts
   import { describe, it, expect } from 'vitest';
   import { withTmpGit, addSiblingWorktree } from './_helpers/tmp-git.js';
   import { handleMergeOrchestrate } from '../../servers/exarchos-mcp/src/verbs/merge-orchestrate.js';

   describe('merge-orchestrate multi-worktree topology outcome', () => {
     it.failing('MergeOrchestrate_TargetCheckedOutInSibling_AbortsCleanly', async () => {
       await withTmpGit(async (repoPath) => {
         const integrationWt = await addSiblingWorktree(repoPath, 'integration');
         // Set up: source branch in repoPath, target ('integration') in sibling
         // Invoke handleMergeOrchestrate({ repoRoot: repoPath, sourceBranch, targetBranch: 'integration' }) — no DI mocks
         const result = await handleMergeOrchestrate(/* args */);
         expect(result.data.phase).toBe('aborted');
         expect(result.data.reason).toBe('target-checked-out-elsewhere');
         // Assert no merge.requested event fired (query event store)
       });
     });
   });
   ```
2. Run `npm run test:outcome` — assert test reports as expected failure.

**Dependencies:** T-011 (tmp-git helper), T-014.
**Parallelizable:** Yes within Phase C.
**Testing strategy:** outcome (real git, real handler).

### Task T-017: [Phase C] Author `tests/outcome/rehydrate-projection-drift.test.ts`

Authors the rehydrate seed test that drives a feature workflow through the real MCP surface and asserts the rehydrate projection tracks canonical task status. Stays RED after PR2 ships — flipped by #1359 in Wave 2.

**Phase:** RED-only (will remain RED post-PR2 — un-flipped until #1359 lands in Wave 2)
**Implements:** DR-3

1. Author the test:
   ```ts
   import { describe, it, expect } from 'vitest';
   import { withTmpGit } from './_helpers/tmp-git.js';
   /* import handleWorkflow, handleView from MCP surface */

   describe('rehydrate projection drift outcome', () => {
     it.failing('Rehydrate_TaskProgress_TracksCanonicalTaskStatus', async () => {
       await withTmpGit(async (repoPath) => {
         // Init feature workflow; use workflow.update to mutate tasks[].status
         // (without emitting task.assigned)
         // Then: rehydrate + view pipeline
         // Assert rehydrate.taskProgress[].status === tasks[].status for every i
         // Assert view.pipeline.completedCount === count(tasks where status === 'complete')
       });
     });
   });
   ```
2. Add explicit comment in the test body: `// Remains it.failing() after PR2 ships — flipped by #1359 in Wave 2.`
3. Run `npm run test:outcome` — assert test reports as expected failure.

**Dependencies:** T-011 (tmp-git helper), T-014.
**Parallelizable:** Yes within Phase C.
**Testing strategy:** outcome (real MCP surface).

### Task T-018: [Phase C] Verify `npm run test:outcome` exits 0 on main with all expected failures

Acceptance gate that runs `npm run test:outcome` and asserts exit 0 with the expected count of expected-failure annotations. Documents the regression-baseline shape for PR reviewers.

**Phase:** GREEN-only (gate)
**Implements:** DR-3 (acceptance gate)

1. Run `npm run test:outcome` after T-015, T-016, T-017 are authored.
2. Assert exit code 0; assert summary contains "expected failures" with count matching the number of `it.failing()` cases authored (6 from T-015 + 1 from T-016 + 1 from T-017 = 8).
3. Document the count in the PR description so reviewer knows the regression-baseline shape.

**Dependencies:** T-015, T-016, T-017.
**Parallelizable:** No (gate).
**Testing strategy:** integration.

---

## Phase D — Helpers README (DR-7)

### Task T-019: [Phase D] Author `tests/outcome/_helpers/README.md`

Replaces the T-012 placeholder with full documentation of helper APIs and the `it.failing()` choreography reviewers verify against. This is the operator-facing artifact that closes DR-7's failure-mode coverage requirement.

**Phase:** GREEN-only (documentation)
**Implements:** DR-7

1. Replace the T-012 placeholder with full content covering:
   - **Purpose** — outcome-tier helpers exist to set up real OS state (tmpdir + real git) for tests that verify operator-visible behavior, not algorithm equivalence.
   - **`withTmpHome`** — when to use, contract, cleanup guarantees.
   - **`withTmpGit` + `addSiblingWorktree`** — when to use, multi-worktree topology examples.
   - **`it.failing()` choreography** — how outcome tests use vitest's `it.failing()` to encode known regressions; the contract is "fix PR atomically removes the `.failing` annotation in the same diff that fixes the bug"; reviewers verify by grepping for the annotation removal.
   - **CI gating** — outcome tier is Linux-only; failure of an `it.failing()` test is expected (does not break CI); a PASS of an `it.failing()` test (test unexpectedly succeeds without annotation flip) DOES break CI — that's the choreography enforcement.

**Dependencies:** T-012 (placeholder created), T-015, T-016, T-017 (concrete examples to cite).
**Parallelizable:** Yes within Phase D (sole task).
**Testing strategy:** none (documentation; reviewed in synthesis).

---

## Phase E — Integration

### Task T-020: [Phase E] Run full test suite + skills:guard

Final integration gate that runs unit/integration/MCP/skills:guard/typecheck/outcome to confirm PR1 introduces no regressions across any tier. Catches cross-phase interactions before synthesis dispatches the PR.

**Phase:** GREEN-only (gate)
**Implements:** DR-1, DR-2, DR-3, DR-7

1. Run `npm run test:run` — assert all unit + integration tests pass (no regressions from Phase A tests).
2. Run `cd servers/exarchos-mcp && npm run test:run` — assert MCP server tests still pass.
3. Run `npm run skills:guard` — assert no drift.
4. Run `npm run typecheck` — assert clean.
5. Run `npm run test:outcome` — assert all expected failures, exit 0.

**Dependencies:** T-007, T-014, T-018, T-019.
**Parallelizable:** No (final gate).
**Testing strategy:** integration.

### Task T-021: [Phase E] Run TDD compliance check

Runs `check_tdd_compliance` per task on the feature branch to confirm RED commits precede GREEN commits per the Iron Law. Per memory, false-negatives are possible; suspect tasks get manual RED-commit inspection before re-dispatch.

**Phase:** GREEN-only (gate)
**Implements:** DR-1, DR-2, DR-3, DR-7

1. Per task with a RED step (T-001..T-005, T-008..T-013), run:
   ```ts
   exarchos_orchestrate({
     action: "check_tdd_compliance",
     featureId: "wave1-substrate",
     taskId: "<task-id>",
     branch: "feature/wave1-substrate"
   })
   ```
2. Assert each task: `passed: true`. Per memory `feedback_tdd_gate_per_commit.md`, false-negatives are possible if GREEN modifies only source files; if any task false-negatives, inspect RED commit before re-dispatching.

**Dependencies:** T-020.
**Parallelizable:** No.
**Testing strategy:** integration (orchestrator gate).

---

## Parallelization summary

```text
Group 1 (parallel after dispatch):
  Phase A: T-001 → T-002 → T-003 → T-006 → T-007    [chain]
           T-004 → T-005                              [chain, sub-parallel within A]
  Phase B: T-008 → T-010, T-011 → T-012             [chain with parallel sub-step]
           T-009                                      [independent]
           T-013                                      [after T-009]
           T-014                                      [after T-008, T-009]

Group 2 (parallel after Group 1's B-phase completes):
  Phase C: T-015, T-016, T-017 (parallel) → T-018
  Phase D: T-019

Phase E: serial gate after Groups 1+2 complete (T-020 → T-021)
```

Estimated wall-clock if dispatched in parallel via `exarchos:delegate`: ~30–45 minutes (skill content + test infra + 3 outcome tests + integration gates).

## Risk acknowledgements (carried from design)

- **vitest `it.failing()` semantics** — tests that pass without annotation flip break CI; this is desired choreography but T-019 README must be clear about it.
- **Linux-only outcome tier** — gated `runs-on: ubuntu-latest` in T-013 CI job.
- **INV-6 audit false positives** — T-004/T-005 keep lint advisory in PR1; promotion to blocking is a separate follow-up.
- **PR1 + PR2 ordering** — captured in workflow init for `wave1-fixes` (out of scope for this plan).

## Out of scope (deferred to `wave1-fixes` workflow)

- #1355 install-skills rewrite — PR2.
- #1356 preflight + executor — PR2.
- #1357 skill rewrite + INV-6 audit — PR2.
- Annotation flips for the seed tests landed in PR1 — PR2 fix commits do this atomically.
- Full INV-6 catalog audit (delegation/synthesis/oneshot-workflow/workflow-state) — separate v2.10.0 GA follow-up issue.
- Lint promotion from advisory to blocking — separate follow-up issue.
