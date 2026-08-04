# Wiring Closure and the Unified Integration Suite

**Status:** proposed
**Date:** 2026-08-04
**Supersedes nothing.** Successor to `docs/audits/structural-closure-delta-audit/unified-remediation-plan.md` (the 48-package program, merged on `feature/structural-closure-remediation`).
**Authorities:** the unified remediation plan; `docs/system-design.html`; `.exarchos/invariants.md` (with the supersessions in §5).

---

## 1. Purpose

The 48-package structural-closure program built the right machinery. A
package-by-package audit of all 48 against their own acceptance criteria found
that **the machinery is disproportionately unreached by production**: modules are
present, well-typed, and well unit-tested, while the shipped path either does not
call them or calls something else.

This spec turns that audit into work. It has two deliverables:

1. **Wiring closure** — connect, enforce, or honestly downgrade every feature the
   audit found present-but-unreached.
2. **The unified integration suite** — one tiered suite whose organising principle
   is *the production path*, replacing the current module-shaped test mass that
   let every defect in §3 survive a green run.

Non-goal: rewriting the 48 packages. Nearly every module audited is sound in
isolation. The defect is at the seams.

---

## 2. Evidence base

Seven parallel read-only audits, one per program, each scoring its packages on
four axes with file:line evidence: **wired** (reachable from production
composition), **operational** (can it produce its blocking outcome), **leveraged**
(used everywhere it applies), **conformant** (meets its stated acceptance
criterion).

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

Supporting measurement: of 841 MCP test files, **109 (13%)** drive real
composition. Per program: P01 24%, P02 14%, P03 5%, P04 **0%**, P06 **0% from the
public root**.

---

## 3. The defect classes

The 40 non-OK packages are not 40 unrelated bugs. They are seven recurring
shapes. Fixing the shapes is the point; fixing instances one at a time will
regenerate them.

### Class A — Present, not wired
A complete, well-tested module with zero production call sites.
`release-manifest` is never produced, signed, published, or consumed, and its
verifier is not in `package.json` `files[]` (P05-01). The requirement-freeze
machinery (`requirement-context.ts`, `freeze-requirements.ts`) is built and
unwired (P06-03). `selectEdge`'s only caller is `RESERVED` (P06-02). The waiver
model is unreachable by construction (P06-04). `runProviderMutation` has no
production caller (P04-05). Nothing loads an extension (P03-08).

### Class B — Self-referential proof
Both sides of a comparison derive from the same source, so it can never disagree.
`projection-containment.packaging.test.ts` builds the required inventory and the
"packaged layer" from **the same `contents` map**, so deleting a real agent, alias
or hook shrinks both sides together and the proof still passes (P05-03). The
contract drift guard's baseline and checker are both pure functions of the same
hand-written registry, so it cannot detect a wrong meta-model (P03-03). The
oracle's seeded breaks have declaration, handler and detector co-authored in one
file (P03-09). This is the class the reachability fix (`ea605350`) already closed
for P05-05 — the pattern is repo-wide.

### Class C — Orphaned reader
A consumer gates on a signal no producer emits. `task_complete` blocks on
`gate.executed`/`static-analysis`, but every migrated durable-runner producer now
appends `admission.evidence-recorded` instead — so the ordering guarantee is
unsatisfiable by the real gate (P02-03). The cutover gate reads live shadow
records that nothing durable produces (P07-01).

### Class D — Indeterminate laundered into pass
Already fixed in three places this cycle; three more remain. The resolved
`riskTier` is frozen at `prepare_delegation` but **never delivered** to the gate —
`TASK_COMPLETION` passes only `{repoRoot, worktreePath}` — so every dispatch
reaches `interpretProbeVerdict` with an undefined tier and a HIGH-tier task with
no tests still returns `passed: true` (P02-04). A degraded projection is served
as `success: true` with the stale payload (P01-02). The oracle's effect axis
converts absent observation into positive assurance (P03-09).

