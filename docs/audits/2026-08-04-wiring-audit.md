# Wiring Audit — all 48 structural-closure work packages

**Date:** 2026-08-04
**Method:** seven parallel read-only program audits (one per PROGRAM), each scoring its packages against **their own acceptance criteria** in `unified-remediation-plan.md`, plus `docs/system-design.html` and `.exarchos/invariants.md` (with the #1608 supersessions applied).

Axes: **wired** (reachable from production composition — exported or unit-tested is *not* wired) · **operational** (can produce its intended blocking outcome) · **leveraged** (used everywhere it applies, not one call site while other code bypasses it) · **conformant** (meets its stated acceptance criterion).

This is the artifact cited as an Input by `docs/specs/2026-08-04-wiring-closure-and-unified-integration-suite.md`.

## Totals

| Program | Pkgs | OK | Gap | Broken | HIGH | Not fully wired | Inert | Not leveraged |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| P01 state & evidence | 7 | 0 | 6 | 1 | 2 | 5 | 2 | 6 |
| P02 gates & verification | 7 | 2 | 4 | 1 | 2 | 3 | 2 | 4 |
| P03 contract & API | 9 | 1 | 6 | 2 | 3 | 7 | 3 | 8 |
| P04 effects & recovery | 6 | 2 | 4 | 0 | 2 | 4 | 1 | 4 |
| P05 ship surface | 5 | 2 | 2 | 1 | 2 | 2 | 1 | 2 |
| P06 admission | 7 | 0 | 5 | 2 | 3 | 6 | 4 | 6 |
| P07 migration & retirement | 7 | 1 | 6 | 0 | 2 | 6 | 0 | 6 |
| **Total** | **48** | **8** | **33** | **7** | **16** | **33** | **13** | **36** |

Supporting measurement: of 841 MCP test files, **109 (13%)** drive real composition — P01 24%, P02 14%, P03 5%, P04 **0%**, P06 **0% from the public root**, P07 25%. P05 is the exception: it is covered by the compiled-binary sweep (`test/process/packaged-proof.test.ts` — actions 120/120, aliases 2/2, hostCommands 9/9, cancellationPaths 14/14, errorFamilies 2/6, effectFamilies 2/3) with a working seeded-action ratchet.

## The 16 HIGH findings

| Pkg | Finding |
|---|---|
| **P01-02** | Projection degradation is an ephemeral per-response `_meta` annotation on ONE composite, recomputed from an in-memory LRU, persisted nowhere, consumed by nobody. No consumer returns a typed degraded result; stale state is served as `success: true`. |
| **P01-03** | Bare-boolean rejection is enforced only at the Zod schema level; those schemas gate nothing the shipped transition path consults. `guards.ts:54` `makeArtifactGuard` evaluates `artifacts[field] != null`, so `{"artifacts":{"plan":true}}` satisfies a phase gate. |
| **P02-03** | `task_complete` blocks on `gate.executed`/`static-analysis`, an event the migrated durable-runner producers stopped emitting (they append `admission.evidence-recorded`). The only way through is `evidenceBypass`, supplied by the agent being governed, which disables all gate enforcement at once. |
| **P02-04** | `riskTier` is resolved and frozen at `prepare_delegation` but never delivered: `TASK_COMPLETION`/`TASK_FIX` pass only `{repoRoot, worktreePath}`. With the tier undefined, a HIGH-tier task with no probe-able tests still returns `passed: true`. |
| **P03-05** | `adapters/cli.ts:7` imports `dispatch` directly; `cli-surface.json` is read only by drift guards; agreement is asserted by a harness over a **mocked** handler with a simulated MCP arm. Per the governing INV-2 this is the legacy state, and the census redefines the criterion to one that cannot fail. |
| **P03-07** | Five per-harness renderers ship (`claude/codex/copilot/cursor/opencode`) while the shim ratchet's entire inventory is two rows describing a self-declared dead stub. Discovery is marker-driven, so governed count and real count are decoupled by construction. |
| **P03-09** | Against ~120 real actions the oracle uses canned envelopes with `requiredRoles: []` / `declaredEffects: []`. It observes zero real handler behavior, and its effect/idempotency axes convert **absent observation into positive assurance**. |
| **P04-04** | No parent-directory fsync anywhere, so journal-before-backup ordering is accidental. With the journal absent and a backup present, `safeRemove(plan.backupDir)` runs unconditionally *before* staging — destroying the only surviving OLD tree (INV-14). All 8 fault tests inject in-process throws, which always run the `catch`. |
| **P04-05** | The VCS census matches only `worktree add|remove` and `branch -d\|-D` as adjacent literals and explicitly scopes out merge/commit/branch-create, so `local-git-merge.ts` is invisible **by design**. Duplicate-prevention is proven for worktrees only; for PRs not at all. |
| **P05-01** | The signed release manifest is never produced, signed, published, or consumed; its verifier is not in `package.json` `files[]`; no source/contract identity is embedded. Installers check only an unsigned sidecar hash. Present-not-wired in its purest form. |
| **P05-03** | Containment derives the required inventory *and* the packaged layer from the same `contents` map, so deleting a real agent/alias/hook shrinks both sides and the proof still passes. Nothing reads a shipped artifact. |
| **P06-03** | `tools.ts` collapses an absent/malformed tier to `low` and hardcodes `boundaryTouching: false` — the acceptance criterion says unknown risk must never become low. Freeze semantics unmet: the tier is re-resolved every attempt from post-update state. |
| **P06-05** | Three modules mutate phase — the guarded path plus `cancel.ts:367` and `cleanup.ts:303` calling `executeTransition` directly. **INV-9 is violated today**, independent of cutover, and neither bypass is shadow-observed. |
| **P06-06** | `next-actions-computer.ts` enumerates raw HSM topology and never evaluates a guard, so the runtime advertises moves admission would deny. Separately, `cleanup.ts:271/277` force-writes `reviews[*].status = 'approved'` immediately before the guard reads it. |
| **P07-01** | `liveShadowSink` is a process-scoped in-memory ring buffer emitting no events; `evaluateCutoverGate` has zero production callers; live conditions read only `legacyOutcome`. Twenty attempts that all threw would satisfy three of four conditions. |
| **P07-07** | One of three advisories the repo's own manifest names is outside the registry; the unfiltered-CI-path claim is free text checked only for filename shape; `lint-inv6`'s bare-verb literals make its promotion threshold unreachable. |

## Corrections recorded against this audit

- **RETRACTED** — a `check_test_adequacy` vacuous-pass finding was measured against the *installed* binary (built 2026-07-20 19:37), which predates all 178 branch commits. Current source returns the correct blocking verdict. The real defect split out as the toolchain-glob replacement bug (fixed).
- **REFUTED** — the P01 audit's claim that `createCliDispatchContext` has zero production call sites is false; it is the first statement of `buildCli()` (`adapters/cli.ts:317`).
- **PARTIALLY REFUTED** — the merge path *is* ledgered (durable `merge.requested` intent, deterministic idempotency keys, `git reset --keep`). What stands is that it does not route through `VcsMutationOwner` and the census cannot see it.
- **CONFIRMED by direct inspection** — `makeArtifactGuard` accepts any non-null; three modules call `executeTransition`; `evaluateCutoverGate` has no production caller; `invariants-loader.ts:460` gates on `devCatalog !== 'enabled'`.

## Full package table

Legend: W=wired, O=operational, L=leveraged, C=conformant.

| Pkg | Sev | Verdict | W | O | L | C | Title |
|---|---|---|---|---|---|---|---|
| P01-01 | MEDIUM | GAP | yes | yes | consistent | partial | Atomic append and startup repair |
| P01-02 | HIGH | BROKEN | partial | inert | bypassed | not-met | Projection degradation and reliability |
| P01-03 | HIGH | GAP | no | inert | underused | partial | Evidence and admission algebra |
| P01-04 | MEDIUM | GAP | partial | partial | underused | partial | Phase attempts and frozen state |
| P01-05 | MEDIUM | GAP | yes | partial | underused | met | Canonical evidence production |
| P01-06 | MEDIUM | GAP | partial | partial | underused | partial | Evidence concurrency and contradiction |
| P01-07 | MEDIUM | GAP | partial | partial | underused | partial | Trusted identity and protected events |
| P02-01 | MEDIUM | GAP | yes | partial | consistent | partial | Native gate health |
| P02-02 | NONE | OK | yes | yes | consistent | met | Wave-scoped delegation |
| P02-03 | HIGH | BROKEN | partial | inert | bypassed | not-met | Integration ownership and cadence |
| P02-04 | HIGH | GAP | yes | partial | underused | partial | Test adequacy |
| P02-05 | MEDIUM | GAP | partial | partial | underused | partial | Plan and coverage semantics |
| P02-06 | MEDIUM | OK | yes | yes | consistent | met | Decomposition and risk plausibility |
| P02-07 | MEDIUM | GAP | partial | inert | underused | partial | Workflow guidance and toolchain truth |
| P03-01 | MEDIUM | GAP | yes | partial | underused | partial | Freeze contract authority |
| P03-02 | MEDIUM | GAP | partial | partial | bypassed | partial | Close envelopes, security, compatibility |
| P03-03 | MEDIUM | GAP | partial | yes | underused | partial | Build the contract compiler |
| P03-04 | LOW | OK | yes | yes | consistent | met | Generate MCP registration and bindings |
| P03-05 | HIGH | BROKEN | no | inert | bypassed | not-met | Generate the CLI client |
| P03-06 | MEDIUM | GAP | partial | partial | underused | partial | Extend and consume shared admission IR |
| P03-07 | HIGH | GAP | partial | inert | bypassed | not-met | Emit standard artifacts once |
| P03-08 | MEDIUM | GAP | no | partial | bypassed | partial | Define extension trust |
| P03-09 | HIGH | BROKEN | partial | inert | underused | not-met | Add an independent oracle |
| P04-01 | MEDIUM | GAP | partial | partial | underused | partial | Effect algebra and observable delivery |
| P04-02 | LOW | OK | yes | yes | consistent | met | Cancellation process manager |
| P04-03 | MEDIUM | GAP | no | inert | underused | partial | Artifact-store containment |
| P04-04 | HIGH | GAP | partial | partial | underused | partial | Atomic configuration and installation |
| P04-05 | HIGH | GAP | partial | partial | bypassed | partial | VCS and worktree ownership |
| P04-06 | LOW | OK | yes | yes | consistent | met | Rehydration under degradation |
| P05-01 | HIGH | BROKEN | no | inert | bypassed | not-met | Reproducible source-linked artifacts |
| P05-02 | MEDIUM | GAP | yes | yes | consistent | partial | Packaged action and CLI proof |
| P05-03 | HIGH | GAP | partial | partial | underused | not-met | Generated projection containment |
| P05-04 | LOW | OK | yes | yes | consistent | met | Install and cache freshness |
| P05-05 | LOW | OK | yes | yes | consistent | partial | Generated reachability graph |
| P06-01 | MEDIUM | GAP | partial | yes | consistent | partial | Characterize and classify legacy behavior |
| P06-02 | LOW | GAP | yes | yes | underused | met | Closed edge-condition evaluator |
| P06-03 | HIGH | BROKEN | no | inert | bypassed | not-met | Monotonic requirement resolution |
| P06-04 | MEDIUM | GAP | partial | partial | underused | partial | Policy and waiver evaluation |
| P06-05 | HIGH | BROKEN | no | inert | bypassed | not-met | Atomic transition and cleanup |
| P06-06 | HIGH | GAP | no | inert | bypassed | not-met | Explainable decisions and remediation |
| P06-07 | MEDIUM | GAP | no | inert | bypassed | partial | Reassessment and bootstrap |
| P07-01 | HIGH | GAP | partial | partial | underused | partial | Shadow decisions and cutover gate |
| P07-02 | MEDIUM | GAP | partial | yes | consistent | partial | Migrate built-in workflows |
| P07-03 | LOW | OK | no | yes | underused | met | Builder lowering and decision parity |
| P07-04 | MEDIUM | GAP | partial | partial | underused | partial | Import, CTK, replay, performance |
| P07-05 | MEDIUM | GAP | partial | yes | underused | partial | Remove legacy and manual authorities |
| P07-06 | MEDIUM | GAP | yes | yes | underused | partial | Strengthen module boundaries |
| P07-07 | HIGH | GAP | partial | partial | underused | not-met | Promote and retire ratchets |
