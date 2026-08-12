# Verification Ladder — Slice 1 (Phase 0 + R4 + boundary ride-alongs)

- **Date:** 2026-06-09
- **Status:** Design — approved approach B (interim policy table); feeds `/exarchos:plan`
- **Feature ID:** `verification-ladder-slice1`
- **Epic:** [#1515](https://github.com/lvlup-sw/exarchos/issues/1515) — risk-proportional verification pipeline
- **Sub-issues in scope:** #1516 (R1), #1518 (R3), #1522 (R7), #1523 (R8), #1519 (R4), #1527 (SIV-1), #1528 (SIV-2), #1529 (SIV-3 Layer A only), #1530 (SIV-4)
- **Research:** `docs/research/2026-06-02-verification-{token-efficiency,mutation-testing-first-class-tool,pipeline-recommendations}.md`; `docs/research/2026-06-06-structural-integration-verification.md` (currently on branch `docs/structural-integration-verification` — merge as a ride-along of this slice)
- **Milestone:** v2.11.0 — Verification & Reliability (first preview build)

## 1. Problem & scope

Exarchos today mandates uniform red-green-refactor on every task and gates it with `check_tdd_compliance`, a git-history ordering inspector with a documented false-negative and the weakest evidence base of any gate we run. The expensive part of the pipeline (strict ordering, full per-task ceremony) carries the least benefit; the cheap part (an executable oracle plus execution feedback) carries most of it. Meanwhile the most tautology-prone signal we accept — agent-authored integration tests and mocks of unowned APIs — has no structural counterweight at all.

This slice lands the spine of the replacement: a mechanically derived `riskTier` and `boundaryTouching` classification on every task, a git-only adequacy kill-probe replacing the ordering gate as the blocking signal, toolchain-resolved `mutation`/`lint`/`contract` capability, two structural boundary gates (contract drift, mock-of-unowned-dep), an import-boundary lint preset, tier-conditional implementer prompts, and the skill reframe from "Iron Law" to "verification ladder."

**Out of scope (explicitly):** R2 config-resolved policy overrides (#1517 — but see §4.2 for the interim table this slice does land), R5 `check_mutation_adequacy` (#1520), R6 cheap-mix planning defaults (#1521), R9 onboard/doctor integration (#1524 — `onboard` remains verification-blind until then, by design), R10 governance (#1525), SIV-3 Layer B taint analysis, SIV-5/6/7. The framing from the research holds: this is not a new feature — it right-sizes an existing gate and resolves an already-assumed capability on the substrate the repo already built (Bundle B resolver, v2.10.1; onboard reconciler, v2.10.2).

## 2. Constraints (invariant anchors)

Anchored to `.exarchos/invariants.md`. Always-load set probed during design: INV-1 (every gate run emits `gate.executed`; no side state), INV-2 (new verbs/gates are parity-tested facades over one dispatch core with registered `outputSchema`), INV-5a/INV-5b (schema-constrained inputs, fixed result carrier, tool count unchanged), INV-6 (**the watch-item** — tier *values* are substrate task data; tier→gate *policy* lives in topology/playbook config, never in skill prose or workflow-typed branches), INV-8 (gate re-runs idempotency-collapse via `operationId`), INV-11 (SIV-4 constrains agent behavior via the environment, not convention), INV-12 (gate verdicts and survivors surface as `next_actions` affordances), INV-15 (everything here is local, single-machine). Pulled in on domain match: INV-4 (skills edited at `skills-src/` and regenerated; toolchain commands resolved, never baked), INV-5c (`run-mutation`/`run-contract` are dry-run-capable control-plane verbs), INV-5d (every new capability is an action on `exarchos_orchestrate`, no fifth tool), INV-10 (mutation runs are the canonical long-running op — liveness events; full Tasks integration deferred to R5 with the gate itself), INV-14 (the kill-probe's revert/restore must use refuse-to-discard primitives — never `reset --hard`).

## 3. The ladder (target shape after this slice)

```
            riskTier (blast radius)              boundaryTouching (orthogonal tag)
            ───────────────────────              ─────────────────────────────────
  low:      typecheck → lint                     +contract-drift (if tag set)
  medium:   typecheck → lint → scoped tests      +contract-drift, +mock-boundary
            → kill-probe                          (advisory)
  high:     medium sequence + full suite         same as medium
            (mutation adequacy = R5, later)

  check_tdd_compliance: blocking → advisory (all tiers; events keep flowing)
```

Both axes derive mechanically in `classifyTask` — no LLM in the hot path. The table above is data (§4.2), not prose: skills and playbooks reference it; they do not re-encode it.

## Technical Design

### 4.1 Classification spine — R1 + SIV-1 (#1516, #1527)

Extend `TaskClassification` in `servers/exarchos-mcp/src/verbs/team/prepare-delegation.ts` with `riskTier: 'low' | 'medium' | 'high'` and `boundaryTouching: boolean`. Derivation is pure and deterministic over fields `TaskInput` already carries (`files`, `blockedBy`, `testLayer`) plus glob tables:

- **high** — any file matching schema/type/API/shared-contract globs (the documented blast-radius gap), or `testLayer: 'acceptance'`, or `blockedBy.length ≥ 2`, or `files.length ≥ 3`.
- **low** — all files match rename/log/doc/config globs.
- **medium** — default (single-module behavior).
- **boundaryTouching** — `testLayer ∈ {integration, acceptance}`, or changed-file globs hit adapter/client/IO directories, or a resolved schema artifact (OpenAPI/proto/GraphQL) is in scope. A tag, not a tier: a low-blast schema-adapter edit can still be boundary-tagged.

The glob tables live beside the classifier as exported consts so the policy module (§4.2) and tests share them. LLM tie-breaking is out of scope for this slice — ties resolve conservatively upward (medium). Plan templates (`skills-src/implementation-planning/references/{task-template,testing-strategy-guide}.md`) gain the two fields so planners can override the derived value explicitly; an explicit value wins over derivation (mirrors the toolchain resolver's override-first layering).

**Hazard (known trap):** `buildRegistrationSchema` throws at MCP startup if two orchestrate actions declare the same field name with different base types. `riskTier` and `boundaryTouching` must use identical types anywhere they appear in action schemas.

### 4.2 Interim verification policy table (approach B — the slice's one new decision)

A new typed module `servers/exarchos-mcp/src/workflow/verification-policy.ts`, deliberately mirroring `review-contract.ts` (the established single-source-of-truth pattern for dimension names): a frozen const table mapping `(riskTier, boundaryTouching)` to an ordered list of gate action names, exactly as drawn in §3. Consumers: `prepare_delegation` (stamps the resolved sequence onto each task's delegation record so the dispatch prompt and `next_actions` can carry it — INV-12), the playbooks (`workflow/playbooks.ts` references gate names from the table, never literals), and R7's prompt assembly (§4.7).

**The R2 boundary, drawn crisply:** this slice ships the *table* and its consumers. It ships **no** `.exarchos.yml` `verification:` block, **no** override resolution, **no** generalization of `withConfigSeverity` into a tier-aware resolver. R2 (#1517) later wraps this table as the built-in default layer of a config-resolved policy — additive, no relocation, because the table already lives where INV-6 says policy belongs. If during implementation anything in this module starts reading config, that work item moves to R2.

Why a TS module and not topology YAML: there is no `topology.yaml` on disk today — topology is `workflow/hsm-definitions.ts` (scheduled for deletion in v3.0's SDK migration). A typed module beside `review-contract.ts` is the current-architecture-consistent home, and the v3.0 Workflow SDK migration will carry both contracts across in one move.

### 4.3 Kill-probe + demotion — R3 (#1518)

New action `check_test_adequacy` (new `servers/exarchos-mcp/src/verbs/gates/test-adequacy.ts` + registry entry + `handleOrchestrate` branch): **revert the task's source hunks (keep test hunks) → run the task's test command via the resolved toolchain → assert at least one new test fails → restore.** This is mutation testing at N=1 (coarsest mutant: "the code isn't there") — pure git plus the resolved test command, so it is language- and runtime-agnostic (INV-4/INV-6) with zero new tooling.

Mechanics, INV-14-conformant: snapshot the worktree state first (`git stash create` / temp commit — refuse-to-discard, never `reset --hard`); compute source-vs-test hunk split from the task's diff against its base (test globs from the toolchain/`.exarchos.yml`, defaulting to co-located `*.test.*` per repo convention); restore is unconditional (finally-block semantics) and verified by comparing the restored tree hash to the snapshot. The result carrier: `{passed, probedTests, redObserved, restoredClean}` plus the standard envelope (INV-5b); failure modes (`no-new-tests`, `revert-conflict`, `restore-failed`) are explicit discriminants, never silent successes. Each run emits `gate.executed` with `operationId` idempotency (INV-8; never CAS-pin a follow-on event to a prior append's returned sequence).

`check_tdd_compliance` flips its default severity to **advisory** via the existing `withConfigSeverity` knob — the gate, its events, and ConvergenceView consumption all remain (open Q5 resolved: *advisory, not removed*; removal is reconsidered after R5 lands the real adequacy backstop).

### 4.4 Toolchain extension + verbs + drift gate — R4 + SIV-2 (#1519, #1528)

`ToolchainCommands` (`servers/exarchos-mcp/src/config/toolchains.ts`) grows three fields, all `readonly … | null`: `mutation: string | null`, `lint: string | null`, `contract: { codegen: string | null; diff: string | null } | null`. Seed `BUILTIN_TOOLCHAINS`: node → `npx stryker run`; dotnet → `dotnet stryker`; rust → `cargo mutants --in-diff`; python → `mutmut run`; java-maven → pitest; contract seeds keyed on detected schema artifacts (proto → `buf generate`/`buf breaking`; OpenAPI → `openapi-typescript`/`oasdiff`; GraphQL → `graphql-codegen`/`graphql-inspector`). `resolveTestRuntime` generalizes to `resolveVerificationRuntime` — same synchronous per-field layered resolution (override → `.exarchos.yml` direct → user `toolchains:` → task-runner → built-in → unresolved), now over the wider field set; `resolveTestRuntime` remains as a thin delegating alias so existing consumers don't churn.

Two new CLI verbs mirror `run-tests.ts`: `cli-commands/run-mutation.ts` and `run-contract.ts` (`--dry-run` prints the resolved command; exit-code contract identical). One new gate action `check_contract_drift` (new `verbs/gates/contract-drift.ts`): regenerate stubs → typecheck → breaking-diff the schema against the **merge-base** (mirrors the kill-probe's baseline choice), fail on breaking drift, at zero LLM tokens. Carrier: `{passed, drift, breaking[], report}`. It is a **drift gate, not a write-lock** — the agent may edit anything; the gate rejects drift after the fact. **Degrade path (INV-4 parity):** when no contract tool resolves — including managed/non-native worktrees — the gate returns `skipped/advisory`, never a hard failure. Its `next_actions` carry the honest-limit steer: "contracts verify shape, not meaning — keep exactly ONE semantic test for this boundary; delete redundant shape assertions." CLI verbs and MCP actions share one core with parity tests and registered `outputSchema` (INV-2/INV-5b). Long mutation runs emit `mutation.executing_started`/terminal events (INV-10); full Tasks integration rides R5 with the adequacy gate itself.

### 4.5 Mock-boundary check — SIV-4 (#1530)

New action `check_mock_boundary` (new `verbs/gates/mock-boundary.ts`): scan the task's **test-file diff** for mock identifiers (the Hora-Robbes ~94%-precision heuristic: `mock|stub|spy|fake|patch|monkeypatch`), resolve each mocked target, and cross-reference against an **ownership manifest** — first-party globs under a new `.exarchos.yml` `ownership:` key (default: the repo's own `src/**` trees); everything unmatched is unowned. A mock of an unowned dependency yields an **advisory** finding (default; severity configurable via `withConfigSeverity` like every gate) whose `next_actions` steer constructively: "replace the mock of `<dep>` with a hermetic fixture / contract-verified stub / a fake" (INV-12 — the affordance is the fix, not the scold). Mocking first-party modules passes untouched. The escape hatch is explicit and logged in the gate event payload — an enforced default, not an absolute (the hermetic-resolver SIV-5 and mutation backstop R5 arrive in later slices; until then advisory is the honest severity). Complementarity is by design: SIV-4 catches *mocking the wrong thing*; R5 later catches *tests that assert nothing*. Also sharpens `testing-strategy-guide.md`'s existing prose ("mock only at infrastructure boundaries") into a pointer at the machine check.

### 4.6 Import-boundary lint preset — SIV-3 Layer A (#1529)

Ship the cheap, reliable half now: a config preset for an import-boundary linter (`eslint-plugin-boundaries` or `dependency-cruiser` — pick one at plan time after checking what the repo already carries) that forbids domain-core modules from importing IO adapters, riding the existing `check_static_analysis` gate (`verbs/pure/static-analysis.ts`) as additional lint configuration — no new action. A test fixture proves the preset blocks a core→IO import in CI. Layer B — the "no raw IO into core" taint rule (flagging `JSON.parse`/`response.json()`/`req.body` results that don't cross a registered parser, plus downstream `as Brand` casts) — is **explicitly deferred** to Phase 2 with its Semgrep/CodeQL degrade path for non-TS runtimes. The `testing-strategy-guide.md` edit couples parse-at-edge guidance to the SIV-1 boundary tag so planners route boundary tasks toward parse-first designs.

### 4.7 Tier-conditional prompt + skill reframe — R7 + R8 (#1522, #1523)

R7: `skills-src/delegation/references/implementer-prompt.md` becomes tier-conditional — low-risk dispatches get a 3-line verification note; medium/high get the fuller block including the kill-probe expectation; boundary-tagged tasks additionally get the mock-steer note (SIV-4). The compiled IMPLEMENTER spec (`servers/exarchos-mcp/src/agents/definitions.ts`) renders from the same source; the tier value comes from the §4.2 policy stamp on the delegation record, so prompt assembly reads data, not branching prose (INV-6).

R8 reframes the five TDD-hardcoding skills: `implementation-planning/SKILL.md` ("Iron Law" → "verification ladder"), `_shared/references/tdd.md` → `verification.md` (red-green-refactor presented as the high-tier path, ladder as the frame), `oneshot-workflow/SKILL.md`, `refactor/SKILL.md` (keep characterization; add the oracle-integrity gate note — `git diff -- tests/`: the oracle may be added to, not silently modified), and `quality-review/SKILL.md` (forward-reference the mutation-adequacy dimension that R5 will register — prose pointer only; the `review-contract.ts` dimension itself lands with R5, honoring the single-source-of-truth rule). **INV-4 is enforcing here** (mode:check on `skills/**` diffs): every edit goes to `skills-src/`, then `npm run build:skills`, and both trees are committed together or `skills:guard` fails CI.

## 5. Conformance summary & known hazards

| Surface | Invariants | Note |
|---|---|---|
| riskTier/boundary classification | INV-6, INV-1 | Task data; derivation pure; policy in §4.2 module |
| Policy table | INV-6, INV-12 | Typed module beside review-contract.ts; no config reads (R2 line) |
| check_test_adequacy | INV-5d, INV-5b, INV-1, INV-8, INV-14, INV-4/6 | Refuse-to-discard revert; explicit failure discriminants |
| Toolchain fields + verbs | INV-4, INV-6, INV-2, INV-5c | Resolve-don't-bake; dry-run; parity + outputSchema |
| check_contract_drift | INV-5d, INV-5b, INV-2, INV-1 | Merge-base baseline; skipped/advisory degrade |
| check_mock_boundary | INV-5d, INV-12, INV-11, INV-1 | Advisory default; affordance-shaped next_actions |
| SIV-3 Layer A | INV-4 | Rides existing static-analysis gate; no new action |
| Prompt/skills | INV-4 (enforcing), INV-2 | skills-src + regenerate; agent spec generated |

Implementation traps already on record (apply to every new action): each registered action **must** get a `handleOrchestrate` dispatch branch and be tested *through* `handleOrchestrate`, not only via its handler (the `UNKNOWN_ACTION` DOA trap from PR #1534); shared field names across action schemas must keep identical base types or registration throws at startup; gates resolving workflow state must use `resolveWorkflowState`, never read `.state.json` directly.

## 6. What the first preview build demonstrates

(1) A planned task arrives at dispatch with a derived `riskTier` and `boundaryTouching` visible on its delegation record. (2) A low-tier task routes through typecheck+lint only — no kill-probe, no TDD ceremony — and its implementer prompt is three lines of verification guidance. (3) A medium-tier task gets the kill-probe: an assert-nothing test is caught red-handed (mutant survives), a real test passes the probe. (4) A boundary-tagged task gets `check_contract_drift`: a breaking schema edit fails the gate at zero LLM tokens; on a runtime with no contract tool the gate degrades to skipped/advisory. (5) A test diff mocking an unowned dependency surfaces the steer-to-hermetic `next_action`. (6) `check_tdd_compliance` reports advisory everywhere; ConvergenceView still renders its events. (7) `exarchos run-mutation --dry-run` and `run-contract --dry-run` print resolved commands on this repo (node toolchain).

## 7. Bundling for /plan

Five bundles, ordered to keep each independently green: **B1** classification spine + policy table (R1, SIV-1, §4.2 — pure functions, widest downstream fan-in, land first); **B2** kill-probe + demotion (R3 — depends on B1 only for the routing stamp); **B3** toolchain fields + resolver generalization + two verbs + drift gate (R4, SIV-2 — self-contained substrate); **B4** mock-boundary check + SIV-3 Layer A preset (independent gates); **B5** prompt + skill reframes (R7, R8 — last, so prose references finished mechanics; single high-blast `skills-src` regeneration). B1 and B3 are schema/type-reshape bundles — **high tier by this design's own classifier**: run the full suite between their merges (the recorded TDD-gate blast-radius lesson). Docs ride-along: merge branch `docs/structural-integration-verification` with B1.

## 8. Resolved & remaining questions

**Resolved here:** epic Q5 — `check_tdd_compliance` stays advisory, not removed; revisit post-R5. Epic Q8 — moot: Bundle B and #1510 shipped; R4 lands now, R9 (#1524) wires onboard/doctor later. Routing-before-R2 — approach B (interim typed table, §4.2). SIV-3 linter choice → plan-time after dependency check. **Remaining (deferred, tracked):** mutation threshold calibration (R5), equivalent-mutant handling (R5), `subagent.tokens_used` telemetry (R10 — the epic's acceptance gate), possible new catalog invariants via `/exarchos:invariants` after the design proves out.
