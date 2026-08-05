# Spec: Wiring Closure and the Unified Integration Suite

**Date:** 2026-08-04 · **Feature:** `refactor-wiring-closure` · **Depth:** standard
**Inputs:** `docs/audits/2026-08-04-wiring-audit.md` (the seven-program package-by-package wiring audit this spec responds to), `docs/audits/structural-closure-delta-audit/unified-remediation-plan.md` (the 48-package program), `docs/system-design.html`, `.exarchos/invariants.md`.

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Design & Rationale

### Problem Statement

The 48-package structural-closure program built the right machinery. A package-by-package audit of all 48 against **their own acceptance criteria** found that the machinery is disproportionately unreached by production: modules are present, well-typed, and well unit-tested, while the shipped path either does not call them or calls something else.

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

Supporting measurement: of 841 MCP test files, **109 (13%)** drive real composition — P01 24%, P02 14%, P03 5%, P04 **0%**, P06 **0% from the public root**. That coverage shape is *why* a 10,491-test green suite coexisted with every defect below.

### Chosen Approach

The 40 non-OK packages are not 40 unrelated bugs. They are **seven recurring shapes**, and fixing the shapes is the point — fixing instances one at a time regenerates them.

- **Class A — Present, not wired.** A complete, well-tested module with zero production call sites. The release manifest is never produced, signed, published, or consumed, and its verifier is not in `files[]`. The requirement-freeze machinery is built and unwired. `selectEdge`'s only caller is `RESERVED`. The waiver model is unreachable by construction.
- **Class B — Self-referential proof.** Both sides of a comparison derive from one source read, so it can never disagree. Projection containment builds the required inventory *and* the "packaged layer" from the same `contents` map. The contract drift guard's baseline and checker are both pure functions of the same registry. The oracle's seeded breaks have declaration, handler and detector co-authored in one file.
- **Class C — Orphaned reader.** A consumer gates on a signal no producer emits. `task_complete` blocks on `gate.executed`/`static-analysis`, which every migrated durable-runner producer stopped emitting. The cutover gate reads live records nothing durable produces.
- **Class D — Indeterminate laundered into pass.** The resolved `riskTier` is frozen at `prepare_delegation` and never delivered to the gate. A degraded projection is served as `success: true` with a stale payload. The oracle's effect axis converts absent observation into positive assurance.
- **Class E — Detector scoped below the real surface.** The VCS census matches three argv shapes and explicitly scopes out merge/commit/branch-create. The effect ledger keys off exact import specifiers. The shim ratchet is marker-driven. The advisory registry excludes workflow-level `continue-on-error`.
- **Class F — Two authorities for one boundary.** Three modules mutate phase. `next_actions` enumerates raw topology without evaluating a guard. The hand-written registry is authoritative while the "compiler" describes it.
- **Class G — The governed supplies its own governance.** `task_complete`'s `evidenceBypass` accepts `evidence.passed === true` from the agent being governed. `cleanup.ts` force-writes `reviews[*].status = 'approved'` immediately before the guard reads it.

The work is sequenced in **five dependency-ordered waves**. **W1 gates everything**: until the false-green paths close, every verification result — including this refactor's own — is unreliable evidence. W2–W5 are mutually parallel and all depend on W1. The integration suite is built alongside the wave that needs it.

### Audit corrections and refutations

Recorded because an audit that only accumulates findings is not trustworthy.

