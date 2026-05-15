# Wave 1 Data Safety + Substrate (preview.3 continuation)

**Status:** design (pending plan-review)
**Date:** 2026-05-14
**Scope:** v2.10.0-preview.3 — Wave 1 (4 issues) + #1361 (INV-6 prereq from Wave 2)
**Composes with:** #1361 (INV-6), #1355 (install-skills), #1356 (rollback-SHA), #1357 (merge-orchestrator skill rewrite), #1358 (outcome-test tier)
**Prereq:** Wave 0 carrier swap merged (commit `8a732811`, PR #1287 / #1369)
**Operational topology:** Two PRs, two feature workflows (Approach C — substrate before fixes)
**Out of scope (this design):** Wave 2 bug fixes (#1359 #1360), Wave 3 (#1362–#1365)
**Supporting:** [Windows dogfood remediation](../research/2026-05-13-windows-dogfood-remediation.md) §1, §2, §6, §11.1, §11.3; [Wave 0 carrier swap](2026-05-13-wave-0-carrier-swap.md) for the registered `outputSchema` surface this composes onto.

## TL;DR

Five issues split across two PRs along a substrate-vs-fixes seam. PR1 (`wave1-substrate`) lands the new outcome-test tier with three `it.failing()` seed tests plus the codified INV-6 (workflow-agnosticism) — the harness and the invariant that PR2 is built against. PR2 (`wave1-fixes`) ships the three behavioral fixes (#1355 install transport, #1356 merge-orchestrate preflight + executor, #1357 merge-orchestrator skill rewrite). Each fix in PR2 atomically removes its corresponding `it.failing()` annotation, so reviewers verify operator-observable correctness in a single-bit observation per fix. The substrate-first topology ratifies the "tests verify operator-visible reality, not algorithm-spec equivalence" principle in commit shape, not just prose. INV-6 codification before #1357 closes the chicken-and-egg where the rewritten skill would otherwise re-drift workflow-typed.

## Context

### 1.1 What was just delivered

Wave 0 — the agent output contract carrier swap — landed in commit `8a732811`. Every MCP-registered action now declares a per-action `outputSchema`; the wire emits `structuredContent` validated against it; `next_actions` and `ActionAnnotations` are typed in the schema; emitted JSON Schemas conform to draft 2020-12. The four downstream dogfood waves now compose onto a typed surface — any new envelope field (preflight failure payloads, projection-as-of timestamps, action-error counters) extends the registered schema rather than slipping into untyped JSON.

### 1.2 The unfinished business of preview.3

Issue #1354 catalogs eleven remaining sub-issues across three waves: data safety (Wave 1), operator trust (Wave 2), diagnostics & polish (Wave 3). Eight are direct verifications of Windows-dogfood findings; three are systemic gaps no per-bug fix addresses. This design covers Wave 1's four data-safety items plus #1361 from Wave 2, because #1361 is a hard prereq for Wave 1's #1357 — without INV-6 codified, the rewritten merge-orchestrator skill will re-drift workflow-typed and immediately fail audit when the invariant lands later.

### 1.3 The substrate-vs-fixes principle

Two of the five in-scope issues are systemic gates rather than bug fixes: #1358 (outcome-test tier) is the proof-point harness for #1355 / #1356 / #1359, and #1361 (INV-6) is the audit prereq for #1357. The rest (#1355, #1356, #1357) are behavioral fixes. The five compose into a clean two-layer topology — a substrate layer (gates + tests + invariants) and a behavior layer (the actual fixes that satisfy the substrate). Landing them as one PR would bury the layering inside a 1,500-LOC squash; landing each as its own PR would force a 5-deep stack with high rebase cost. A two-PR split — substrate first, fixes second — is the smallest stack that preserves the substrate-first principle in commit topology.

## Design

### 2.1 Operational topology — two PRs, two workflows

**PR1 — `feature/wave1-substrate`** (this design's workflow). Two tasks:
- **#1361** — INV-6 reference doc + skill update + advisory CI lint
- **#1358** — outcome-test tier scaffolding + 3 `it.failing()` seed tests

Lands as a single squash commit on main. PR1 is small (~400 LOC), narrow in cognitive surface (test infra + skill content), and ships against current broken behavior — the seed tests fail honestly because the bugs are real.

**PR2 — `feature/wave1-fixes`** (follow-up workflow, dispatched after PR1 merges). Three tasks:
- **#1355** — install-skills in-process tarball + release-artifact wiring
- **#1356** — `targetWorktreeAvailability` preflight + executor hardening
- **#1357** — merge-orchestrator skill rewrite using #1356's payload, INV-6 audited

Each fix removes its corresponding `it.failing()` annotation atomically. Single-bit reviewer signal per fix. PR2 lands as a single squash commit on main — preserves the "Wave 1 data safety" semantic for `git log` and changelog generation.

### 2.2 Test choreography — RED-first with `it.failing()`

The three seed tests in #1358 encode the failure topologies *as discovered*, not as imagined. Each is wrapped in vitest's `it.failing()` so the tests run on every PR, their failure is expected (CI accounting clean), and a fix PR atomically removes the `.failing` annotation in the same diff. Reviewers verify "the fix works against operator-observable behavior" by grepping for the annotation removal — no need to read the test diff to understand the contract.

Three seed tests, each Linux-only (mkdtemp + real-fs + real-git):

1. **`tests/outcome/install-skills.test.ts`** — mkdtemp `$HOME` → run real `exarchos install-skills --agent <runtime>` for each runtime → count installed `SKILL.md` files vs. `skills/<runtime>/` manifest. Currently fails: copilot/codex/cursor/opencode/generic produce 1 installed file (`design-invariants` only); claude alone produces the full bundle.
2. **`tests/outcome/merge-orchestrate-multiworktree.test.ts`** — mkdtemp + git init → set up sibling worktrees with target checked out elsewhere → run real `handleMergeOrchestrate` with no DI mocks → assert preflight blocks with `target-checked-out-elsewhere`, no `merge.requested` event fires, no `rollbackSha` captured. Currently fails: rollback SHA is the cwd HEAD (an unrelated branch), `phase: 'rolled-back'` returned falsely.
3. **`tests/outcome/rehydrate-projection-drift.test.ts`** — drive a workflow through the real MCP surface → assert `rehydrate.taskProgress` + `view pipeline.completedCount` track `get.tasks[].status` at every step. Currently fails: projections undercount when status is mutated via `workflow.update` without `task.assigned` emission. Stays `it.failing()` until #1359 (Wave 2) lands.

### 2.3 INV-6 codification

A new invariant — **workflow-agnosticism** — joins INV-1..INV-5d in `skills-src/design-invariants/SKILL.md`. Reference doc at `skills-src/design-invariants/references/INV-6-workflow-agnosticism.md` defines:

- A skill prescribing a **behavior** describes triggers in workflow-neutral terms (e.g., "activated when `next_actions` surfaces verb X with idempotency key Y"). Workflow-typed triggers belong in **playbooks**, not in skill prose.
- A skill that **is** workflow-specific declares `workflow-type:` in frontmatter so audits can distinguish "intentionally specific" from "leaky abstraction."
- Deterministic checks: grep for `feature/`, `featureId`, workflow-type literals in non-`_shared/` skill bodies; flag any without a `workflow-type:` declaration.

The `design-invariants/SKILL.md` body extends to walk INV-6 alongside INV-1..5; the anti-pattern table mirrors the existing format. CI lint (built on the existing placeholder-lint + vocabulary-lint plumbing) is **advisory in PR1** — logs but does not fail. Promotion to blocking is a separate follow-up issue, gated on the full catalog audit reaching INV-6-clean (deferred to v2.10.0 GA per #1361's preview.3 scope decision).

The audit pass remediates only `merge-orchestrator/SKILL.md` as proof-point — that's PR2's #1357 final form, validated against PR1's audit checklist.

### 2.4 Outcome-test tier infrastructure

A new top-level test directory `tests/outcome/` with its own runner config:

- New npm script `test:outcome` runs vitest against `tests/outcome/**/*.test.ts` only.
- vitest config: longer timeouts (30s default), no test concurrency (each test owns its mkdtemp), `failOnExpectedFailure: false` so `it.failing()` tests don't break CI when their failure is expected.
- Helpers: `tests/outcome/_helpers/tmp-home.ts` for mkdtemp HOME setup with cleanup, `tests/outcome/_helpers/tmp-git.ts` for fresh git repo + sibling-worktree topology.
- New CI job `outcome-tests` in `.github/workflows/ci.yml`, gated `if: runner.os == 'Linux'` and required as a check.
- Tier is a **peer** of unit/integration, not a replacement. Unit tests (ms) verify algorithm equivalence; integration tests (~100ms) verify wired-component shapes; outcome tests (seconds) verify operator-visible reality against real OS state.

Eval suite (LLM-behavior gate) and outcome-test tier (binary-correctness gate) are independent peers — both needed, neither subsumes the other.

### 2.5 PR2 design — fixes (follow-up workflow)

Detailed for narrative completeness; PR2 is dispatched as a separate `feature/wave1-fixes` workflow against this design.

**#1355 install-skills rewrite.** Replace `npx skills add` shell-out (`src/install-skills.ts:298-311`) with `downloadRuntimeBundle(runtime, version, dest)` helper that pulls `skills-<runtime>.tgz` from GitHub Releases, with `git archive --remote=<repo> v<version> -- skills/<runtime>/` fallback for unreleased versions. Release workflow change emits `skills-<runtime>.tgz` per supported runtime plus a `manifest.json` (sha256 + file list, computed from `find skills/<runtime>/ -name SKILL.md`). Post-install validator compares installed listing to manifest; non-zero exit + structured diff on divergence. The `.claude/skills/` directory stays committed for local dev but is structurally invisible to installs because the installer's source-of-truth is the release tarball, not a repo clone. Flips `tests/outcome/install-skills.test.ts` from `it.failing()` to `it()`.

**#1356 preflight guard + executor hardening.** New preflight `targetWorktreeAvailability` in `pure/merge-preflight.ts` uses `git worktree list --porcelain` to detect target-checked-out-elsewhere; surfaces structured `{passed: false, blocked: true, reason: 'target-checked-out-elsewhere', checkedOutAt, hint}` payload conforming to the registered `outputSchema` error branch (Wave 0 carrier-checklist conformance). Returns terminal `phase: 'aborted'` — never captures a `rollbackSha`. Executor defense layered on top: `recordRollbackPoint` (`pure/execute-merge.ts:30-46`) changes from `git rev-parse HEAD` (cwd-dependent) to `git rev-parse refs/heads/${targetBranch}` (target-anchored); failure is fatal — no rollback anchor = no merge. New `categorizeCheckoutFailure` pre-pass detects `fatal: '<branch>' is already used by worktree` in captured stderr; surfaces as `categorizedReason: 'target-worktree-busy'`. New terminal phase `phase: 'aborted-pre-merge'` distinguishes "we never started" from "we rolled back" — closes the silent-fallback hazard the current `phase: 'rolled-back'` returns even when `git reset --hard` was a no-op. Flips `tests/outcome/merge-orchestrate-multiworktree.test.ts` from `it.failing()` to `it()`.

**#1357 merge-orchestrator skill rewrite.** Adds a "Topology" section between Step 2 and Step 3 covering: where target should live (typically `.worktrees/integration`), how to point `repoRoot`, what `targetWorktreeAvailability` failures look like, wave-level merges in the `delegate` phase as a supported pattern. Replaces the line-150 anti-pattern row with two rows naming both worktree-target-elsewhere variants. Softens "main worktree" language to match advisory-not-hard-refuse reality. Cross-links #1356 resolution. Runs `npm run build:skills` to regenerate every per-runtime variant. Passes INV-6 audit using PR1's checklist — workflow-type literals in the rewritten body either declare `workflow-type: feature` in frontmatter or get rephrased in workflow-neutral terms.

## Invariant + Dimension Audit (axiom:design + design-invariants)

Walks every applicable dimension (DIM-1..8) and project-specific invariant (INV-1..6). Generic dimensions render first; project-specific invariants follow per pairing convention.

### DIM-1 Topology + INV-1 / INV-2

**Generic.** New preflight is a pure function in `pure/merge-preflight.ts` — no side-effecting mutation in the executor path. Outcome-tier helpers are isolated to `tests/outcome/_helpers/` with no cross-dependency on production code. Install transport rewrite moves I/O orchestration into a single `downloadRuntimeBundle` helper; the rest of `installSkills()` stays pure orchestration.

**INV-1.** No new event-store mutation; #1356 emits no events on aborted preflight (vs. current behavior which emits `merge.requested` + `merge.rollback` against the wrong SHA). Net reduction in spurious events.

**INV-2.** `merge_orchestrate` is exposed via both MCP and CLI; the new payload extends both surfaces uniformly because it lives in the registered `outputSchema`. No facade drift.

### DIM-2 Observability + INV-5b

**Generic.** New terminal phase `aborted-pre-merge` is observable, distinct from `rolled-back`. Structured error payloads (`reason`, `checkedOutAt`, `hint`) make remediation actionable from the envelope alone. Expected-failure tier visibility: `it.failing()` runs the test (not `.skip`) and reports its expected-failure count in the test summary.

**INV-5b.** Preflight payload extends `Envelope<T>`'s error branch, conforming to the registered `outputSchema` (Wave 0 carrier-checklist). All new `_meta` slots typed at registration site. No untyped JSON on the wire.

### DIM-3 Contracts + INV-5b

**Generic.** Manifest.json sha256 + file-list contract for #1355's release tarball is a typed contract between release pipeline and install validator. `it.failing()` annotation flip is a typed contract between PR2's fix commits and PR1's seed tests.

**INV-5b.** Reiterating: Envelope extension at registered outputSchema level, not call-site bolt-on.

### DIM-4 Test fidelity

**Strongest property of this design.** The outcome-test tier closes the gap between "algorithm correct per spec" (what unit tests verify) and "operator-visible behavior matches reality" (what dogfooding reveals). Three Windows-dogfood bugs (#1355, #1356, #1359) slipped past every PR because the test suite mocked the seams where the bugs lived. The tier ships RED-first so the seed tests act as an executable spec for the fixes — fixes that "look right but don't fix the bug" cannot remove the annotation. The tier is a peer of unit/integration, not a replacement; the eval suite (LLM-behavior gate) is also a peer, not subsumed. Three test categories now exist: algorithm-equivalence (unit/integration), operator-visible correctness (outcome), agent behavior (eval).

### DIM-5 Vestigial code

N/A — no removal of dead code in this scope.

### DIM-6 Coupling + INV-6

**Generic.** PR1 has zero coupling to PR2 — substrate ships against current broken behavior, not against future fixes. PR2 has minimal coupling to PR1 — imports the test runner, flips annotations. #1356's preflight is a new pure function; #1357's skill rewrite cites the new payload but adds no compile-time dependency. Cross-PR coupling is at the it.failing()-annotation-flip site only.

**INV-6.** Codification removes the largest source of skill-vs-playbook coupling drift. `merge-orchestrator/SKILL.md` after PR2 describes behavior in workflow-neutral terms; HSM-coupled triggers ("when parked in `feature/merge-pending`") move to the playbook reference. Audit checklist extends to all skills in subsequent passes.

### DIM-7 Silent fallbacks

**Generic.** #1356 specifically removes a silent fallback: today the rollback executes a no-op `git reset --hard rollbackSha` (HEAD never moved because the merge failed at `git checkout`) and reports `phase: 'rolled-back'` falsely. The new design returns `phase: 'aborted-pre-merge'` when the reset is a no-op — explicit failure mode, no operator misled by a state-implies-action lie.

### DIM-8 AI prose

N/A at design time — reviewed in synthesis-phase quality-review skill.

### INV-3 Basileus-forward

N/A — no surface boundary touched.

### INV-4 Platform-agnosticity

**Win.** #1355's tarball-based install removes Windows-fragile `npx skills add` dependency (Windows-specific shell-quoting + path-separator drift). The outcome-tier itself is Linux-only by design — Windows/macOS coverage remains the responsibility of the existing platform CI matrix (#1170 windows-latest, #1232 macOS, #1233 platform probes) per the discovery report's intentional scope boundary. The outcome-tier is a proof-point class for behavioral correctness, not a replacement for platform-CI parity.

### INV-5a Input ergonomics

**Win.** #1357 adds the operator-trust signal that tooling alone cannot — "do NOT use for" guidance in the merge-orchestrator skill prose. Pairs with #1310 (tool description guidance) which is a separate surface (sibling concern, not in scope here).

### INV-5c Aspire verbs

N/A — no new verbs.

### INV-5d Action discriminator

N/A — no new top-level tools.

## Requirements

This design's **Requirements** section is scoped to PR1 (workflow `wave1-substrate`). DR-1..DR-3 cover the substrate deliverables; DR-7 covers error-handling/failure-mode discipline that lands with PR1. PR2's behavioral fixes (#1355, #1356, #1357) are described in §2.5 as future-work prose without DR-N labels — PR2 will author its own design document with its own DR-N traceability when the `wave1-fixes` workflow starts. Each DR has acceptance criteria.

### DR-1: INV-6 reference doc + skill update + advisory lint

**Acceptance criteria:**
- `skills-src/design-invariants/references/INV-6-workflow-agnosticism.md` exists, follows the same structure as INV-1..INV-5d reference docs (rule, examples, deterministic-check section, audit recipe).
- `skills-src/design-invariants/SKILL.md` extends the audit checklist to walk INV-6 alongside INV-1..5; anti-pattern table includes a row for workflow-type leakage.
- CI lint script in `scripts/` greps for workflow-type literals in non-`_shared/` skill bodies; reports advisory findings (logs warning, exit 0).
- `npm run build:skills` runs clean — INV-6 reference content propagates to per-runtime skill outputs.

### DR-2: outcome-test tier scaffolding

**Acceptance criteria:**
- `tests/outcome/` directory exists with `_helpers/tmp-home.ts` and `_helpers/tmp-git.ts` (mkdtemp setup + cleanup hooks).
- Root `vitest.config.ts` declares an `outcome` project with: 30s default timeout, no file parallelism, includes `tests/outcome/**/*.test.ts`.
- `npm run test:outcome` script in root `package.json` runs `vitest run --project outcome`.
- New CI job `outcome-tests` in `.github/workflows/ci.yml`, gated `runs-on: ubuntu-latest`, marked required.

### DR-3: Three RED `it.failing()` seed tests

**Acceptance criteria:**
- `tests/outcome/install-skills.test.ts` exists, wraps each runtime case in `it.failing()`, asserts file-count + manifest-match.
- `tests/outcome/merge-orchestrate-multiworktree.test.ts` exists, wrapped in `it.failing()`, asserts no `merge.requested` event + structured `phase: 'aborted'` payload.
- `tests/outcome/rehydrate-projection-drift.test.ts` exists, wrapped in `it.failing()`, asserts projection equality with `tasks[].status`.
- All three tests fail on current main with their expected failure mode (regression baseline confirmed).
- `npm run test:outcome` exits 0 on main with all `it.failing()` cases reported as expected failures in summary output.

### DR-7: Error-handling — outcome-tier choreography documentation (PR1 portion)

**Acceptance criteria:** *(error-handling / failure-mode coverage requirement)*
- `tests/outcome/_helpers/README.md` documents the `it.failing()` choreography: tests encode regressions as expected failures; a fix PR atomically removes the `.failing` annotation; if a test passes without the annotation flip, vitest reports it as an unexpected pass and CI breaks (this is the choreography enforcement, not a bug).
- Comment in `tests/outcome/rehydrate-projection-drift.test.ts` explicitly cites #1359 (Wave 2) as the un-flipped fix, so reviewers know that test stays RED after PR2 ships.
- Failure-mode coverage for the three seed tests: each test name follows `Method_Scenario_Outcome`; each test's expected-failure mode is named in a comment so reviewers know what the regression baseline encodes.

## Risks & open questions

### 5.1 vitest `it.failing()` semantics

**Risk:** if a fix lands and the test passes but the annotation isn't flipped, vitest reports the test as a *failure* (its actual passing contradicts the expected-failure marker). This is the desired choreography — forces the annotation flip — but contributors unfamiliar with `it.failing()` may be confused. **Mitigation:** comment on each `it.failing()` site naming the issue number and the expected-flip moment; update `tests/outcome/_helpers/README.md` (or skill) explaining the choreography.

### 5.2 Linux-only outcome tier

**Risk:** Windows-specific bugs slip past the outcome tier. **Mitigation:** outcome-tier is a *proof-point class*, not a Windows-CI replacement. Platform parity is the responsibility of #1170 (windows-latest unit matrix), #1232 (macOS CI), #1233 (platform probes). The discovery report explicitly scoped outcome-tier to Linux to keep complexity contained; broadening is a separate issue once the tier proves itself.

### 5.3 INV-6 audit false positives

**Risk:** legitimate workflow-specific skills get flagged. **Mitigation:** `workflow-type:` frontmatter slot lets them declare opt-out; lint is advisory in PR1 (logs warning, exit 0); blocking promotion is gated on full catalog audit reaching INV-6-clean (separate follow-up issue).

### 5.4 Release-tarball provenance

**Risk:** tarball gets corrupted or substituted between release publish and install download. **Mitigation:** `manifest.json` sha256 + post-install validator; non-zero exit on mismatch with structured diff. Future hardening (signed tarballs, sigstore attestations) is a separate issue once the manifest validator is proven in production.

### 5.5 PR2 reviewer fatigue

**Risk:** three behavioral fixes in one PR is bigger than ideal review surface (~1,000 LOC across install, merge, skill content). **Mitigation:** each fix is independently testable via the outcome tier landed in PR1 — reviewer can verify "does the annotation flip correlate with the fix"; cognitive surfaces are also independently bounded (install transport, merge preflight, skill markdown). If review surfaces fatigue empirically, fall back to splitting PR2 into 3 stacked PRs as a contingency.

### 5.6 PR1 + PR2 ordering enforcement

**Risk:** PR2 is dispatched before PR1 merges; fixes find seed tests don't exist yet. **Mitigation:** PR2 workflow init is gated on PR1 merge confirmation in the orchestrator; explicit `addBlockedBy` on PR2 workflow tasks if both are dispatched in the same window.

## Out of scope (deferred)

- **PR2 (`wave1-fixes` workflow)** — #1355 install-skills rewrite, #1356 merge-orchestrate preflight + executor, #1357 merge-orchestrator skill rewrite + INV-6 audit. PR2 ships once PR1 lands. PR2 will author its own design document with its own DR-N traceability when the workflow starts; §2.5 of this design provides the prose preview that PR2's design will formalize.
- **Wave 2 bug fixes** (#1359 projection drift, #1360 RESERVED_FIELD discoverability) — separate workflows once Wave 1 is closed. #1359 is the un-flipped third seed test landed in PR1; that annotation flip lives in Wave 2's design.
- **Wave 3** (#1362 Windows preflight instrumentation, #1363 merge-pending runbook, #1364 telemetry undercount, #1365 eval-suite elevation) — independent workflows. #1365 is a peer of #1358 in substrate spirit and warrants its own brainstorming pass when scheduled.
- **Full INV-6 catalog audit** beyond `merge-orchestrator/SKILL.md` — v2.10.0 GA follow-up issue. PR1 + PR2 ship the invariant + one proof-point; full catalog (delegation, synthesis, oneshot-workflow, workflow-state) is a separate scope.
- **CI lint promotion to blocking** — separate follow-up issue once the catalog audit closes.
- **Outcome-tier on Windows/macOS** — see #1170 / #1232 / #1233.
- **#1310 — "do NOT use for" in `merge_orchestrate` tool description** (sibling to #1357's SKILL markdown change but a different surface). Adjacent, can ship in parallel with PR2 if scoped.