### Class E — Detector scoped below the real surface
The VCS ownership census matches only `worktree add`, `worktree remove`,
`branch -d|-D` as adjacent literals, and explicitly scopes out merge/commit/
branch-create — so `local-git-merge.ts` running `checkout -b`, `merge`, `commit`,
`rebase` straight through `gitExec` is invisible **by design** (P04-05). The
effect ledger keys off exact import specifiers, so `node:http2`/`axios`/aliased
globals evade it (P04-01). The shim ratchet is marker-driven, so five real
per-harness renderers are ungoverned while its whole inventory is one dead stub
(P03-07). The advisory registry's scan scope excludes workflow-level
`continue-on-error` (P07-07).

### Class F — Two authorities for one boundary
Three modules mutate phase: the guarded path, plus `cancel.ts:367` and
`cleanup.ts:303` calling `executeTransition` directly — **INV-9 is violated today**,
independent of cutover, and neither bypass is shadow-observed (P06-05).
`next_actions` enumerates raw HSM topology without evaluating a single guard, so
the runtime advertises moves admission will deny (P06-06). The hand-written
`registry.ts` is authoritative while the "compiler" merely describes it (P03-03).

### Class G — The governed supplies its own governance
`task_complete`'s `evidenceBypass` accepts `args.evidence.passed === true` from
the agent being governed and disables **all** gate enforcement (P02-03).
`cleanup.ts:271/277` force-writes `reviews[*].status = 'approved'` and
`mergeVerified: true` immediately before evaluating the guard that reads them —
a pass-state fix in production, and `retirement-safety.ts` already names
`'pass-state-fix'` as a legacy class awaiting retirement (P06-06).

---

## 4. Corrections and refutations

Recorded because an audit that only accumulates findings is not trustworthy.