- **RETRACTED (the orchestrator's own prior HIGH).** A `check_test_adequacy` vacuous-pass finding was produced against the *installed* binary (`~/.exarchos/bin/exarchos.exe`, built 2026-07-20 19:37), which predates all 178 branch commits. Current source returns the correct blocking verdict. The real defect split out as the toolchain-glob replacement bug, since fixed. Lesson encoded as a suite invariant: evidence must be bound to the subject under review.
- **REFUTED.** The P01 audit's headline claim — `createCliDispatchContext` has zero production call sites, so every CLI gate returns `TRUSTED_CALLER_REQUIRED` — is false. It is the first statement of `buildCli()` (`adapters/cli.ts:317`). Not carried into any DR-N.
- **PARTIALLY REFUTED.** The merge path is *not* unledgered: it commits a durable `merge.requested` intent with deterministic idempotency keys and uses `git reset --keep`. What stands, and is carried as DR-12, is that it does not route through `VcsMutationOwner` and the census cannot see it.
- **CONFIRMED by direct inspection.** `makeArtifactGuard` (`guards.ts:54`) evaluates `artifacts[field] != null` → DR-5. `evaluateCutoverGate` has zero production callers and `liveShadowSink` is a process-scoped in-memory ring buffer → DR-23. Three modules call `executeTransition` → DR-7.

### Requirements (DR-N)

The DR-N identifiers below are the single source the decomposition traces against.

#### DR-1: task_complete gates on an event a producer actually emits

`task_complete` requires `hasPassingGate('static-analysis')` over `gate.executed`, but migrated durable-runner producers append `admission.evidence-recorded` instead. One producer must own the signal.

**Acceptance criteria:**
- `check_static_analysis` then `task_complete` through `dispatch()` with no hand-seeded event and no `evidence` field succeeds
- The negative twin (static analysis red) returns a blocking error
- No runbook places a blocking gate after `task_complete`

#### DR-2: the governed cannot supply its own governance

`evidenceBypass` accepts `args.evidence.passed === true` from the agent being governed and disables all gate enforcement at once.

**Acceptance criteria:**
- A caller-supplied `evidence` object cannot satisfy a BLOCKING gate
- If retained for non-blocking gates, it requires an explicit operator capability

#### DR-3: the frozen riskTier reaches the gate that consumes it

`riskTier`/`boundaryTouching` are resolved and frozen at `prepare_delegation` but are neither params nor templateVars on `TASK_COMPLETION`/`TASK_FIX`, so every dispatch reaches `interpretProbeVerdict` with an undefined tier.

**Acceptance criteria:**
- A HIGH-tier task adding no probe-able tests returns `passed:false`
- A LOW-tier task returns `passed:true, skipped:true`
- A runbook-shape assertion pins `riskTier` + `boundaryTouching` as params and templateVars on both runbooks

#### DR-4: a degraded projection is never served as success

`_meta.projectionDegraded` is an ephemeral per-response annotation on one composite, recomputed from an in-memory LRU, persisted nowhere and consumed by nobody.

**Acceptance criteria:**
- One durable degraded state is published (event or projection)
- Fault injection makes **every** readiness/workflow/reliability consumer return a typed degraded result, not `success:true` with a stale payload

#### DR-5: a bare boolean cannot satisfy a requirement

`makeArtifactGuard` evaluates `artifacts[field] != null`, so `{"artifacts":{"plan":true}}` satisfies a phase gate on the feature and refactor tracks.

**Acceptance criteria:**
- A bare boolean or whitespace-only value is rejected on every track
- The admission algebra's schema-level rejection is enforced on the shipped transition path

#### DR-6: a skipped constituent check cannot render as PASS

`check_static_analysis` reports `PASS (2/2)` while lint and quality-check are skipped for absence of a script.

**Acceptance criteria:**
- A `lint` script exists and runs
- A skipped constituent renders the dimension DEGRADED/INDETERMINATE, never PASS
- Indeterminate blocks protected promotion exactly as fail does

#### DR-7: exactly one action mutates a phase (INV-9)

Three modules mutate phase: the guarded path, plus `cancel.ts:367` and `cleanup.ts:303` calling `executeTransition` directly. Neither bypass is shadow-observed. `runCleanupCommand` exists to close this and is dead code.

**Acceptance criteria:**
- `cleanup` and `cancel` route through the single guarded primitive
- All phase mutations are shadow-observed
- No partial event trail survives a mid-transition failure

#### DR-8: no production path force-writes the fields a guard reads

`cleanup.ts` force-assigns `reviews[*].status = 'approved'` (including nested entries) and `_cleanup.mergeVerified = true` immediately before evaluating the guard that reads them — the `pass-state-fix` class `retirement-safety.ts` already names as awaiting retirement.

**Acceptance criteria:**
- Cleanup satisfies its guard by evidence, not by rewriting guard inputs
- A test asserts no production path writes review status or `mergeVerified` before the guard reads them

#### DR-9: next_actions derives from the admission verdict (INV-12)

`next-actions-computer.ts` enumerates `hsm.transitions.filter(t => t.from === phase)` and emits one verb per outbound edge using `t.guard.description`, never evaluating a guard or consulting the admission IR — so the runtime advertises moves admission will deny.

**Acceptance criteria:**
- A transition admission would deny is not advertised as an affordance
- A consistency test fails when the two authorities disagree

#### DR-10: requirement resolution is monotonic and frozen

`tools.ts` collapses an absent/malformed tier to `low`, hardcodes `boundaryTouching: false`, and re-resolves the tier on every attempt from post-update `mutableState`.

**Acceptance criteria:**
- Unknown risk never becomes `low`; `boundaryTouching` fails safe
- A tier set in the same call cannot weaken the transition being evaluated
- The frozen set recorded on `phase.entered` is read back as authority for later attempts

#### DR-11: the contract compiler is the authority, not a description of the registry

The hand-written `registry.ts` is authoritative; `meta-model.ts` derives *from* `TOOL_REGISTRY`; no `compile()` descriptor is consumed by the running server. So every declaration-to-declaration guard is structurally blind to a wrong meta-model.

**Taxonomy note.** The audit assigned this defect to both Class B (baseline and checker are pure functions of one registry) and Class F (two authorities for one boundary). Those prescribe *opposite* fixes: Class F says collapse to one authority, and collapsing onto the registry makes the Class B defect permanent. **Class B governs here** — the defect to remove is the single-source comparison, so the resolution must introduce an authority independent of `TOOL_REGISTRY`, not merely pick a winner.

**Acceptance criteria:**
- The server consumes compiler descriptors, so a meta-model authored wrongly produces an observably wrong runtime surface
- A wrong meta-model (not merely a stale or hand-edited baseline) is detected

**If the inversion is deferred** (see Open Questions), the deferral is bounded rather than silent:
- Criterion 2 is recorded as **not met**, not restated as satisfied — under the fallback there is no independently-authored meta-model that *can* be wrong, so nothing can seed the test
- The drift guard is registered in the advisory registry (DR-15) as a **known Class B exception** with an owner and an expiry, and is therefore visible to DR-30's ratchet rather than exempt from it
- `T-16`'s named test is retired rather than written to pass vacuously against a self-derived baseline

#### DR-12: the VCS census sees every mutation it claims to own

`architecture/vcs-ownership.ts` matches only `worktree add|remove` and `branch -d|-D` as adjacent literals and explicitly scopes out merge/commit/branch-create, so `local-git-merge.ts` is invisible by design.

**Acceptance criteria:**
- A planted `['merge','--no-ff',x]` outside the owner turns the census RED (it passes today)
- Duplicate merge and duplicate PR are prevented through the shipped path

#### DR-13: effect detection is not evadable by import shape

Detection keys off exact specifiers plus a bare `fetch(` regex, so `node:http2`, axios/got/ws/node-fetch, injected clients and aliased globals are invisible.

**Acceptance criteria:**
- A seeded non-listed HTTP client trips the ledger
- Re-export/alias of an effect primitive is detected, or the trust boundary is documented explicitly

#### DR-14: shim discovery enumerates the real surface

Five per-harness renderers exist and are ungoverned while the ratchet's whole inventory is two rows for a self-declared dead stub; discovery is marker-driven so governed and real counts are decoupled.

**Acceptance criteria:**
- Adding a per-harness renderer without an approved capability reason and expiry FAILS the ratchet
- The inventory reflects the shipped renderers

#### DR-15: every advisory is registered and its promotion threshold is reachable

One of three advisories the repo's own manifest identifies is outside the registry; the unfiltered-CI-path claim is free text checked only for filename shape; `lint-inv6`'s bare-verb literals make its zero-findings threshold unreachable.

**Acceptance criteria:**
- Every `continue-on-error` / `--observe` / `|| true` in the repo is registered with owner, threshold, expiry and kill fixture
- The unfiltered-CI-path check models path filters
- `lint-inv6` literals are narrowed so its threshold is attainable

#### DR-16: atomic promotion is durably ordered

No parent-directory fsync exists anywhere in `utils/atomic-write.ts` or `install/atomic-promotion.ts`, so journal-before-backup ordering is accidental rather than constructed.

**Acceptance criteria:**
- The parent directory is fsync'd after the journal rename and after each tree rename
- A real-kill (SIGKILL) between the two renames converges to old-complete or new-complete

#### DR-17: a backup is never destroyed without a consumable journal

`atomic-promotion.ts:419-420` runs `safeRemove(plan.backupDir)` unconditionally when `readJournal` finds no journal, before staging — destroying the only surviving OLD tree (INV-14 violation).

**Acceptance criteria:**
- `{target absent, backup = OLD tree, journal deleted}` does not destroy the backup (fails today)
- Recovery refuses to discard rather than overwriting destructively

#### DR-18: the spec-named config writers get the same promotion guarantees

`~/.claude.json`, `.vscode/mcp.json` and `.cursor/mcp.json` are written with fixed tmp names, no fsync, no journal, no backup and no recovery; only the skills tree got stage/verify/promote.

**Acceptance criteria:**
- An injected failure leaves old-complete or new-complete for CLI/MCP config
- `recoverInterruptedPromotion` has a startup/doctor entry point

#### DR-19: EFF-001 closes or INV-7 stays honestly marked

No real multi-process fixture exists; the subprocess driver was deleted (#1324) and never replaced, so the cross-connection `BEGIN IMMEDIATE` / `SQLITE_BUSY` path is untested.

**Acceptance criteria:**
- N≥3 real child processes appending to one stream produce dense unique sequences and a consistent high-water mark
- A restart-repair arm proves gate/tail divergence is repaired
- If unmet, no code or doc asserts the guarantee categorically

#### DR-20: the release manifest is produced, signed, published and consumed

The manifest is a well-built library with zero call sites; installers verify only an unsigned sidecar hash; the verifier is not in `files[]`; no source/contract identity is embedded.

**Acceptance criteria:**
- The installer rejects source, contract, manifest and asset mismatch — not merely a corrupted download
- Source and contract identity are embedded in the built artifact

#### DR-21: projection containment is proven against packaged bytes

The headline proof derives the required inventory and the packaged layer from the same `contents` map, so deleting a real agent, alias or hook shrinks both sides together and the proof still passes.

**Acceptance criteria:**
- `npm pack` → unpack → build the packaged layer from **those bytes** → verify digests
- Seeded fixtures deleting one file and rewriting another both FAIL

#### DR-22: projection roots cannot change unobserved in CI

`changes.root` omits `agents/**`, `command-aliases/**`, `hooks/**`, `.claude-plugin/**` and `AGENTS.md`; no `hooks:guard` step exists in any job.

**Acceptance criteria:**
- A PR that only deletes an agent, alias or hook cannot pass green
- `hooks:guard` runs in CI; drift guards exist for `command-aliases/` and `agents/`

#### DR-23: shadow evidence is durable and its absence is detectable

`liveShadowSink` is a process-scoped in-memory ring buffer emitting no events (an INV-1 violation); `evaluateCutoverGate` has zero production callers; the gate's live conditions read only `legacyOutcome`, so 20 attempts that all threw would satisfy three of four conditions.

**Acceptance criteria:**
- The registered `admission.shadow-attempt` / `admission.disagreement-disposition` events are emitted from production
- A gate condition reads live disagreement class
- A dead observer is DETECTED (health counter), not silently zero

#### DR-24: the oracle observes real handler behavior

Against ~120 real actions the oracle uses canned envelopes with `requiredRoles: []` and `declaredEffects: []`, so its authorization/effect/compatibility axes are vacuous on the shipped system.

**Acceptance criteria:**
- Real handlers are invoked with roles/effects populated from the registry
- Absent observation reports `not-observed`, never `pass`
- A real handler skipping authorization is caught

#### DR-25: the CLI/MCP relationship matches the governing INV-2

`adapters/cli.ts:7` imports `dispatch` directly; `cli-surface.json` is read only by drift guards; agreement is asserted by a harness over a mocked handler. The governing framing is that the CLI is a generated client, equal by construction.

**Acceptance criteria:**
- Either the CLI is generated from the contract, or the direct path is recorded as an accepted deviation with an owner and expiry
- No unacknowledged violation of the governing INV-2 remains

#### DR-26: the invariant catalog pins the governing contract

`.exarchos/invariants.md` is pinned by `authority-pin.ts` and digested into the freeze, so the stale INV-2/INV-4 framings are load-bearing inputs to generation. INV-7 is a target, not a closed claim; INV-11 excludes spatial write confinement.

**Acceptance criteria:**
- INV-2, INV-4, INV-7 and INV-11 are re-approved through `authority-lock-cli.ts`
- The four stale in-code citations of the retired INV-2 parity framing are re-pointed

#### DR-27: a public-root integration tier exists (T1)

Every composite action driven through `dispatch()` with a real event store and state dir; no mocked handler, no synthesized dispatch context.

**Acceptance criteria:**
- Coverage over the same 120-action denominator the packaged sweep uses, ratcheted
- Envelope conformance asserted per action

#### DR-28: a governance-path integration tier exists (T2)

The chains that enforce policy — gate → durable evidence → admission → transition — each driven from the public root, asserting a **blocking** outcome and its negative twin.

**Acceptance criteria:**
- Each DR-1..DR-10 acceptance criterion has a T2 test driven from the public root
- A denied transition does not mutate phase

#### DR-29: a process/crash integration tier exists (T3)

Real child processes: multi-process append, SIGKILL between renames, restart repair, concurrent worktree/merge idempotency. In-process `throw` injection does not qualify — it always runs the `catch`.

**Acceptance criteria:**
- Every T3 test uses real subprocesses
- The build race in `test/process` (two files both invoking `ensureBinaryBuilt`) is serialized

#### DR-30: suite invariants are mechanically enforced

The suite must not reproduce the defect classes it exists to catch. The plan's own review found this requirement was originally scoped to `test/integration/**` — while every Class B instance it must prevent lives in the ~841 existing `src/**/*.test.ts` files (projection containment, the contract drift guard, the oracle fixtures). A guard scoped below the surface it governs is Class E, applied to our own guard.

**Scan root:** every `*.test.ts` under `servers/exarchos-mcp/src/`, `servers/exarchos-mcp/test/`, and root `src/` — not just the new tiers. The denominator is reported and ratcheted.

**Mechanical definition (so the check is decidable):** general inter-procedural dataflow is undecidable, so the property is made checkable by *declaration* rather than inference. A test that asserts containment, drift, parity, census closure, or coverage MUST declare its authorities:

```ts
// @oracle-sources: <authority-a>, <authority-b>
```

The meta-test fails when such a test declares fewer than two **distinct** authorities, or when a declared authority is derived from another declared authority in the same module graph. Tests that assert no such property are out of scope and need no annotation; the annotation requirement is enforced by matching assertion shapes, and the list of covered shapes is itself ratcheted so it cannot quietly shrink.

**Acceptance criteria:**
- The meta-test's scan root covers all three test roots above and reports its denominator
- A test declaring one authority, or two authorities where one derives from the other, FAILS
- Removing an `@oracle-sources` annotation from an in-scope test FAILS (annotation cannot be dropped to evade)
- Every blocking claim declares the seam its kill fixture kills
- No test asserts `passed === true` where the verdict was "could not run"
- Accepted coverage gaps carry an owner and expiry
- The known Class B instances (projection containment, contract drift, oracle fixtures) are either fixed by DR-21/DR-11/DR-24 or carry a registered, expiring exception — they are not silently exempt

#### DR-31: retire the devCatalog boolean; this repo consumes its catalog exactly as a consumer does

`.exarchos.yml` carries **both** `invariants.devCatalog: enabled` (back-compat sugar) and the canonical explicit registration `catalogs: [{ path: .exarchos/invariants.md, tier: dev }]`. The sugar survives because **four** call sites still depend on the boolean (verified by inspection):

1. `architecture/invariants-loader.ts:460` — hard-gates on `effectiveConfig.invariants?.devCatalog !== 'enabled'`
2. `architecture/catalog-sources.ts:70` — `resolveCatalogSources` itself branches on `invariants?.devCatalog === 'enabled'` to perform the desugaring and path-dedupe
3. `architecture/resolve-effective-catalog.ts:109` — synthesizes `USER_CATALOG_LOAD_CONFIG = { invariants: { devCatalog: 'enabled' } }` to unconditionally satisfy the loader gate for every registered source
4. `architecture/vocabulary-lint.ts` — honours the flag **indirectly**, by delegating to `loadInvariants`/`loadInvariantIds` (it does not read the boolean itself)

Site 2 is load-bearing for the wording of this requirement: `resolveCatalogSources` *is* a direct reader, so "route callers through `resolveCatalogSources`" is not by itself sufficient — the desugaring branch inside it must go too. Site 3 means the effective-catalog path already bypasses the gate unconditionally, so it is not evidence that the boolean gates that path.

The result is a bespoke, repo-only loading mode alongside the consumer-shaped `catalogs:` surface — two configuration authorities for one concern, which is Class F applied to our own config.

Retiring it means this repository consumes its own invariants exactly the way any downstream consumer does: a local `.exarchos.yml` pointing at a local `invariants.md`, discovered through `resolveCatalogSources`, with `tier: dev` carrying the audience scoping the boolean used to carry.

**Acceptance criteria:**
- All four sites above stop depending on the boolean: the loader gate is removed, the desugaring branch in `catalog-sources.ts` is removed, and `resolve-effective-catalog.ts` stops synthesizing a config to defeat a gate that no longer exists
- `devCatalog` is removed from `.exarchos.yml`; the effective catalog resolved from the **real repo config** before and after removal is identical (see T-41 for why the existing characterization is not a sufficient oracle)
- `devCatalog` is removed from the config schema, or retained strictly as a deprecated alias that emits a typed deprecation and desugars to a `catalogs:` entry
- Gating is expressed as *"is a catalog registered for this tier?"*, never as *"is the boolean enabled?"*
- No repo-only loading mode remains that a consumer could not reproduce with their own `.exarchos.yml`

#### DR-32: system-design.html reflects the resolved invariant set

The canonical architecture page states INV-2 with the retired parity-harness framing, presents INV-7's two-tier serialization narrative alongside a target caveat, and carries a reference tail whose "what's real today" table predates this audit.

**Acceptance criteria:**
- INV-2, INV-4, INV-7 and INV-11 read in their governing form, consistent with `.exarchos/invariants.md` after DR-26
- The `#1608` supersession note is resolved rather than described as pending
- The capability table distinguishes *built* from *built but unreached* where this audit found the difference (release manifest, extension trust, shadow evidence)
- No statement asserts a guarantee this audit found unwired

#### DR-33: skills and guides gate on catalog registration, not on devCatalog

Nine `skills-src` files (rendering to 39 generated skill files) and two guides instruct the reader to gate the design-time Constraints step on `.exarchos.yml: invariants.devCatalog: enabled`. That instruction becomes wrong the moment DR-31 lands, and the generated tree drifts if only the source is edited.

**Acceptance criteria:**
- `skills-src/{ideate,refactor,debug,shepherd}` and `references/constraint-anchoring.md` express the gate as catalog registration/presence
- `npm run build:skills` regenerates `skills/` and `command-aliases/`; `npm run skills:guard` passes with no drift
- `docs/guides/{authoring-invariants,exarchos-yml-invariants}.md` describe the consumer-shaped configuration only
- No instruction anywhere tells a reader to set a flag that no longer exists

#### DR-34: the route selector's ambiguity and indeterminate rules are live

`edge-condition-select.ts` `selectEdge` implements the three deterministic route outcomes — `selected` with `multiMatch: true` when more than one candidate is true, `no-match`, and `blocked` (fail-closed when the highest-priority non-false candidate is `indeterminate`). Its only caller is `runTransitionCommand`, which is `RESERVED` with zero production importers. The live path calls the per-edge primitive directly on ONE edge, so ambiguous-topology detection and the indeterminate-blocks-fallthrough rule are inert. This is a Class A instance the Chosen Approach uses to *define* the class; it must not be dropped silently.

**Acceptance criteria:**
- A workflow with two simultaneously-true outbound conditions is detected as `multiMatch` on the live path, not silently resolved
- An `indeterminate` highest-priority candidate blocks rather than falling through
- If activation is deferred, DR-34 is recorded in `## Scope / Excluded` with an owner and a tracking issue — not omitted

#### DR-35: evidence provenance is evaluated, not minted

`legacy-state-translation.ts` mints its own evidence from the same fact projection it judges: `createdAt` is stamped `ctx.evaluatedAt` (so `isStale` can never fire), the producer is granted `ISSUE_GATE_EVIDENCE`/`ISSUE_APPROVAL` (so `unauthorized` can never fire), and `subjectFor` matches the requirement exactly (so `malformed` can never fire). No contradictions and no waivers are passed, and `obligations.waivable === false`, so the entire waiver branch is dead. Five of six deny reasons and the whole waiver model are unreachable **by construction** — the second Class A instance the Chosen Approach names.

**Acceptance criteria:**
- Stale, contradictory, malformed and unauthorized evidence each DENY on a path driven from the public root
- The waiver branch is reachable: a scoped, expiring waiver applies to its declared subject and requirement and to nothing else
- `selectEvidence` (contradiction detection / active-evidence selection) is called on the wired admission path
- If any of these stays deferred, it is recorded in `## Scope / Excluded` with an owner — not omitted

#### DR-36: new durable appends satisfy INV-8/INV-13

DR-23 (T-31/T-32) introduces **new production appends** — `admission.shadow-attempt` and `admission.disagreement-disposition` — into an event-sourced store whose INV-8 requires an idempotency key on every append and whose catalog enforcement is `mode: audit`, i.e. reviewer judgment with **no mechanical backstop**. The audit separately found that the one shipped typed admission writer appends with no `idempotencyKey` despite `dispositionId` being a natural claim key, so retries duplicate rather than returning the stored result or a typed conflict. Adding appends on an audit-only invariant without an assigned check is how INV-8 erodes.

**Acceptance criteria:**
- Every new admission append carries an idempotency key derived from a natural identity (`dispositionId`, attempt identity), not a random value
- A replayed append returns the canonical stored result or a typed conflict — never a duplicate row
- INV-13's intent-before / result-after split holds for any non-idempotent effect these events describe
- A test covers the retry path for each new event type; this obligation is not left to `mode: audit` judgment

## Technical Design

### Seams touched

`workflow/{tools,cleanup,cancel,guards,hsm-transition-guard}.ts` and `workflow/admission/**` (DR-3..DR-10, DR-23); `orchestrate/{gate-runner,task tools,runbooks/definitions,static-analysis}` (DR-1..DR-3, DR-6); `contract/**` (DR-11, DR-24, DR-25); `architecture/**` censuses (DR-12, DR-13); `vcs`/`install`/`utils` (DR-12, DR-16..DR-18); `event-store`/`projections` (DR-4, DR-19); `release/**` + installer scripts (DR-20); `src/{advisory-registry,shim-registry,projection-containment}.ts` (DR-14, DR-15, DR-21); `.github/workflows/**` (DR-15, DR-22); `.exarchos/invariants.md` (DR-26).

### Invariants preserved

INV-1 (the shadow sink stops being an in-memory side database), INV-8/INV-13 (idempotency keys on disposition writes), INV-9 (one phase-mutation path), INV-12 (`next_actions` from the deciding authority), INV-15 (compensation stays local rewind; no primitive from outside the single-machine frame is imported).

### Shape of the new code

Two kinds of change dominate: (a) *connect* — give an existing, tested module its production call site (DR-4, DR-20, DR-23); (b) *widen* — extend a detector's subject so it can see the surface it claims (DR-12, DR-13, DR-14, DR-15). Only DR-11 and DR-25 are genuinely directional decisions that may end in a documented deviation rather than code.

### Integration suite layout

The suite lives at `servers/exarchos-mcp/test/integration/{public-root,governance}/`, extends `test/process/`, and adds `test/packaged/`. Kept outside `src/` so it is not unit-test-adjacent and does not inherit the `bun:sqlite` alias. Tier is determined by how far down the production path a test enters, not by which module it exercises.

### Integration Points

- `servers/exarchos-mcp/src/tasks/tools.ts` — the gate precondition and the evidence bypass (DR-1, DR-2)
- `servers/exarchos-mcp/src/runbooks/definitions.ts` — tier delivery on `TASK_COMPLETION`/`TASK_FIX` (DR-3)
- `servers/exarchos-mcp/src/workflow/{cleanup,cancel}.ts` — route through the guarded primitive (DR-7, DR-8)
- `servers/exarchos-mcp/src/next-actions-computer.ts` — derive from the admission verdict (DR-9)
- `servers/exarchos-mcp/src/utils/atomic-write.ts` — directory fsync (DR-16, DR-18)
- `servers/exarchos-mcp/src/workflow/admission/live-shadow-observer.ts` — durable emission + health counter (DR-23)
- `scripts/get-exarchos.{sh,ps1}` — manifest verification call sites (DR-20)

### Alternatives considered

- **Fix by severity rather than by wave.** Rejected: the 16 HIGHs span all five waves, and several are only *observable* once W1 lands. Severity ordering would verify fixes against known-false green signals.
- **Rewrite the weak subsystems.** Rejected: the audit found the modules sound in isolation. The defect is at the seams; rewriting would discard working code and regenerate the same wiring gaps.
- **Suite-first, fixes second.** Rejected for W1/W2: several new tests cannot be written honestly until the signal they assert on exists (DR-1's producer, DR-23's durable events). Retained for W4/W5 where the seam already exists.
- **Per-wave stacked PRs.** Considered and declined by the operator: single PR onto `feature/structural-closure-remediation`.

### Open Questions

- **DR-11 direction.** Inverting compiler-vs-registry authority may exceed this refactor. Resolution: attempt inversion; if the blast radius exceeds the wave, downgrade to documenting the direction plus stating the drift guard's limits, and track the inversion separately.
- **DR-25 CLI generation.** Generating the CLI is a substantial subprogram. Resolution: decide at W5 with measured effort; the fallback (recorded, expiring deviation) is explicitly acceptable.
- **DR-19 EFF-001 feasibility on Windows.** The prior driver was deleted because `bun:sqlite`'s URL scheme broke under Node. Resolution: if a cross-runtime subprocess driver is not achievable in this wave, INV-7 stays a documented target and DR-19 downgrades to the honesty clause only.

## Traceability

Design sections that are narrative rather than implementable are recorded as deferred here. The implementable surface is DR-1..DR-33, traced in the decomposition matrix below and verified by `check_provenance_chain` (33/33).

| Design Section | Task(s) | Status |
|----------------|---------|--------|
| Seams touched | — | Deferred — narrative index of the seams DR-1..DR-33 touch; each seam is implemented through its owning DR, not separately |
| Invariants preserved | — | Deferred — names the INV-* this change must not break. Each is assigned: INV-1 → DR-23, INV-9 → DR-7, INV-12 → DR-9, INV-8/INV-13 → **DR-36**, INV-7 → DR-19. INV-15 is a design constraint (import no primitive from outside the single-machine frame), checked at review rather than by a task. This section is a routing index, not unassigned work |
| Integration Points | — | Deferred — a pointer list into the seams above; every entry is covered by the DR-N that owns it |
| Alternatives considered | — | Deferred — rationale record for rejected approaches; nothing to implement |

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.

### Scope

**Target:** Full — all 33 DR-N across five waves plus the four suite tiers.
**Excluded:** Rewriting the 48 structural-closure packages; flipping the cutover gate; spatial write confinement; byte-reproducible binaries; retiring legacy guards (P07-05 stays deferred until its replacement gates CI).

**Bounded deferrals under DR-35 (T-48).** Every DR-35 acceptance criterion is met
mechanically — all four provenance deny reasons fire from the public root,
`selectEvidence` runs on the wired admission path, `obligations.waivable` is
`true` for gate obligations, and a scoped waiver applies to its declared subject
and requirement and to nothing else. Two consequences of that design are
deliberately *not* activated in this change and are recorded here rather than
left implicit:

- **No production producer yet files evidence under the translation's
  requirement ids.** `edgeAdmissionScope(edge)` publishes the
  `req:{gate,approval}:<id>:<workflowType>:<from>:<to>` identity and its
  phase-attempt subject, but `orchestrate/gate-runner.ts` still records under
  its own ids (`requirement:plan-coverage`, `verification-ladder:<gateClass>`).
  Until a producer adopts the published scope, the recorded ledger is empty on
  shipped workflows and every requirement falls back to the derived
  attestation — i.e. observable behavior is unchanged today. *Owner: admission
  runtime (DR-35 follow-up); tracked with DR-1's gate→task seam work.*
- **Waiver-grant trust is declared out-of-band and is empty on the live path.**
  `SHARED_TRANSLATION_AUTHORITY = createTranslationAuthority()` names no
  `waiverGrantors`, so no waiver can apply through `recordLiveTransition` until
  a deployment declares one. This is fail-closed by construction, not an
  oversight: granting waiver authority is a trust decision, and self-asserted
  grantors are exactly what P01-07 exists to reject. *Owner: admission runtime
  (DR-35 follow-up), jointly with whoever owns capability resolution.*
**Sequential phases:** the five waves are the plan's sequential phases (the playbook escalates plans over 20 tasks into phases; W1 gates W2–W5, which are mutually parallel).

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | task_complete gates on a real event | T-01, T-02 |
| DR-2 | governed cannot supply governance | T-03 |
| DR-3 | frozen riskTier reaches the gate | T-04, T-05 |
| DR-4 | degraded never served as success | T-06, T-07 |
| DR-5 | bare boolean cannot satisfy | T-08 |
| DR-6 | skipped cannot render as PASS | T-09 |
| DR-7 | one phase-mutation path | T-10, T-11 |
| DR-8 | no force-write of guard inputs | T-12 |
| DR-9 | next_actions from admission | T-13 |
| DR-10 | monotonic frozen resolution | T-14, T-15 |
| DR-11 | compiler authority direction | T-16 |
| DR-12 | VCS census sees merges | T-17, T-18 |
| DR-13 | effect detection not evadable | T-19 |
| DR-14 | shim discovery enumerates real surface | T-20 |
| DR-15 | advisories registered, thresholds reachable | T-21, T-22 |
| DR-16 | atomic promotion durably ordered | T-23 |
| DR-17 | backup never destroyed | T-24 |
| DR-18 | config writers promoted | T-25 |
| DR-19 | EFF-001 or honest marking | T-26 |
| DR-20 | release manifest end to end | T-27, T-28 |
| DR-21 | containment on packaged bytes | T-29 |
| DR-22 | projection roots observed in CI | T-30 |
| DR-23 | shadow evidence durable + detectable | T-31, T-32 |
| DR-24 | oracle observes real handlers | T-33 |
| DR-25 | CLI/MCP per governing INV-2 | T-34 |
| DR-26 | catalog pins governing contract | T-35 |
| DR-27 | T1 public-root tier | T-36 |
| DR-28 | T2 governance tier | T-37 |
| DR-29 | T3 process tier | T-38, T-39 |
| DR-30 | suite invariants enforced | T-40 |
| DR-31 | retire devCatalog; consumer-shaped config | T-41, T-42, T-43 |
| DR-32 | system-design reflects resolved invariants | T-44 |
| DR-33 | skills/guides gate on registration | T-45, T-46 |
| DR-34 | route selector live (multiMatch/indeterminate) | T-47 |
| DR-35 | evidence provenance + waivers reachable | T-48 |
| DR-36 | new admission appends carry idempotency keys | T-49 |

### Tasks

### Task T-01: Unify the gate-executed signal producer

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1
**Files:**
- `servers/exarchos-mcp/src/orchestrate/gate-runner.ts`
- `servers/exarchos-mcp/src/tasks/tools.ts`
- `servers/exarchos-mcp/src/orchestrate/gate-runner.test.ts`
**Tests:** `TaskComplete_StaticAnalysisPassed_SucceedsWithoutSeededEvent`, `TaskComplete_StaticAnalysisRed_ReturnsGateNotPassed`
**Verification:** high — scoped tests + `check_test_adequacy` + T2 integration across the gate→task seam. Characterization required (existing behavior changes).
**Dependencies:** None
**Parallelizable:** No (W1 head)

### Task T-02: Assert runbook ordering mechanically

**Risk Tier:** medium
**Test Layer:** integration
**Acceptance Test Ref:** T-01
**Implements:** DR-1
**Files:**
- `servers/exarchos-mcp/src/runbooks/definitions.ts`
- `servers/exarchos-mcp/src/runbooks/ordering.test.ts`
**Verification:** medium — scoped tests + kill-probe. Assert no runbook places a blocking gate after `task_complete`.
**Dependencies:** T-01, T-04
**Parallelizable:** No (shares `runbooks/definitions.ts` with T-04)

### Task T-03: Remove or capability-gate the evidence bypass

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2
**Files:**
- `servers/exarchos-mcp/src/tasks/tools.ts`
- `servers/exarchos-mcp/src/tasks/tools.evidence-bypass.test.ts`
**Tests:** `TaskComplete_CallerSuppliedEvidence_CannotSatisfyBlockingGate`, `TaskComplete_EvidenceBypassOnAdvisoryGate_RequiresOperatorCapability`
**Verification:** high — a caller-supplied `evidence` object must not satisfy a BLOCKING gate; kill fixture preserves the current bypass as a regression case.
**Dependencies:** T-01
**Parallelizable:** No

### Task T-04: Thread riskTier + boundaryTouching through the task runbooks

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3
**Files:**
- `servers/exarchos-mcp/src/runbooks/definitions.ts`
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`
- `servers/exarchos-mcp/src/runbooks/definitions.test.ts`
**Tests:** `TaskCompletion_DelegationStamp_DeliversRiskTierToGate`, `TaskFix_DelegationStamp_DeliversBoundaryTouchingToGate`
**Verification:** high — tier taken from the same delegation stamp `prepare_delegation` produced, not a literal.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-05: Pin the runbook parameter shape

**Risk Tier:** medium
**Test Layer:** unit
**Acceptance Test Ref:** T-04
**Implements:** DR-3
**Files:**
- `servers/exarchos-mcp/src/runbooks/definitions.shape.test.ts`
**Verification:** medium — assert `TASK_COMPLETION` and `TASK_FIX` carry both stamps as params and templateVars.
**Dependencies:** T-04
**Parallelizable:** Yes

### Task T-06: Publish one durable projection-degraded state

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-4
**Files:**
- `servers/exarchos-mcp/src/projections/freshness.ts`
- `servers/exarchos-mcp/src/event-store/schemas.ts`
- `servers/exarchos-mcp/src/projections/freshness.test.ts`
**Tests:** `ProjectionFreshness_StaleCursor_PublishesDurableDegradedState`, `ProjectionFreshness_TailMatchesCursor_PublishesNoDegradedState`
**Verification:** high — durable state, not a per-response annotation.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-07: Make every consumer return a typed degraded result

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-4
**Files:**
- `servers/exarchos-mcp/src/views/composite.ts`
- `servers/exarchos-mcp/src/workflow/composite.ts`
- `servers/exarchos-mcp/src/orchestrate/composite.ts`
- `servers/exarchos-mcp/src/views/composite.test.ts`
**Tests:** `ViewComposite_DegradedProjection_ReturnsTypedDegradedResult`, `WorkflowComposite_DegradedProjection_DoesNotReturnStalePayload`
**Verification:** high — fault injection; no consumer returns `success:true` with a stale payload.
**Dependencies:** T-06
**Parallelizable:** No

### Task T-08: Require a typed artifact reference, not a truthy value

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5
**Files:**
- `servers/exarchos-mcp/src/workflow/guards.ts`
- `servers/exarchos-mcp/src/workflow/guards.artifact.test.ts`
**Tests:** `ArtifactGuard_BareBooleanPlan_RejectsRequirement`, `ArtifactGuard_WhitespaceOnlyPlan_RejectsRequirement`
**Verification:** high — `{"artifacts":{"plan":true}}` and `'   '` rejected on every track; characterization required.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-09: Add the lint script and make skipped ≠ pass

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-6
**Files:**
- `package.json`
- `servers/exarchos-mcp/src/orchestrate/static-analysis.ts`
**Verification:** medium — a skipped constituent renders DEGRADED; the aggregate cannot report PASS.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-10: Route cleanup and cancel through the guarded primitive

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-7
**Files:**
- `servers/exarchos-mcp/src/workflow/cleanup.ts`
- `servers/exarchos-mcp/src/workflow/cancel.ts`
- `servers/exarchos-mcp/src/workflow/cleanup.test.ts`
**Tests:** `Cleanup_CompletedTransition_RoutesThroughGuardedPrimitive`, `Cancel_CancelledTransition_IsShadowObserved`
**Verification:** high — exactly one call path mutates phase; all mutations shadow-observed. Characterization required.
**Dependencies:** T-01
**Parallelizable:** No (W2 head)

### Task T-11: Assert single phase-mutation authority structurally

**Risk Tier:** medium
**Test Layer:** unit
**Acceptance Test Ref:** T-10
**Implements:** DR-7
**Files:**
- `servers/exarchos-mcp/src/workflow/phase-mutation-ownership.test.ts`
**Verification:** medium — a planted direct `executeTransition` import outside the guard fails the check.
**Dependencies:** T-10
**Parallelizable:** Yes

### Task T-12: Delete the cleanup pass-state fix

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-8
**Files:**
- `servers/exarchos-mcp/src/workflow/cleanup.ts`
- `servers/exarchos-mcp/src/workflow/cleanup.pass-state.test.ts`
**Tests:** `Cleanup_UnapprovedReviews_DoesNotForceApprove`, `Cleanup_MergeUnverified_FailsGuardByEvidence`
**Verification:** high — cleanup satisfies its guard by evidence; no production path writes review status before the guard reads it.
**Dependencies:** T-10
**Parallelizable:** No

### Task T-13: Widen the affordance seam and derive next_actions from admission

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-9
**Files:**
- `servers/exarchos-mcp/src/next-actions-computer.ts`
- `servers/exarchos-mcp/src/next-actions-from-result.ts`
- `servers/exarchos-mcp/src/workflow/admission/legacy-state-translation.ts`
- `servers/exarchos-mcp/src/next-actions-computer.test.ts`
**Tests:** `NextActions_AdmissionWouldDeny_OmitsTheVerb`, `NextActions_TopologyDisagreesWithAdmission_FailsConsistencyCheck`
**Verification:** high — **the seam must be widened before the derivation is possible.** `NextActionsState` carries only `phase`, `workflowType`, `featureId`, `designDepth`, `mergeOrchestrator`, and `nextActionsFromResult` narrows the envelope through `ShapeOne`/`ShapeTwo` to those same five fields — deliberately omitting `artifacts`, `reviews`, `tasks`, `_cleanup`, i.e. exactly what every `Guard.evaluate(state)` reads. So this task must (a) widen `NextActionsState` and the envelope parse to carry the admission facts, (b) consult the admission projection rather than `t.guard.description`, and (c) keep the computer pure — the facts are passed in, never fetched. If widening the envelope proves to exceed this task, split the widening out and record the split; do NOT satisfy DR-9 by comparing admission output against admission (the Class B shape DR-30 forbids). The consistency test compares the **published affordances** against the **admission verdict**, which remain two distinct authorities after the fix.
**Dependencies:** T-10
**Parallelizable:** Yes

### Task T-14: Make risk resolution monotonic and fail-safe

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-10
**Files:**
- `servers/exarchos-mcp/src/workflow/tools.ts`
- `servers/exarchos-mcp/src/workflow/verification-policy-resolver.ts`
- `servers/exarchos-mcp/src/workflow/tools.test.ts`
**Tests:** `ResolveRiskTier_AbsentTier_DoesNotResolveLow`, `ResolveBoundaryTouching_UnknownState_FailsSafeToTrue`
**Verification:** high — unknown risk never becomes low; `boundaryTouching` fails safe.
**Dependencies:** T-04
**Parallelizable:** Yes

### Task T-15: Read the frozen requirement set back as authority

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-10
**Files:**
- `servers/exarchos-mcp/src/workflow/admission/requirement-context.ts`
- `servers/exarchos-mcp/src/workflow/admission/freeze-requirements.ts`
- `servers/exarchos-mcp/src/workflow/hsm-transition-guard.ts`
- `servers/exarchos-mcp/src/workflow/admission/requirement-context.test.ts`
**Tests:** `FrozenRequirements_TierSetInSameCall_DoesNotWeakenTransition`, `FrozenRequirements_Replay_ReconstructsSameRequirementSet`
**Verification:** high — a tier set in the same call cannot weaken that transition; replay reconstructs the same requirements.
**Dependencies:** T-14
**Parallelizable:** No

### Task T-16: Resolve the compiler-vs-registry authority direction

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-11
**Files:**
- `servers/exarchos-mcp/src/contract/compiler/meta-model.ts`
- `servers/exarchos-mcp/src/registry.ts`
- `servers/exarchos-mcp/src/contract/compiler/meta-model.test.ts`
**Tests:** `ContractCompiler_WrongMetaModel_IsDetected`, `ContractCompiler_StaleBaselineOnly_RemainsDistinguishable`
**Verification:** high — a wrong meta-model (not merely a stale baseline) is detected. May resolve to a documented direction + stated drift-guard limits per Open Questions.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-17: Widen the VCS ownership census to merge and branch-create

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-12
**Files:**
- `servers/exarchos-mcp/src/architecture/vcs-ownership.ts`
- `servers/exarchos-mcp/src/architecture/vcs-ownership.kill.test.ts`
**Tests:** `VcsOwnership_PlantedMergeOutsideOwner_CensusFailsClosed`, `VcsOwnership_PlantedBranchCreateOutsideOwner_CensusFailsClosed`
**Verification:** high — a planted `['merge','--no-ff',x]` outside the owner turns the census RED.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-18: Prove duplicate merge and duplicate PR prevention

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-12
**Files:**
- `servers/exarchos-mcp/test/integration/governance/merge-idempotency.test.ts`
**Tests:** `ExecuteMerge_DuplicateRequest_CreatesExactlyOneMergeCommit`, `CreatePr_DuplicateIdempotencyKey_CreatesExactlyOnePr`
**Verification:** high — through the shipped `handleExecuteMerge` and `vcs/github.ts`, not a test-local owner wrapper.
**Dependencies:** T-17
**Parallelizable:** Yes

### Task T-19: Widen effect detection beyond exact import specifiers

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-13
**Files:**
- `servers/exarchos-mcp/src/architecture/effect-ledger.ts`
- `servers/exarchos-mcp/src/architecture/effect-ledger.test.ts`
**Verification:** medium — a seeded non-listed HTTP client trips the ledger.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-20: Make shim discovery enumerate shipped renderers

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-14
**Files:**
- `src/shim-registry.ts`
- `src/shim-registry.test.ts`
**Verification:** medium — adding a per-harness renderer without an approved reason and expiry FAILS the ratchet.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-21: Complete the advisory registry and model path filters

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-15
**Files:**
- `src/advisory-registry.ts`
- `scripts/check-enforcer-wiring.mjs`
- `src/advisory-registry.test.ts`
**Verification:** medium — every `continue-on-error` / `--observe` / `|| true` is registered; the unfiltered-path check models filters.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-22: Narrow lint-inv6 literals so its threshold is reachable

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-15
**Files:**
- `scripts/lint-inv6.mjs`
**Verification:** low — static analysis plus a fixture proving prose usage no longer trips it.
**Dependencies:** T-21
**Parallelizable:** Yes

### Task T-23: fsync the parent directory on journal and tree renames

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-16
**Files:**
- `servers/exarchos-mcp/src/utils/atomic-write.ts`
- `servers/exarchos-mcp/src/install/atomic-promotion.ts`
- `servers/exarchos-mcp/src/utils/atomic-write.test.ts`
**Tests:** `PublishTempFile_AfterRename_FsyncsParentDirectory`, `AtomicPromotion_JournalRename_IsDurablyOrderedBeforeBackup`
**Verification:** high — ordering is constructed, not accidental; T3 SIGKILL arm proves convergence.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-24: Refuse to discard an orphan backup

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-17
**Files:**
- `servers/exarchos-mcp/src/install/atomic-promotion.ts`
- `servers/exarchos-mcp/src/install/atomic-promotion.orphan.test.ts`
**Tests:** `PromoteTree_OrphanBackupNoJournal_PreservesBackup`, `PromoteTree_OrphanBackupNoJournal_DoesNotStageOverOldTree`
**Verification:** high — `{target absent, backup = OLD, journal deleted}` preserves the backup. This test fails today.
**Dependencies:** T-23
**Parallelizable:** No

### Task T-25: Promote the CLI/MCP config writers

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-18
**Files:**
- `servers/exarchos-mcp/src/orchestrate/init/writers/mcp-json-writer.ts`
- `servers/exarchos-mcp/src/orchestrate/init/writers/claude-code.ts`
- `servers/exarchos-mcp/src/orchestrate/init/writers/mcp-json-writer.test.ts`
**Tests:** `McpJsonWriter_InjectedFailure_LeavesOldOrNewComplete`, `ClaudeConfigWriter_InterruptedPromotion_RecoversAtStartup`
**Verification:** high — injected failure leaves old-complete or new-complete; `recoverInterruptedPromotion` gains a startup/doctor entry point.
**Dependencies:** T-23
**Parallelizable:** Yes

### Task T-26: Close EFF-001 or mark INV-7 honestly

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-19
**Files:**
- `servers/exarchos-mcp/test/process/multi-process-append.test.ts`
**Tests:** `MultiProcessAppend_ThreeProcesses_ProducesDenseUniqueSequences`, `StartupRepair_GateTailDivergence_RepairsBeforeAcceptingWrites`
**Verification:** high — N≥3 real child processes; dense unique sequences; restart-repair arm. **This task also owns DR-19's third criterion**: whichever way it resolves, `.exarchos/invariants.md` (INV-7) and `docs/system-design.html` must not assert the guarantee categorically. Because those two files are owned by T-35 and T-44, this task's outcome must be known **before** they run — hence they depend on it. If EFF-001 is infeasible here (see Open Questions), record INV-7 as an unmet target and hand that verdict to T-35/T-44 rather than editing the documents from this task.
**Dependencies:** None
**Parallelizable:** Yes (but T-35 and T-44 are blocked on its verdict)

### Task T-27: Produce and publish a signed release manifest

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-20
**Files:**
- `.github/workflows/release.yml`
- `scripts/build-release-manifest.ts`
- `scripts/build-binary.ts`
**Tests:** `ReleaseManifest_RealBuildOutput_ProducesSignedManifest`, `BuildBinary_EmbedsSourceAndContractIdentity`
**Verification:** high — manifest produced from real build output; source and contract identity embedded.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-28: Consume the manifest in both installers and ship the verifier

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-20
**Files:**
- `scripts/get-exarchos.sh`
- `scripts/get-exarchos.ps1`
- `package.json`
**Tests:** `Installer_ManifestMismatch_RejectsInstall`, `Installer_ContractDigestMismatch_RejectsInstall`
**Verification:** high — installer rejects source, contract, manifest and asset mismatch.
**Dependencies:** T-27
**Parallelizable:** No

### Task T-29: Verify containment against packed bytes

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-21
**Files:**
- `servers/exarchos-mcp/test/packaged/containment.test.ts`
- `src/projection-containment.ts`
**Tests:** `PackedContainment_DeletedProjectionFile_FailsVerification`, `PackedContainment_RewrittenProjectionBytes_FailsVerification`
**Verification:** high — `npm pack` → unpack → digest verify; seeded delete and seeded rewrite both FAIL.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-30: Widen CI path filters and add hooks:guard

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-22
**Files:**
- `.github/workflows/ci.yml`
- `scripts/ci-topology.test.ts`
**Verification:** medium — a PR deleting only an agent, alias or hook cannot pass green.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-31: Emit durable shadow evidence

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-23
**Files:**
- `servers/exarchos-mcp/src/workflow/admission/live-shadow-observer.ts`
- `servers/exarchos-mcp/src/workflow/admission/live-shadow-observer.test.ts`
**Tests:** `ShadowObserver_LiveTransition_EmitsDurableShadowAttempt`, `ShadowObserver_Disagreement_EmitsDispositionEvent`
**Verification:** high — the registered `admission.shadow-attempt` / `disagreement-disposition` events are emitted from production; the in-memory sink stops being the substrate (INV-1).
**Dependencies:** T-10
**Parallelizable:** Yes

### Task T-32: Make a dead observer detectable and the gate sound

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-23
**Files:**
- `servers/exarchos-mcp/src/workflow/admission/live-shadow-observer.ts`
- `servers/exarchos-mcp/src/workflow/admission/cutover-gate.ts`
- `servers/exarchos-mcp/src/workflow/admission/live-shadow-observer.test.ts`
**Tests:** `ShadowObserver_SinkThrows_IncrementsHealthCounter`, `CutoverGate_AllAttemptsErrored_DoesNotSatisfyLiveConditions`
**Verification:** high — health counter; a gate condition reads live disagreement class; 20 all-throwing attempts cannot satisfy the gate.
**Dependencies:** T-31
**Parallelizable:** No

### Task T-33: Make the oracle observe real handlers

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-24
**Files:**
- `servers/exarchos-mcp/src/contract/oracle/fixtures.ts`
- `servers/exarchos-mcp/src/contract/oracle/oracle-seam.ts`
- `servers/exarchos-mcp/src/contract/oracle/fixtures.test.ts`
**Tests:** `Oracle_RealHandlerSkipsAuthorization_IsCaught`, `Oracle_EffectAxisUnobserved_ReportsNotObservedNotPass`
**Verification:** high — real handlers with registry roles/effects; absent observation reports `not-observed`, never `pass`.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-34: Resolve the CLI/MCP relationship against governing INV-2

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-25
**Files:**
- `servers/exarchos-mcp/src/adapters/cli.ts`
- `servers/exarchos-mcp/src/contract/cli/cli-contract-seam.ts`
- `servers/exarchos-mcp/src/adapters/cli.test.ts`
**Tests:** `Cli_ApiAction_HasNoDirectDispatchPath`, `Cli_GeneratedClient_AgreesWithMcpViaRealHandler`
**Verification:** high — generated client, or a recorded deviation with owner and expiry. No unacknowledged violation remains.
**Dependencies:** T-16
**Parallelizable:** Yes

### Task T-35: Re-approve the invariant catalog

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-26
**Files:**
- `.exarchos/invariants.md`
- `servers/exarchos-mcp/src/contract/authority-lock-cli.ts`
**Verification:** medium — INV-2/4/7/11 re-approved; the four stale in-code citations re-pointed; the freeze pins the governing contract. **INV-7's wording is decided by T-26's outcome** (closed vs. still-a-target), so this task consumes that verdict rather than assuming one.
**Dependencies:** T-34, T-26
**Parallelizable:** No

### Task T-36: Build the T1 public-root tier

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-27
**Files:**
- `servers/exarchos-mcp/test/integration/public-root/actions.test.ts`
- `servers/exarchos-mcp/test/integration/_harness.ts`
**Tests:** `PublicRoot_EveryRegisteredAction_ReachableThroughDispatch`, `PublicRoot_ActionEnvelope_MatchesRegisteredOutputSchema`
**Verification:** high — every composite action through `dispatch()` with a real store; coverage ratcheted against the 120-action denominator.
**Dependencies:** T-01
**Parallelizable:** Yes

### Task T-37: Build the T2 governance tier

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-28
**Files:**
- `servers/exarchos-mcp/test/integration/governance/gate-before-completion.test.ts`
- `servers/exarchos-mcp/test/integration/governance/denied-transition.test.ts`
- `servers/exarchos-mcp/test/integration/governance/evidence-provenance.test.ts`
**Tests:** `Governance_DeniedTransition_DoesNotMutatePhase`, `Governance_BlockingGateRed_BlocksTaskCompletion`
**Verification:** high — each DR-1..DR-10 criterion driven from the public root, asserting a blocking outcome and its negative twin.
**Dependencies:** T-36
**Parallelizable:** No

### Task T-38: Serialize the process-tier binary build

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-29
**Files:**
- `servers/exarchos-mcp/test/process/_helpers.ts`
- `servers/exarchos-mcp/test/process/_helpers.test.ts`
**Verification:** medium — running all `test/process` files together no longer races in `ensureBinaryBuilt`.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-39: Add the T3 crash and concurrency arms

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-29
**Files:**
- `servers/exarchos-mcp/test/process/promotion-kill.test.ts`
**Tests:** `AtomicPromotion_SigkillBetweenRenames_ConvergesToOldOrNew`, `ProcessTier_InProcessThrowInjection_IsRejectedByHarness`
**Verification:** high — real subprocesses only; SIGKILL between renames; in-process throw injection is explicitly disallowed.
**Dependencies:** T-38, T-24
**Parallelizable:** No

### Task T-40: Enforce the suite invariants mechanically

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-30
**Files:**
- `servers/exarchos-mcp/test/integration/suite-invariants.test.ts`
**Tests:** `SuiteInvariant_SingleSourceComparison_IsRejected`, `SuiteInvariant_BlockingClaimWithoutKillFixture_IsRejected`
**Verification:** high — rejects single-source comparisons, missing kill-fixture declarations, and `passed===true` on a could-not-run verdict; accepted gaps carry owner and expiry.
**Dependencies:** T-37
**Parallelizable:** No

### Task T-41: Bind the catalog oracle to the real repo config

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-31
**Files:**
- `servers/exarchos-mcp/src/architecture/resolve-effective-catalog.characterization.test.ts`
- `servers/exarchos-mcp/src/architecture/catalog-sources.test.ts`
**Verification:** medium — **this file already exists and its committed golden is not a valid oracle for this change.** Two defects must be corrected before it can guard T-42/T-43: (a) it passes a hand-built `{ invariants: { devCatalog: 'enabled' } }` with **no `catalogs:` entry**, so its subject is a config the repo does not use; (b) `resolveEffectiveCatalog` internally synthesizes `USER_CATALOG_LOAD_CONFIG` with the boolean already enabled, so its output cannot vary with the config flag — a single-source comparison, the Class B shape DR-30 forbids. Re-bind the characterization to the **real `.exarchos.yml`**, and add a `catalog-sources` assertion exercising the desugaring branch directly, since that is the site removal actually changes. Because the existing golden is pinned to the retired behavior, updating it **is** a behavior change and must be called out explicitly under the oracle-integrity gate — never folded into the diff unremarked.
**Dependencies:** None
**Parallelizable:** Yes

### Task T-42: Remove the boolean dependency from all four sites

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-31
**Files:**
- `servers/exarchos-mcp/src/architecture/invariants-loader.ts`
- `servers/exarchos-mcp/src/architecture/catalog-sources.ts`
- `servers/exarchos-mcp/src/architecture/resolve-effective-catalog.ts`
- `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts`
**Tests:** `InvariantsLoader_NoDevCatalogFlag_ResolvesViaCatalogSources`, `CatalogSources_NoDesugarBranch_ResolvesRegisteredCatalogsOnly`
**Verification:** high — `invariants-loader.ts:460` stops gating; `catalog-sources.ts:70` loses the desugaring branch; `resolve-effective-catalog.ts:109` stops synthesizing a config to defeat a gate that no longer exists. `vocabulary-lint.ts` needs no edit (it delegates through `loadInvariants`) — confirm that by test rather than assumption. T-41's re-bound characterization must stay green. Characterization required.
**Dependencies:** T-41
**Parallelizable:** No

### Task T-43: Remove devCatalog from the schema and .exarchos.yml

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-31
**Files:**
- `servers/exarchos-mcp/src/config/exarchos-config-schema.ts`
- `.exarchos.yml`
- `servers/exarchos-mcp/src/config/exarchos-config-schema.test.ts`
**Tests:** `ExarchosConfig_DevCatalogRemoved_EffectiveCatalogUnchanged`, `ExarchosConfig_LegacyDevCatalogKey_EmitsTypedDeprecation`
**Verification:** high — the boolean is gone or is a deprecated alias emitting a typed deprecation and desugaring to a `catalogs:` entry. Also update the seed path (`orchestrate/init/seed-exarchos-config.ts`) and the doctor check so a freshly-onboarded repo never writes the retired flag.
**Dependencies:** T-42
**Parallelizable:** No

### Task T-44: Update system-design.html to the resolved invariant set

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-32
**Files:**
- `docs/system-design.html`
- `.exarchos/invariants.md`
**Verification:** low — static. INV-2/4/7/11 in governing form; the #1608 note resolved; the capability table distinguishes built from built-but-unreached. Must land after DR-26's catalog re-approval so the two documents agree, and after T-26 so INV-7's wording matches its actual verdict.
**Dependencies:** T-35, T-26
**Parallelizable:** Yes

### Task T-45: Re-point the skills to catalog-registration gating

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-33
**Files:**
- `skills-src/ideate/references/constraint-anchoring.md`
- `skills-src/ideate/SKILL.md`
- `skills-src/refactor/SKILL.md`
- `skills-src/refactor/references/brief-template.md`
- `skills-src/debug/SKILL.md`
- `skills-src/shepherd/SKILL.md`
**Verification:** medium — edit `skills-src/` ONLY (never `skills/`), then `npm run build:skills`; `npm run skills:guard` must pass with no drift. Also covers `refactor/references/{overhaul,polish}-track.md` and `debug/references/thorough-track.md`.
**Dependencies:** T-43
**Parallelizable:** No

### Task T-46: Update the invariants guides

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-33
**Files:**
- `docs/guides/exarchos-yml-invariants.md`
- `docs/guides/authoring-invariants.md`
**Verification:** low — static; describe the consumer-shaped `catalogs:` configuration only. `verify_doc_links` passes.
**Dependencies:** T-43
**Parallelizable:** Yes

### Task T-47: Activate the route selector on the live path

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-34
**Files:**
- `servers/exarchos-mcp/src/workflow/admission/edge-condition-select.ts`
- `servers/exarchos-mcp/src/workflow/admission/legacy-state-translation.ts`
- `servers/exarchos-mcp/src/workflow/admission/edge-condition-select.test.ts`
**Tests:** `SelectEdge_TwoSimultaneouslyTrueConditions_ReportsMultiMatch`, `SelectEdge_IndeterminateHighestPriority_BlocksRatherThanFallsThrough`
**Verification:** high — the live path must route through `selectEdge` rather than evaluating one edge in isolation, so `multiMatch` and the indeterminate-blocks rule stop being inert. If activation is deferred, move DR-34 to `## Scope / Excluded` with an owner and a tracking issue rather than leaving it unimplemented.
**Dependencies:** T-10, T-13
**Parallelizable:** No (shares `legacy-state-translation.ts` with T-13 and T-48)

### Task T-48: Make evidence provenance and waivers reachable

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-35
**Files:**
- `servers/exarchos-mcp/src/workflow/admission/legacy-state-translation.ts`
- `servers/exarchos-mcp/src/workflow/admission/select-evidence.ts`
- `servers/exarchos-mcp/src/workflow/admission/waiver.ts`
- `servers/exarchos-mcp/src/workflow/admission/evidence-provenance.test.ts`
**Tests:** `Admission_StaleEvidence_Denies`, `Admission_ScopedWaiver_AppliesOnlyToDeclaredSubject`
**Verification:** high — stop minting evidence from the same projection being judged (`createdAt = evaluatedAt`, self-granted issuing authority, subject built to match). `selectEvidence` must be called on the wired path so contradiction detection is live, and `obligations.waivable` must be able to be true so the waiver branch is reachable. Driven from the public root, not from `adjudicateEdge` directly.
**Dependencies:** T-10, T-47
**Parallelizable:** No (shares `legacy-state-translation.ts` with T-13 and T-47)

### Task T-49: Give the new admission appends idempotency keys

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-36
**Files:**
- `servers/exarchos-mcp/src/workflow/admission/live-shadow-observer.ts`
- `servers/exarchos-mcp/src/event-store/tools.ts`
- `servers/exarchos-mcp/src/event-store/admission-append-idempotency.test.ts`
**Tests:** `AdmissionDisposition_ReplayedAppend_ReturnsStoredResultNotDuplicate`, `ShadowAttempt_RetriedAppend_CollapsesOnIdempotencyKey`
**Verification:** high — keys derive from natural identity (`dispositionId`, attempt identity), never a random value. INV-8 enforcement is `mode: audit` (reviewer judgment, no mechanical backstop), so this test IS the backstop for the events this plan adds. Must land with or immediately after T-31/T-32 — never later, or the appends ship unkeyed.
**Dependencies:** T-31
**Parallelizable:** No

### Parallelization

**Critical path:** T-01 → T-03 → T-10 → T-12 → T-37 → T-40.

- **W1 (gates all):** T-01 first (sole head). T-03 sequential on T-01; T-04 → T-02 (shared `definitions.ts`); T-05..T-09 parallel.
- **W2:** T-10 head; T-11/T-13/T-47 parallel after it; T-12 and T-48 sequential (T-48 shares `legacy-state-translation.ts` with T-47); T-14 → T-15; T-16 independent.
- **W3:** T-17 → T-18; T-19, T-20, T-21 → T-22 all independent of each other.
- **W4:** T-23 → {T-24, T-25}; T-26 independent **but blocking T-35/T-44**.
- **W5:** T-27 → T-28; T-29, T-30, T-33 independent; T-31 → {T-32, T-49}; T-16 → T-34 → T-35 → T-44 (T-35 and T-44 also wait on T-26).
- **W5 catalog retirement:** T-41 → T-42 → T-43 → {T-45, T-46}. Strictly sequential through T-43 because each step's oracle is the previous step's snapshot.
- **Suite:** T-36 (after T-01) → T-37 → T-40; T-38 → T-39 (also needs T-24).

W2–W5 are mutually parallel once W1 lands. **Shared-file pairs — each sequential in one worktree** (this list is authoritative; the plan review found it was previously incomplete):

| File | Tasks |
|---|---|
| `src/tasks/tools.ts` | T-01, T-03 (serialized by T-03 ← T-01) |
| `src/runbooks/definitions.ts` | T-02, T-04 (serialized by T-02 ← T-04) |
| `workflow/cleanup.ts` | T-10, T-12 |
| `install/atomic-promotion.ts` | T-23, T-24 |
| `admission/legacy-state-translation.ts` | T-13, T-47, T-48 |
| `admission/live-shadow-observer.ts` | T-31, T-32, T-49 |
| `.exarchos/invariants.md` | T-26 (verdict only), T-35, T-44 — serialized by T-35 ← T-26 and T-44 ← T-35 |

**Catalog-retirement ordering constraint.** T-44 (system-design) depends on T-35 (catalog re-approval) so the narrative and the catalog cannot disagree; both depend on T-26 so INV-7's wording matches its actual verdict rather than an assumed one. T-45/T-46 depend on T-43 so no document instructs a reader to set a flag that no longer exists. T-45 edits `skills-src/` only — direct edits to `skills/` fail `skills:guard`.

### Completion checklist

- [ ] Every DR-N maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier leans on static analysis
- [ ] Characterization captured for every task that changes existing behavior, with intended changes named
- [ ] Oracle-integrity gate run (`git diff -- tests/`) before completion
- [ ] Open questions resolved OR explicitly deferred with rationale
- [ ] Ready for `overhaul-plan-review`