- **RETRACTED (orchestrator's own prior HIGH).** The `check_test_adequacy`
  vacuous-pass finding was produced against the *installed* binary
  (`~/.exarchos/bin/exarchos.exe`, built 2026-07-20 19:37), which predates all 178
  branch commits. The current source returns the correct blocking verdict. The
  real defect split out as the toolchain-glob replacement bug, now fixed.
- **REFUTED.** The P01 audit's headline claim — `createCliDispatchContext` has
  zero production call sites, so every CLI gate returns `TRUSTED_CALLER_REQUIRED`
  — is false. It is the first statement of `buildCli()` (`adapters/cli.ts:317`).
  Not carried into this spec.
- **PARTIALLY REFUTED.** The merge path is *not* unledgered: it commits a durable
  `merge.requested` intent with deterministic idempotency keys and uses
  `git reset --keep`. What stands is that it does not route through
  `VcsMutationOwner` and the census cannot see it (P04-05).
- **CONFIRMED.** `makeArtifactGuard` (`guards.ts:54`) evaluates
  `artifacts[field] != null`, so `{"artifacts":{"plan":true}}` satisfies a phase
  gate on the feature and refactor tracks (P01-03).
- **CONFIRMED.** `evaluateCutoverGate` has zero production callers;
  `liveShadowSink` is a process-scoped in-memory ring buffer emitting no events.

---

## 5. Invariant catalog supersession (#1608)

`.exarchos/invariants.md` is **pinned as an authority** by `authority-pin.ts` and
digested into the contract freeze, so its stale text is a load-bearing input to
generation. Four entries must be re-approved through `authority-lock-cli.ts`:

| INV | Stale framing | Governing framing |
|---|---|---|
| **INV-2** | CLI≡MCP asserted by a *parity harness* | MCP is the sole invocation surface; the CLI is a **generated** client, equal **by construction**. A surviving parity harness is legacy; a direct CLI→dispatch path is a defect |
| **INV-4** | Render per harness, guard the renders | **One** standard artifact; thin shims only where no standard exists. Render-parity ≠ enforcement-parity |
| **INV-11** | Launcher enforces isolation | Launcher owns lifecycle + top-level placement **only**; spatial write confinement is explicitly out of scope |
| **INV-7** | Concurrency serialization (reads as closed) | **Target**, unverified until EFF-001. Asserting it categorically is itself a defect |

Four in-repo comments still cite the retired INV-2 parity framing as the
justification for a code shape (`tools.ts` `applyTransition`, `composite.ts`
maxNoCoverage, and two others); they must be re-pointed so future readers do not
reconstruct the retired obligation.

---

## 6. Work packages

Ordered by dependency, not severity. `W1` unblocks the honesty of everything
downstream.

### WAVE W1 — Stop the false green

| Pkg | Work | Acceptance |
|---|---|---|
| **W1-01** | Sever Class C: make `task_complete` gate on the event the durable runner actually emits, or make the runner emit `gate.executed`. Pick one producer. | `check_static_analysis` → `task_complete` through `dispatch()` with no hand-seeded event and no `evidence` field succeeds; the negative twin returns `GATE_NOT_PASSED` |
| **W1-02** | Remove the `evidenceBypass` escape, or restrict it to non-blocking gates behind an explicit operator capability. | A caller-supplied `evidence` object cannot satisfy a BLOCKING gate |
| **W1-03** | Deliver the frozen `riskTier` + `boundaryTouching` to the gate: add them as params and templateVars on `TASK_COMPLETION` and `TASK_FIX`. | A HIGH-tier task adding no tests returns `passed:false`; a LOW-tier one returns `skipped:true`. Runbook-shape assertion pins the params |
| **W1-04** | Make the degraded projection state durable and consumed: one event/projection, read by every readiness/workflow/reliability surface. | Fault injection makes **every** consumer return a typed degraded result, not `success:true` with a stale payload |
| **W1-05** | Tighten `makeArtifactGuard` to a typed artifact reference; a bare boolean must not satisfy a requirement. | `{"artifacts":{"plan":true}}` is rejected on every track |
| **W1-06** | Add the missing lint script so `check_static_analysis` cannot report `PASS (2/2)` with lint skipped; a skipped constituent renders the dimension DEGRADED. | Skipped ≠ pass, on every gate that aggregates |

### WAVE W2 — One authority per boundary

| Pkg | Work | Acceptance |
|---|---|---|
| **W2-01** | Route `cleanup` and `cancel` through the single guarded phase-mutation primitive (`runCleanupCommand` already exists and is dead). | Exactly one call path mutates phase; all three are shadow-observed (INV-9) |
| **W2-02** | Delete the `cleanup.ts` pass-state fix; cleanup must satisfy the guard by evidence, not by rewriting the fields the guard reads. | No production path writes `reviews[*].status` or `mergeVerified` before the guard reads them |
| **W2-03** | Derive `next_actions` from the admission verdict, not raw HSM topology. | A denied transition is not advertised as an affordance; a consistency test fails if the two authorities disagree (INV-12) |
| **W2-04** | Fix monotonic resolution: unknown risk must **not** become `low`; `boundaryTouching` must fail safe; read the frozen set back as authority for later attempts. | Absent/malformed tier does not resolve low; a tier set in the same call cannot weaken that transition |
| **W2-05** | Invert P03 authority: make the compiler's descriptors the source the server consumes, or stop calling `registry.ts` a projection of them. | A wrong meta-model (not merely a stale baseline) is detected |

### WAVE W3 — Widen the detectors (Class E)

| Pkg | Work | Acceptance |
|---|---|---|
| **W3-01** | Extend VCS ownership to merge/commit/branch-create, or route `local-git-merge` through `VcsMutationOwner`. | A planted `['merge','--no-ff',x]` outside the owner turns the census RED (it passes today) |
| **W3-02** | Extend effect detection beyond exact import specifiers (http2, common HTTP clients, re-export/alias). | A seeded non-listed HTTP client trips the ledger |
| **W3-03** | Make shim discovery enumerate the real surface, not volunteers. | Adding a per-harness renderer without an approved reason + expiry FAILS the ratchet |
| **W3-04** | Register every advisory; model path filters in the unfiltered-CI-path check; fix `lint-inv6` literals so its promotion threshold is reachable. | Every `continue-on-error` / `--observe` / `\|\| true` in the repo is registered with owner, threshold, expiry, kill fixture |

### WAVE W4 — Durability and recovery

| Pkg | Work | Acceptance |
|---|---|---|
| **W4-01** | fsync the parent directory after the journal rename and after each tree rename; never `safeRemove` a backup with no consumable journal. | `{target absent, backup = OLD tree, journal deleted}` does not destroy the backup |
| **W4-02** | Extend atomic promotion to the spec-named CLI/MCP config writers (`~/.claude.json`, `.vscode/mcp.json`, `.cursor/mcp.json`). | Injected failure leaves old-complete or new-complete for config, not just skills |
| **W4-03** | Give `recoverInterruptedPromotion` a startup/doctor entry point. | An interrupted promotion is repaired at rest, not only on a voluntary retry |
| **W4-04** | Close EFF-001: real multi-process append linearization + startup repair. | INV-7 graduates from target to closed, or stays honestly marked |

### WAVE W5 — Ship surface and cutover honesty

| Pkg | Work | Acceptance |
|---|---|---|
| **W5-01** | Produce, sign, publish and **consume** the release manifest; ship the verifier; embed source + contract identity in the artifact. | Installer rejects source/contract/manifest mismatch, not just a corrupted download |
| **W5-02** | Rebuild projection containment against real packaged bytes (`npm pack` → unpack), not a mirror of the source read. | Deleting one file from the tarball and rewriting another both FAIL |
| **W5-03** | Add `hooks:guard` to CI; add drift guards for `command-aliases/` and `agents/`; widen `changes.root` to every projection root. | A PR that only deletes an agent, alias or hook cannot pass green |
| **W5-04** | Make shadow evidence durable (emit the registered `admission.shadow-attempt` / `disagreement-disposition` events); add a gate condition reading live disagreement class; add an observer health counter. | A dead observer is **detected**, not silently zero; the gate cannot green on evidence that proves nothing |
| **W5-05** | Make the oracle invoke real handlers with roles/effects from the registry; absent observation reports `not-observed`, never `pass`. | A real handler skipping authorization is caught |
| **W5-06** | Either generate the CLI from the contract (P03-05) or record the direct CLI→dispatch path as an accepted, expiring deviation. | No unacknowledged violation of the governing INV-2 |
| **W5-07** | Re-approve the invariant catalog through `authority-lock-cli.ts` with the §5 supersessions; re-point the four stale in-code citations. | The freeze pins the governing contract, not a superseded one |

---

## 7. The unified integration suite

### 7.1 Organising principle

The current suite is shaped by **module**. Every defect in §3 lives at a seam
*between* modules, which is why 10,491 green tests coexisted with them. The new
suite is shaped by **the production path**, and a test's tier is determined by how
far down that path it enters.

```
T1 public root   →  dispatch(verb, args, ctx)         — the MCP contract
T2 governance    →  gate → evidence → admission → transition
T3 process       →  real subprocesses, crash, concurrency
T4 packaged      →  the compiled binary and the packed artifact
```

Location: `servers/exarchos-mcp/test/integration/{public-root,governance}/`,
`test/process/` (extended), `test/packaged/` (new). Kept outside `src/` so they
are not unit-test-adjacent and do not inherit the `bun:sqlite` alias.

### 7.2 The four tiers

**T1 — Public-root contract tier.** Every composite action driven through
`dispatch()` with a real event store and real state dir. No hand-mocked handler,
no synthesized dispatch context. Answers: *is this action reachable, and does its
envelope match its contract?* Denominator: the same 120 actions the packaged
sweep uses; coverage is ratcheted.

**T2 — Governance-path tier.** The chains that actually enforce policy, each
driven from the public root: gate → durable evidence → admission → transition.
This is where P01/P02/P06 gaps land. Every test asserts a **blocking** outcome,
not merely a shape. Includes the negative twins — a denied transition must not
mutate phase.

**T3 — Process tier.** Real child processes. Multi-process append (EFF-001),
SIGKILL between the two renames in atomic promotion, restart repair, concurrent
worktree/merge idempotency. In-process `throw` injection does **not** qualify: it
always runs the `catch`, which is why the eight existing fault tests never
constructed the orphan-backup state.

**T4 — Packaged tier.** The compiled binary sweep (already strong — extend to the
4 missing error families and 1 effect family) plus a new packed-artifact arm:
`npm pack` → unpack → verify containment against **those bytes**.

### 7.3 Suite invariants

These are enforced on the suite itself, by a meta-test:

1. **No self-referential proof.** A test may not derive both sides of a
   comparison from one source read. Mechanically: a containment/drift assertion
   must name two distinct authorities. This is Class B, and it has already
   produced two false capstones.
2. **Every blocking claim carries a kill fixture.** If deleting the enforcement
   code turns no test red, the claim is unproven. Each T2 test declares the
   seam it kills.
3. **Indeterminate is a distinct outcome.** No test may assert `passed === true`
   where the underlying verdict was "could not run".
4. **Coverage is ratcheted, gaps are named.** Accepted gaps (e.g. the 4 error
   families) are enumerated with an owner and an expiry, exactly as advisories
   are — not left as a silent shortfall.

### 7.4 Gap → tier mapping

All 41 audit-identified test gaps map to a tier. The 16 HIGH ones:

| Tier | Gaps |
|---|---|
| **T1** | P03-05 CLI/MCP agreement via the real handler; P01-07 self-asserted issuer refused |
| **T2** | P02-03 gate-before-completion + evidence-cannot-satisfy; P02-04 tier from the real delegation stamp; P01-03 bare boolean rejected; P01-02 every consumer degrades; P06-03 unknown risk not low; P06-05 cleanup/cancel through one primitive; P06-06 next_actions ≡ admission verdict; P06-04 stale/contradictory/malformed/unauthorized evidence denies; P07-01 dead observer detected |
| **T3** | P04-04 SIGKILL between renames + orphan-backup preservation; P04-05 duplicate merge/PR through the shipped path; P01-01 multi-process append |
| **T4** | P05-03 packed-bytes containment; P05-01 installer rejects manifest mismatch; P05-02 missing error/effect families; P03-07 shim ratchet |

### 7.5 What this replaces

Nothing is deleted wholesale. The rule is **promotion, not duplication**: where a
T2 test proves a property end-to-end, the corresponding helper-level test is
demoted to a unit test of the pure function and stops being cited as evidence for
the guarantee. The `false-advisory` suite is the template — it was correct, and
tested a seam the product did not use.

---

## 8. Sequencing

```
W1 (false green)  ──┬─→ W2 (one authority) ──┬─→ W5 (ship + cutover)
                    │                        │
                    └─→ W3 (detectors)  ─────┘
                    └─→ W4 (durability) ─────┘

T1 lands with W1 · T2 with W2 · T3 with W4 · T4 with W5
```

**W1 is the gate.** Until the false-green paths are closed, every downstream
result is unreliable evidence — including the results of this spec's own work.

---

## 9. Acceptance

The program is complete when:

1. No package is scored `wired: no` while its acceptance criterion is claimed met.
   Features that will not be wired are **downgraded honestly** to deferred
   capability, not left as claimed closure.
2. Every gate answers "can this fail and block anything?" with **yes**, or is
   registered as an advisory with owner, threshold, expiry and kill fixture.
3. Every headline metric can be lowered by mutating a real input.
4. The four superseded invariants are re-approved and the freeze pins the
   governing contract.
5. Production-path coverage is ratcheted per program, with P04 and P06 above
   zero from the public root.
6. The cutover gate is either satisfiable from durable evidence, or explicitly
   marked unreachable-as-designed with the redesign tracked.

---

## 10. Out of scope

- Rewriting the 48 packages. The modules are sound; the seams are not.
- Flipping the cutover. W5-04 makes the gate *honest*, not green.
- Spatial write confinement (space-moat workstream, per the INV-11 reframing).
- Byte-reproducible native binaries (documented Bun nonce); W5-01 covers identity
  and signing, not bit-identical rebuilds.
