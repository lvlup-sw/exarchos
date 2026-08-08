# Spec: Internal mechanics overhaul — one authority per contract, bound mechanically, IR-shaped

**Date:** 2026-08-06 · **Revised:** 2026-08-07 (rev 4.17) · **Feature:** `internal-mechanics-overhaul` · **Depth:** deep
**Method:** `proof-driven-development` (Design mode) — `~/.agents/skills/proof-driven-development`
**Baseline:** rebased onto `origin/main`; **every count below is re-derived from the landing branch.**

> ## Revision 4 — what Wave 1 implementation falsified
>
> Rev 4 is an **amendment cycle, not an authoring revision.** Revs 1–3 were authored; rev 4 is written against evidence produced by *running the plan*. The first Wave 1 batch (tasks 049, 005, 016, 046) shipped to `feat/internal-mechanics-overhaul`, and three of this spec's own claims did not survive contact with the landing branch. The revision counter was reset by operator decision on that basis: **the counter exists to stop authoring loops, and freezing the spec against measured reality is not what it is for.**
>
> **Three findings, all the same defect — this spec's own thesis turned back on it.** Each is a declaration that exists, is enforced, and *cannot fail*:
>
> 1. **DR-0's error-path criterion was unsatisfiable.** "A partially-migrated tree must fail typecheck" is impossible as stated: v1 and v2 both declare a *structural* `Transport`, and TypeScript has no notion of nominal package identity, so `tsc --strict` accepts every mixing direction — including the cross-package `InMemoryTransport` linked pair the criterion specifically named. This is *worse* than assumed: a partial migration compiles clean and fails at runtime as a hang or an empty result. **The criterion was assigned to a subject that cannot carry it.** → resolved by **DR-26**, which makes the rung-2 claim true rather than abandoning it.
> 2. **DR-4's counts were wrong, and so was its "typed" set.** Measured: **112 vacuous of 122**, not 109/123. The reconciliation closes exactly — `109 literal + 1 factory duplicate (makeDescribeAction serves two tools) + 2 named bindings = 112`; the old denominator counted two non-declarations (`ToolAction.outputSchema` at `registry.ts:608`, the `withCappedShape` parameter at `:1318`). The load-bearing half: **the "2 HSM" declarations rev 3 called typed are themselves vacuous** — `WorkflowUpdateOutputSchema` *is* literally `EnvelopeSchema(z.unknown())`, and `WorkflowTransitionOutputSchema` wraps it in an intersection constraining `_meta.deprecation` only, leaving `data` as `z.unknown()`. Calling them typed *because they have names* is the presence-not-substance error G2 exists to catch. **The migration template is 10 declarations, not 12.** → resolved by **DR-4** (amended).
> 3. **DR-1 under-specified the envelope.** Four fields carry identity and topology but not *what was declared*, so tasks 007/008 would have had to reach past the seam into storage — re-opening the coupling DR-1 closes. → **`subject` ratified as a fifth field** (DR-1, amended).
>
> **Why all three happened.** The spec asserts measured facts, proof rungs and type shapes, and *nothing binds those assertions to the artifacts that would falsify them*. Rev 1 was refuted 3/3 for this exact class; rev 3 reproduced it in DR-4. DR-24 already states the rule — re-derive wave premises at plan time — but as **a rule someone must remember**, which is PDD's own anti-pattern row. → **DR-27** makes it mechanical.
>
> **Corrected measurements (rev 3 → rev 4):** vacuous `outputSchema` **109/123 → 112/122**; substantive declarations **12 → 10** (all `withCappedShape`; the 2 HSM reclassified vacuous); SDK import sites **unmeasured → 38 files across 13 directories**. Holding: `withCappedShape` 10, `EventTypes` 170, hand-written CLI literals 11.
>
> **Scope added:** **DR-26** (SDK generation seam — restores DR-0's rung-2 claim), **DR-27** (measured-premise binding — kills the drift class), and a **seventh authority-topology row** for the SDK boundary, which rev 3 omitted entirely while it carried two authorities.
>
> ### Revision 4.1 — batch-2 findings
>
> Batch 2 (tasks 006, 047, 048) merged clean with zero new failures. Two findings:
>
> 1. **DR-25's own documentation deliverable created a new unbound representation.** Task 048's skill prose is a fifth representation of the posture→dispatch contract and nothing binds it to `POSTURE_DISPATCH_MAP`. This is the **second** boundary to grow an unbound prose representation — the topology table already records "skill prose (#1716)" at the event catalog — which makes it a pattern, not an oversight. **Documentation that restates a contract is a representation, and representations get bound.** → DR-25 gains a binding criterion; task 056.
> 2. **The cast budget has ZERO headroom, measured — not the ~1 unit previously briefed.** `asCast` delta is **5 of budget 5**. The wave's remaining production tasks cannot add a single `as <identifier>`, and the census counts JSDoc prose. Resolution is paydown, not re-baselining. → task 057, which must land **before** the next production batch.
>
> **A briefing error worth recording, because it cost three agents real effort.** The repo has **two** cast censuses with different regexes: `scripts/check-type-debt.mjs` matches only `as unknown as`, while `scripts/tsconfig-strictness/count-casts.ts` matches `as` + any identifier and therefore counts prose. A green `check-type-debt` run proves nothing about the prose trap. The gate that bites is `FixWave_CastBudget_MeasuredAndWithinDeclaredLimit`.
>
> **Task 006 also settled DR-1's open refinement, against the prior expectation.** The kind-indexed subject map was **rejected on measurement**: it would force `contract/declaration.ts` to import registry storage (action and CLI-verb subjects live in `registry.ts`), which the seam census this same task built would then flag — the refinement contradicted DR-1. Both shapes were also compiled standalone and fail *identically* at the generic narrowing site, so the map's promised precision never reaches the accessor. Exactness is recovered per-consumer via `withSubject(declaration, guard)`, which is the correct posture post-#1258 anyway: after a deserialization round-trip the subject genuinely is untrusted, and a map would have promised a type nothing had checked.

> ## Revision 2 — what the plan-review panel refuted
>
> Rev 1 was **refuted 3/3** by an adversarial panel. Root cause: rev 1 was authored against a worktree **7 commits behind `origin/main`** and never re-measured against the branch it lands on. One claim was worse than stale — the "only `merge_orchestrate` declares a posture" line was copied from a **stale JSDoc** rather than measured, which is the exact defect this program exists to eliminate.
>
> **Dismissed as panel-side artifacts** (three voters measured the stale tree; verified present on `origin/main`): the claim that `core/effect-carrier.ts`, `vcs/mutation-owner.ts`, `architecture/{effect-ledger,effect-port-seam,layer-boundaries-seam,adapter-ownership-seam,vcs-ownership}.ts` and the whole `contract/` tree do not exist; the claim that they live only in an unmerged branch; the missing-input-documents gap; and **R-9 (now withdrawn — the taxonomy spec is tracked on `origin/main`)**.
>
> **Corrected measurements** (rev 1 → landing branch): vacuous `outputSchema` **106 → 109**; `cli.ts` **1,565 → 1,613** lines; `.command()` **"14 hand-written" → 14 total, of which 3 are derivation loops and 11 are hand-written literals**; hand-written top-level verbs **8 → 11** (adds `feedback`, `schema`, `topology`); `shared-mutating` actions **1 → 4** (`merge_orchestrate`, `prune_worktrees`, `serialize_merge`, `cutover_decide`); `EventTypes` **169 → 170** (pinned by three tests). Holding unchanged: `withCappedShape` 10, `longRunning` 9, `hidden: true` 1, `VIEW_FOLLOW_ACTIONS` 5.
>
> **Wave 0 is deleted.** Its three premises are already closed on the landing branch: `makeArtifactGuard` requires a resolvable reference (its own comment records the retired `!= null` probe), `evidenceBypass` has zero hits, and `executeTransition` has one non-test caller — the guard itself. Waves renumber; the program no longer has an INV-9 prerequisite.
>
> **Structural fixes** carried into this revision: G1 redesigned (rev 1's policy could not discriminate — see DR-5); G3/G4 promoted to full §3a tables; G5's contradictory enforcement dates reconciled; DR-1's relocation proof re-sequenced and given a falsifiable mechanism; the **SDK v1→v2 package split added as DR-0**, which rev 1 omitted while depending on v2-only APIs; `server/discover` absorbed into DR-22 (MC-4 was under-absorbed); `indeterminate` extended beyond DR-15; PDD's **production-path deliverable** added.
>
> **Counts are no longer literals.** Every ratchet seeds from a value **derived at guard introduction** and asserts only monotonic decrease. Rev 1 hard-coded `106`, which is precisely the defect class G2 exists to remove, restated as an acceptance criterion.

**Inputs:**
- **Supersedes** [`docs/specs/2026-08-05-event-taxonomy-v2.md`](./2026-08-05-event-taxonomy-v2.md) — its DR-1…DR-15 are absorbed below with provenance noted per DR. *(**R-9 discharged, verified 2026-08-07:** that file is tracked on `origin/main`, so the supersession has a git ancestor. The stale "untracked" note here was itself an unbound representation — it contradicted the withdrawal recorded in the rev-2 block above. Exactly the class DR-27 now binds.)*
- Discovery workflow `mcp-spec-2026-07-28-migration`:
  - [`docs/research/2026-08-06-mcp-spec-2026-07-28-migration-evaluation.md`](../research/2026-08-06-mcp-spec-2026-07-28-migration-evaluation.md)
  - [`docs/research/2026-08-06-mcp-2026-07-28-architectural-composition.md`](../research/2026-08-06-mcp-2026-07-28-architectural-composition.md) — MC-1…MC-4
- Inherited from the superseded spec: discovery report `2026-08-05-structural-emission-enforcement.md`; `2026-08-04-wiring-audit.md` (P01-03, P02-03, P06-05); `structural-closure-delta-audit/unified-remediation-plan.md`; `2026-05-24-auto-emission-audit.md`; `2026-05-24-hook-layer-observe-only.md`
- Issues: #1599 · #1601 · #1473 · #1258 · #1716 · #1727 · #1647 · #1708 · #1692 · #1679

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` is authored by `/plan` into this same document.

---

## Constraints

Anchored to `.exarchos/invariants.md` (always-load tier, plus reference-only entries that bind here).

**Directly governing:** **INV-1** (append-only log is SoT; projections are pure folds — level-triggering applies to *sensing*, never to state) · **INV-2** (facade equivalence) · **INV-6** (substrate guarantees are workflow-agnostic — the invariant the current event catalog violates) · **INV-7** (single-writer appends) · **INV-8** (idempotency at the boundary) · **INV-12** (`next_actions` as affordance) · **INV-15** (no daemon) · **INV-5a** (input ergonomics).

**Reference-only but binding:** **INV-9** (violated today — Wave 0 precedes everything) · **INV-13** (intent/result pairs) · **INV-17** (names `outputSchema` totality as the precondition for equivalence-by-construction).

**Two always-load invariants carry text this program falsifies** — amended by DR-23, not silently outgrown:

- **INV-5b** *(output-contract)* asserts *"long-running ops use Tasks (SEP-1686) not NDJSON."* MCP `2026-07-28` moves Tasks out of core into an extension and deletes `tasks/result` and `tasks/list`. It further asserts the carrier is *"structuredContent with a registered outputSchema per action"* — true in presence, ~90% vacuous in substance (DR-4).
- **INV-11** *(posture-declared-capabilities)* asserts *"The MCP initialize handshake declares the runtime half… handshake-authoritative."* The revision **deletes the handshake**. The principle (unrepresentable-by-construction) survives and strengthens; the named mechanism does not.

**Out of scope:** harness hook wiring; filesystem write confinement (#1601 — not an Exarchos-owned chokepoint); the admission gate on judgment events (sibling spec); MCP Apps for `exarchos_view` (needs its own ADR against the no-GUI envelope); remote/HTTP MCP surface (v3.2 DKG).

---

## Design & Rationale

### Problem Statement

Exarchos declares more contracts than it binds. Across four independent boundaries, the same defect appears: **a declaration exists, is enforced, and cannot fail.**

1. **The event registry records authorship, not reliability.** `source: 'auto' | 'model'` says who composes the payload, not what the emission is welded to. All <!-- measured: event-types-total -->171<!-- /measured --> types require *some* tool call. The 25 `model` types are report-coupled — a dedicated append accomplishing nothing else, therefore the first thing dropped under context pressure.
2. **`outputSchema` records presence, not substance.** The field is required at the interface boundary and `validateAction` fails the import without it — but **<!-- measured: output-schema-vacuous -->111<!-- /measured --> of <!-- measured: output-schema-total -->123<!-- /measured --> declarations are `EnvelopeSchema(z.unknown())`**. INV-17 names `outputSchema` totality as *the precondition that makes facade equivalence hold by construction*; a vacuous schema satisfies totality trivially, because it is total over all shapes including wrong ones. For nine actions in ten, INV-2's "schema-checked in addition to byte-checked" is byte-checked plus a tautology.
3. **The CLI's single-authority idiom exists and has decayed.** Flags derive from each action's Zod schema — and **1,613 lines of `adapters/cli.ts` carry 14 `.command(...)` call sites, of which only 3 are derivation loops and <!-- measured: cli-handwritten-literals -->11<!-- /measured --> are hand-written literals**: `doctor`, `version`, `feedback`, `schema`, `topology`, `emissions`, `mcp`, `onboard`, `init`, `merge-orchestrate`, `install-skills`. `merge_orchestrate` is declared twice — as a registered action *and* by hand. (Rev 1 claimed it was the only `posture: 'shared-mutating'` action, quoting a **stale JSDoc**; there are four — `merge_orchestrate`, `prune_worktrees`, `serialize_merge`, `cutover_decide`. The duplication is the finding; the uniqueness was never true.) `cli-vocab-guard` already walks the real composition root — but its policy is a *banned-vocabulary set*, so a hand-written command with good vocabulary passes. The guard that looks like it would catch this is measuring a different property. **And so did rev 1's replacement:** "traces to a registry declaration" does not discriminate either, because the hand-written commands call `addFlagsFromSchema` against the registry action. Only a source-level check separates derived from hand-written (G1, rev 2).
4. **Detection exists and is discarded.** `_eventHints.missing` is computed (`check-event-emissions.ts:36-79`) and consumed only by the CLI pretty-printer (`cli-format.ts:96-103`). `hsm-transition-guard.ts` has no predicate of the form "expected event was never emitted."

Two structural aggravators: the catalog is **workflow-overfitted** (`PHASE_EXPECTED_EVENTS` keyed by literal built-in phase names, which INV-6 forbids and #1258 makes untenable), and **INV-2's quantifier leaks** — it ranges over "the same DispatchContext **+ arguments**", and both halves carry divergence its adapter-focused audit cannot see (three optional capability adapters; a `task: { ttl }` key only the MCP facade can send).

This is not an instruction-quality problem. Per the superseded spec's discovery pass, measured per-step process-instruction compliance for frontier models is near zero for steps that are not instrumentally required. **Correctness currently depends on someone being careful.** PDD's objective is to make the class unwritable.

> ### The measure-the-wrong-property pattern *(recorded rev 4.4 — four occurrences, three found by implementation)*
>
> The Problem Statement names four boundaries where a declaration exists, is enforced, and cannot fail. Implementing Wave 1 surfaced a **second, sharper form of the same disease: the enforcement instruments themselves measure a property adjacent to the one they name.** Every instance is a text-shaped proxy standing in for a structural fact:
>
> | Instrument | Names | Actually measures | Found by |
> |---|---|---|---|
> | `cli-vocab-guard` | derivation | **vocabulary** | design (DR-5) |
> | `outputSchema` | substance | **presence** | design (DR-4) |
> | `count-casts.ts` | type assertions | **the text "as"** — prose and namespace imports | task 057 → 058 |
> | `check-measured-premises.mjs` `sdkImportFiles` | import sites | **substring occurrence** — comment mentions | task 052 → 061 |
| `check-measured-premises.mjs` `blankComments` | call sites | **text outside comments** — string/template contents still counted | task 061 (latent) |
| `sdk-generation-seam.ts` `collectSdkImports` | import sites | **regex specifier match** — template-literal fixtures counted | task 061 → 062 |

> **Six now, and the last one had teeth.** `collectSdkImports` feeds DR-26's `bypassSiteCount`, whose denominator therefore includes ten fixture strings that can never be migrated — so task 053's migration gate **could not have reached zero**. Note also that each successive fix was found by the *previous* fix's author looking one rung down: 057→058 (cast census), 052→061 (premise scanner), 061→062 (seam scanner). The pattern is not "one bad guard"; it is that **a text proxy tends to be built on another text proxy**, and finding one is a reason to look beneath it rather than to declare the class closed.
>
> The last two were found **only by running the plan**, and the fourth lives inside DR-27 — *the instrument built to catch unbound claims contained one.* That is not irony to be noted and moved past; it is the load-bearing evidence for DR-27's own necessity, and the reason its acceptance criteria require a kill fixture rather than a green run.
>
> **The generalisation, for every guard this program ships and every one it later adds:** a guard whose subject is *source text* is measuring a proxy. Ask what structural fact the text stands for, then measure that fact — parse, resolve, or type it. Where a text proxy is genuinely the cheapest sound option, the guard must carry a **kill fixture that distinguishes the proxy from the property** (a comment mentioning the thing; a namespace import; a named alias), because that fixture is the only evidence the proxy has not silently decoupled.

> ### A closed union with no data form cannot be enforced at a boundary *(recorded rev 4.6 — task 008)*
>
> Task 009 closed `SubstrateRationale`, `ReconcilerId`, `GroundTruthSource` and the gate classes as **types only**, deliberately and for a good reason: a free-text `rationale` would be a universal escape hatch re-admitting report-coupling under a new name. Task 008, its first consumer, then discovered the consequence: **a type cannot be iterated at runtime**, so the only guard writable against a type-only closed union is `typeof rationale === 'string'` — which accepts `{ tier: 'substrate', rationale: 'because' }` and re-opens the very hatch the closure existed to shut.
>
> The closure was real at the compile boundary and **vacuous at the trust boundary**, which is where `withSubject`, deserialization, and every future `#1258` round-trip actually live.
>
> **The rule this program adopts:** a closed vocabulary that any consumer must validate at runtime ships **both** a type and a data form, bound to each other by a **mutual-assignability proof** — so neither can drift, and deleting a member from either fails `tsc`. A type without its data form is a compile-time-only guarantee that silently degrades to a string check at the first boundary that needs it.
>
> This generalises past events. Every task in this program that ships a closed vocabulary — DR-6's boundary ids, DR-10's meta-model, DR-14's postures — inherits it, and the cost is small: four tuples and four proofs, paid once at the declaration site instead of re-litigated at every consumer.

### Chosen Approach

**Every contract surface declares exactly one authority, every other representation is mechanically bound to it, and the declaration is shaped as the IR it will become.**

Three moves, in that order:

**1. Bind before building (Wave 1).** PDD's decision table is unambiguous: *"The single-authority pattern exists but later code bypasses it → add the guard that makes derivation mandatory **before** adding another instance of the pattern."* Wave 1 therefore ships **guards, not architecture** — a derivation guard, a non-vacuity ratchet, the coupling union, and an authority-topology census. Each has a **kill fixture already present in the codebase**, so no guard ships unproven.

**2. Assign each obligation to its cheapest sound proof rung.** Construction/generation > types > structural analysis > contract tests > production-path tests > human judgment. This is why the program is not organized around a single mechanism: the event coupling belongs at rung 2 (an unconstructible variant), the CLI surface at rung 1 (generated), the emission contract at rung 3 (census), and reconciliation at rung 5 (production-path). Picking one spine would force claims onto the wrong rung.

**3. Shape every declaration as the IR (#1258).** Per D3, the Workflow Builder IR is the declared long-term home and `registerEventType` is the bridge. This program generalizes that from events to the whole contract surface: **the registry is the IR's current storage, not a competing authority.** #1258 then relocates the declaration site without re-opening a single class this program closes.

**No new enforcement instrument.** Every guard extends a shipped mechanism — `cli-vocab-guard`'s `buildCli` walk, the census/ratchet vocabulary (`vcs-ownership.ts`, `adapter-ownership-seam.ts`, `effect-port-seam.ts`, `layer-boundaries-seam.ts`), the P04-01 effect ledger's occurrence scanner, `idempotency_claims`, the dispatch interceptor chain, the shipped contract compiler. If a guard required a novel instrument, that would be evidence it was the wrong design.

**Prerequisite (Wave 0, outside the DR space).** The 2026-08-04 wiring audit found `makeArtifactGuard` accepts any non-null, `task_complete`'s only path through is an agent-supplied `evidenceBypass`, and three modules call `executeTransition` directly — **INV-9 is violated today**. P01-03, P02-03, P06-05 close first. A correct contract feeding a bypassable guard changes nothing.

### Authority topology

PDD deliverable 2. Representation counts are measured, not estimated. **More than one authoritative representation is a finding regardless of whether the copies currently agree.**

| Boundary | Representations | Authoritative | Mechanically bound? | Finding |
|---|---:|---|---|---|
| **Action contract** | registry descriptor; 10 derived consumers (composites ×4, launcher verb, docs generator, description-budget, rehydration fingerprint, CLI, MCP) | registry | Yes for the 10 | **Holds.** The idiom is real — which is what makes the bypasses below findings rather than noise. |
| **CLI surface** | registry-derived tree; **14 hand-written `.command(...)`** | *contested* | **No** | **2 authorities.** `cli-vocab-guard` binds vocabulary, not derivation. `merge_orchestrate` declared twice. → **G1** |
| **Response shape** | `outputSchema` (118); `Envelope<T>` type; the runtime payload | `outputSchema` nominally | **No** — <!-- measured: output-schema-vacuous -->111<!-- /measured --> vacuous | Authority exists but asserts nothing. → **G2** |
| **Event catalog** | `EVENT_EMISSION_REGISTRY`; `autoEmits` rows (`z.string()`); `PHASE_EXPECTED_EVENTS` (hand-maintained); skill prose (#1716) | registry nominally | **No** | 4 representations, none bound. → **G3, G5, DR-10, DR-16** |
| **Effect ↔ event** | `EffectPlan`; the append site | *none* | **No** | `effect-carrier.ts` references no event store. → **G4/DR-7** |
| **Capability/posture** | agent-spec YAML; `posture-mapping.ts`; MCP handshake; INV-11 text; **delegate skill prose** *(added rev 4.1)* | handshake ("handshake-authoritative") | Partially | **Authority is being deleted** by the spec revision. **5 representations** — task 048's docs added the fifth, and it is unbound. → **DR-14, DR-23, DR-25** |
| **Phase sequencing** | HSM topology; `PHASE_EXPECTED_EVENTS`; playbooks | HSM guard (INV-9) | **Bypassed today** | 3 direct `executeTransition` callers. → **Wave 0** |
| **SDK generation** *(new in rev 4; corrected rev 4.3; **CLOSED by task 053, rev 4.11**)* | `sdk/seam.ts` — the sole importer. Bypassing files outside it: <!-- measured: sdk-import-sites -->0<!-- /measured --> across <!-- measured: sdk-import-directories -->0<!-- /measured --> directories (<!-- measured: sdk-import-production-files -->0<!-- /measured --> non-test) | **`sdk/seam.ts`** ("owned seam") | **Yes** | **ONE authority, as of task 053.** Rev 3 omitted this row entirely while DR-0 depended on it; rev 4 added it claiming both generations are "imported directly", which task 024 measured as **false**. Task 053 migrated the whole backlog — **22 → 0 files, 9 → 0 directories, 10 → 0 non-test; 42 → 0 import sites** — onto the owned seam, and `SDK_SEAM_BOUNDARY` in `architecture/layer-boundaries-seam.ts` now rejects a direct SDK import with **zero exemptions**. **This drop is REAL migration work, not an instrument change** — unlike the 40 → 22 correction task 061 made, which moved no code. v2 remains **installed with zero import sites**: its consumption is task 049's, deliberately held until the seam was the only door. → **G6 / DR-26** |

> **Why the SDK row was missing, and why that matters.** Rev 3 asserted a compile-time guarantee (DR-0's error-path criterion) over a boundary it had not entered in its own topology table. Had the boundary been modelled, the census would have asked "what is the authority?" and the answer — *neither generation; both are imported directly* — would have exposed the criterion as unsatisfiable before it was written. **A boundary absent from the topology is the one place an unbound representation can hide from the census designed to find it**, which is why DR-6's totality check must range over a boundary list that is itself derived, not hand-maintained (see DR-26 acceptance criteria).

### Guards

PDD deliverable 1, specified per §3a. Ranked by findings eliminated. **Every guard names a kill fixture that exists in the codebase today** — a guard with no current failing subject has not been shown to work.

#### G1 — CLI derivation guard *(new policy on an existing mechanism)*

> **Redesigned in rev 2.** Rev 1's policy — "every command traces to a registry declaration" — **passed its own kill fixture**. The hand-written `merge-orchestrate`, `doctor` and `onboard` all call `addFlagsFromSchema(cmd, action.schema, …)` against the registry action, so they genuinely *do* trace to a registry declaration; and a Commander-tree walk records no provenance, so the mechanism could not observe hand-written-vs-derived at all. It would have shipped with a green self-test and its real subject surviving — the exact defect it was written to fix.

| Field | Value |
|---|---|
| **Policy** | The CLI composition root contains **no literal `.command('<name>')` call**. Every command is registered through a derivation helper (`registerActionCommand`, the composite-tool loop, the harness loop) that takes its name from a registry declaration. Policy is **data**: a source-path list plus an allowlist file, not prose in a test body. |
| **Mechanism** | **Rung 3, source-level.** Parse `servers/exarchos-mcp/src/adapters/cli.ts` and assert every `.command(` argument is an identifier expression, not a string literal. This discriminates exactly where a tree-walk cannot, because provenance is visible in the *source* and erased in the *built tree*. It also needs no `buildCli` resolution, so — unlike the existing vocab guard — it carries **no `bun:sqlite` dependency** and can host in the zero-dep unfiltered job (see Protected path). Complements, and does not replace, `cli-vocab-guard`'s banned-vocabulary predicate. |
| **Kill fixture** | The **<!-- measured: cli-handwritten-literals -->11<!-- /measured --> hand-written literals on the landing branch** — `doctor`, `version`, `feedback`, `schema`, `topology`, `emissions`, `mcp`, `onboard`, `init`, `merge-orchestrate`, `install-skills` (`cli.ts:399,471,506,555,592,611,622,662,734,772,837`). The guard reports all <!-- measured: cli-handwritten-literals -->11<!-- /measured --> on introduction. |
| **Self-test** | Two, because detection alone is insufficient. (1) Seed a 12th literal → guard must fail. (2) **Non-empty denominator:** the guard must fail if it parses zero `.command(` sites at all, so a moved/renamed file or a parse error cannot pass as a clean run. |
| **Protected path** | CI, **unfiltered**, on the **deps tail of the `grep-gates` job** — *corrected rev 4.5*. Rev 1 asserted an unfiltered path for a `buildCli`-resolving mechanism that ci.yml documents as needing Bun + MCP deps, and therefore hosts in the path-filtered `test-mcp` job — i.e. rev 1 specified exactly the #1711 skipped-as-passed configuration it cited #1711 to avoid. The source-parse mechanism removes that dependency. **But "zero-dep `grep-gates` host" was itself wrong**, and the repo's own [`docs/guides/ci-gate-hosting.md`](../guides/ci-gate-hosting.md) forbids the phrase in a heading: *"`grep-gates` has two identities — never call it 'zero-dependency'."* The zero-dep **prefix** runs with no `npm ci` at all; a parser-based guard needs `typescript` resolvable and therefore rides the **deps tail**. The `bun:sqlite` freedom is real and still the point — it buys plain `node`/`tsx` instead of Bun, not zero dependencies. |
| **Exceptions** | The <!-- measured: cli-handwritten-literals -->11<!-- /measured --> literals enter an allowlist keyed by command name, each with an owner and an **ISO expiry date** (not a "wave-scoped" label, which is not mechanically evaluable). Entries may only be removed. **`merge-orchestrate` is excluded from the allowlist** — it is the kill fixture and must remain rejected; rev 1 allowlisted it, neutralizing the very rejection DR-5 requires. Its hand-written command is deleted in DR-5, not exempted. |

#### G2 — `outputSchema` non-vacuity ratchet *(new policy on an existing mechanism)*

| Field | Value |
|---|---|
| **Policy** | `EnvelopeSchema(z.unknown())` is a **finding**, not a pass. Count may only decrease; new actions may not construct it. |
| **Mechanism** | Registry-enumeration snapshot + two-way ratchet, reusing the type-debt ratchet idiom already in CI. |
| **Kill fixture** | The <!-- measured: output-schema-vacuous -->111<!-- /measured --> current vacuous declarations — the ratchet's initial value, and its proof of a live subject. |
| **Self-test** | Add a new action declaring `EnvelopeSchema(z.unknown())`; CI must fail. |
| **Protected path** | CI, unfiltered. |
| **Exceptions** | Allowlist keyed by action id, owner, expiry. Entries expire per wave; expiry is enforced, not advisory. |

#### G3 — Event coupling union *(absorbed: superseded DR-1; promoted to a full §3a table in rev 2)*

| Field | Value |
|---|---|
| **Policy** | Every registered event declares one of five tiers. **Report-coupling has no variant**, so the class is unwritable at rung 2 rather than detected at rung 4. The permitted report-coupled set is an allowlist file with owner + expiry, not a count in prose. |
| **Mechanism** | Discriminated union in `event-store/event-registration.ts` (rung 2, `tsc`) plus a census over the registry (rung 3) reusing the existing ratchet error vocabulary. |
| **Kill fixture** | The **<!-- measured: report-coupled-events -->25<!-- /measured --> currently report-coupled types** on the landing branch (`source: 'model'` in `EVENT_EMISSION_REGISTRY`). The census reports <!-- measured: report-coupled-events -->25<!-- /measured --> on introduction. *Bound to a derivation by task 013* — it was bare prose until then, which is the DR-27 gap; `censusReportCoupling()` now derives it from the DR-2 tier union rather than from the `source` column this row cites, and task 013 confirmed the two authorities agree on the SET, not merely the count. |
| **Self-test** | (1) A seeded disagreement between declared tier and derived `EventEmissionSource` fails. (2) **Non-empty denominator:** a census that enumerates zero registrations fails rather than passing clean. |
| **Protected path** | CI, unfiltered. The census reads the registry module; if that import requires MCP deps, it hosts alongside G2 in the same lane — the host is named in the task, not left implicit (the rev-1 omission that #1711 punishes). |
| **Exceptions** | `team.spawned` / `team.disbanded` only, each carrying `blockedBy: '#1473'`, an owner, and an ISO expiry. The ratchet permits **monotonic decrease from the introduction value**; the Wave-5 target of 2 is an *exit condition recorded in DR-20*, not a seed in this guard — rev 1 conflated the two. |

#### G4 — Effect ledger bijection *(absorbed: superseded DR-4; promoted to a full §3a table in rev 2)*

| Field | Value |
|---|---|
| **Policy** | Every `EffectPlan` names the event that records it; every T1 event has exactly one **primary** owner. `T` is unreachable without the append having occurred. Ownership is declared data (`role: 'primary' \| 'recovery'`), not inferred. |
| **Mechanism** | Rung 2 — `Committed<T>` makes an uncommitted effect's result type unusable — plus a **boot-time bijection check** over the ledger. Extends the shipped `core/effect-carrier.ts` (P04-01) and `architecture/effect-ledger.ts`. |
| **Kill fixture** | **Re-scoped in rev 2.** Rev 1 named `VcsMutationOwner` as an uncoupled subject; on the landing branch it is the *reference implementation* of the coupling (it appends `vcs.requested` before the effect and `vcs.executed`/`vcs.compensated` after). The real failing subjects are the effect call sites that are **not** routed through `VcsMutationOwner` — enumerated by the boot-time bijection on introduction, and recorded as the seed. **A task must publish that enumeration before G4 is declared specified** (see DR-7); a guard whose failing subject is asserted rather than measured is what rev 1 got wrong. |
| **Self-test** | (1) Seed a second primary producer for one event → boot fails. (2) Seed an effect with no `emits` → compile fails. (3) Non-empty denominator: a bijection over zero plans fails. |
| **Protected path** | Boot-time, so it blocks **server start and every CI job that boots the server** — not a lint lane. Named explicitly because a boot check that only runs in one job is skipped-as-passed everywhere else. |
| **Exceptions** | `role: 'recovery'` producers are exempt from the single-primary rule **but not from coupling**; each recovery producer is recorded with an owner and expiry. Rev 1 granted this escape hatch in the obligation map with no owner/expiry record. |

#### G5 — Authority-topology census *(new — generalizes superseded DR-3/DR-11)*

| Field | Value |
|---|---|
| **Policy** | Every declared boundary names exactly one authority; every other representation names what binds it. Unbound representation, or >1 authority, fails closure. |
| **Mechanism** | Extend `contract/reachability/graph.ts`: `REACHABILITY_HOPS` gains `event` + `consumer`; `HOP_AUTHORITIES` for both is `'runtime'`, never `'self'` (the co-located prohibition test must still pass). |
| **Kill fixture** | The CLI-surface row above (2 authorities) and the event-catalog row (4 unbound representations). Both fail on day one. |
| **Self-test** | `kill-fixtures.test.ts` entry per new hop: mutating the real upstream authority drops the census below 100%. |
| **Protected path** | CI, unfiltered. **Per-row enforcement, not wholesale** — see below. |
| **Exceptions** | No blanket allowlist. Each boundary row carries an explicit `enforceFrom` wave and an owner; a row with no `enforceFrom` fails the census's own totality check. |

> **Enforcement schedule reconciled in rev 3.** Rev 2 stated G5's enforcement date **three contradictory ways**: "flipped to blocking within the same wave" (Technical Design), "Census is observe-only until Wave 4" (obligation map), and `Wave1Exit_AllFiveGuards_BlockOnSeededViolation` (task 027). Those cannot all hold, because G5's own kill fixtures are rows whose authority is not remediated until Waves 2–5 — the CLI-surface row reaches one authority only at DR-19, the event-catalog row at DR-16/DR-20, the effect↔event row at DR-7, and the capability row at DR-14. Flipping wholesale at Wave 1 exit with no allowlist would red-line CI for four waves.
>
> **The single rule:** G5 ships in Wave 1 **observe-only**, and each boundary row flips to blocking **at the wave that remediates it**, declared as `enforceFrom` data on the row itself:
>
> **⚠️ DR-20 will NOT discharge the phase-sequencing row — discovered rev 4.9 by task 026's sensitivity control.** The control was run to prove the event-catalog row's failure is real, and it did not go clean, which is how the scoping error surfaced. `PHASE_EXPECTED_EVENTS` is carried by **two** rows. Deriving it for one leaves the other's claim behind, and task 025's cross-row tooth fires `binding | ambiguous` on **both** carriers — that tooth has now fired against a real change rather than a fixture. Aligning both carriers closes `event-catalog`, and `phase-sequencing` then reports `binding | stale-exception`, because **binding `PHASE_EXPECTED_EVENTS` to `EVENT_EMISSION_REGISTRY` does not bind it to the HSM guard.** Deriving the event *names* says nothing about whether the phase *keys* track the HSM phase set. The row's Wave-1 `enforceFrom` therefore needs its own remediation, which no current DR owns.
>
> | Row | `enforceFrom` |
> |---|---|
> | CLI surface | Wave 4 (DR-19 retires the last literal) |
> | Response shape | Wave 1 (G2 ratchet is live immediately) |
> | Event catalog | Wave 5 (DR-20 completes disposition) |
> | Effect ↔ event | Wave 2 (DR-7 bijection) |
> | Capability / posture | Wave 3 (DR-14) |
> | Phase sequencing | Wave 1 (already single-authority on the landing branch) |
>
> Task 027's exit assertion narrows accordingly: **all five guards are *live*, and every row whose `enforceFrom` is Wave 1 blocks on a seeded violation.** "Observe-only" is a recorded, per-row, expiring state — not an indefinite one, which is what the obligation map's blanket wording would have permitted.

### Decisions taken

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Absorb the taxonomy spec rather than layer on it** | Both inputs are one defect class. Two programs would define G1–G5 twice and maintain two ratchet sets. The taxonomy spec is unfiled, so nothing is stranded. |
| **D2** | **Registry is the IR's current storage, not a competing authority** | Per D3 of the superseded spec, the IR is the destination. Every declaration this program adds is IR-shaped, so #1258 **relocates** the declaration site rather than re-binding every representation. **Re-anchored in rev 3:** rev 2 named `registerEventType` as the bridge. It is not — it *throws* on built-in names (`schemas.ts:507`, `BUILT_IN_EVENT_TYPES.has(name)`), so it carries **zero of the 170 built-in types** and accepts only 3 of the 5 source values. The authority for built-ins is the static `EventTypes` array plus the `EVENT_EMISSION_REGISTRY` literal; **the declaration envelope wraps those**, and `registerEventType` is a second, smaller consumer for runtime-registered custom types. Binding is written against the *declaration accessor*, never the storage shape. |
| **D3** | **Wave 1 ships guards, not architecture** | PDD: add the guard that makes derivation mandatory *before* another instance of the pattern. Another correct instance without enforcement decays exactly as the first did. |
| **D4** | **Each obligation lands on its cheapest sound rung; no single spine** | Coupling → rung 2; CLI surface → rung 1; emission contract → rung 3; reconciliation → rung 5. A single-mechanism design forces claims onto the wrong rung (see Alternatives B and C). |
| **D5** | **Adopt MRTR before the era cutover** | The SDK's legacy shim runs an `inputRequired()` handler unchanged on 2025-era connections, so the refactor is not gated on the wire switch — and it converts elicitation from a context capability into a result shape, closing an INV-2 divergence early. |
| **D6** | **Mint the MRTR resumption handle in the core, from the event store** | The spec's `requestState` exists because stateless HTTP servers have nowhere to put resumption state. Exarchos owns a database. Core mints the handle; the MCP facade wraps it in the SDK's signed codec; the CLI passes it as an ordinary argument. One core contract, two renderings — and no reserved-flag concept needed in the generator. |
| **D7** | **Delete duplicate event types in Wave 5, frozen for replay** | Inherited. Follows the shipped `merge.rollback` `retired` precedent. Deletion removes the ability to *append*, never to *read*. |
| **D8** | **`EmissionVerifier` hard-fails in CI/dev; telemetry in production** | Inherited. A contract violation is an **Exarchos bug, not agent misbehavior** — the contract says the *handler* emits, so the agent has no action that would make it land. |
| **D9** | **Amend INV-5b and INV-11 rather than outgrow them** | Their text names mechanisms the spec revision deletes. An invariant whose text is false is worse than none — it is an authority asserting something untrue. Authored through `/exarchos:invariants` (DR-23). |

---

## Requirements

Provenance is marked per DR: **[T-n]** = absorbed from superseded taxonomy DR-n; **[MC-n]** = from the MCP composition report; **[new]** = introduced here.

**Wave 1 — Authority: bind before building**

### DR-0: SDK v1→v2 package split, ahead of every consumer **[new in rev 2 — MC-1]**

Rev 1 omitted the split entirely while three of its DRs depended on v2-only APIs, producing a **circular schedule**: DR-9 needs `createRequestStateCodec` and `inputRequired()`, DR-14 needs `ctx.mcpReq.envelope`, and DR-9's parity proof needs `serveStdio` as a child process — all from `@modelcontextprotocol/server`. Rev 1 scheduled the split inside DR-22 (Wave 5), whose task depends on DR-9 and DR-14. The source migration evaluation sequences it the other way and explicitly calls it *"mechanical, do first… safe to land independently."*

**Acceptance criteria:**
- The v2 packages (`@modelcontextprotocol/{core,server}`) are added **alongside** the pinned v1 `@modelcontextprotocol/sdk` — they have different names and coexist, so this is additive and independently revertible.
- Sources migrate directory-by-directory; the v1 dependency is removed only when nothing imports it (`grep -rn "@modelcontextprotocol/sdk"` returns zero non-vendor hits).
- **Nothing changes on the wire — amended rev 4.7, scoped to `tools/*`.** v2 speaks the 2025-era protocol until an explicit era opt-in, so this DR lands with byte-identical `tools/list` and `tools/call` output, pinned by the existing golden fixtures. **`tasks/*` is now an explicit, decided exception** (see below); the criterion holds for every other surface.

> **D10 — `tasks/*` is not served on v2. Operator decision, 2026-08-07.** Task 051 measured the situation directly rather than inferring it: a live v2 `McpServer` answers **all four** of `tasks/{get,result,list,cancel}` with `-32601` while `ping` on the same connection answers normally — v2 ships **no server-side Tasks runtime at all**. Worse for safety, `new McpServer(info, { taskStore })` on v2 is **accepted silently**: no throw, no warning, the key is dropped. v2's own protocol types carry `@deprecated … wire vocabulary with no SDK runtime; kept importable for interoperability only`.
>
> So the naive migration produces a server that is **fully persistent and quietly dark on the wire** — a silent degradation, which is the failure mode this whole program exists to make unreachable.
>
> **The decision: accept the wire loss.** `tasks/*` stays unserved on v2. Rationale: the MCP `2026-07-28` revision **deletes `tasks/result` and `tasks/list`** and moves the feature into an extension, so serving them now is building toward a removed surface. Task lifecycle does not depend on them — the CLI `--follow` loop and dispatch's Tasks-augmented branch drive the store **directly** and never went through the SDK. The two options that were rejected: serving `get`+`cancel` only (no evidence of an external client polling — task 051 looked and found none), and serving all four (ships surface the spec is deleting).
>
> **Accepted cost, stated so it is not discovered later:** an MCP client that polls `tasks/get` breaks on migration. The rejection must be a **typed `-32601` from a surface we chose not to serve, not a silent no-op** — the same distinction DR-25 draws for dispatch. **DR-23 carries the INV-5b amendment** this implies; the two are companions, and INV-5b's "long-running ops use Tasks (SEP-1686)" text is falsified by the same measurement.
>
> **Still open, and owned by task 053:** two deleted-surface import sites remain — `cli/follow-loop.ts:47` (`isTerminal` → `isTaskTerminal` from `task-store/port.js`, 2 call sites) and `dispatch/tasks-augmented.ts:58` (`CreateTaskOptions` → `CreateTaskParams`). Until those land, **DR-0's source migration is not fully unblocked**: the store is, the follow-loop and the dispatch branch are not.
- `src/__tests__/sdk-pin-policy.test.ts` is retargeted to the v2 package names, **keeping the exact-pin policy** (its rationale — opt into surface changes deliberately — is strengthened, not weakened, by this program).
- The `patch-package` patch is evaluated against v2 and either dropped or re-based, with `tools-list-2020-12.test.ts` retained as a conformance test either way.
- ~~**Error-path criterion:** a partially-migrated tree (some modules on v1, some on v2) must fail typecheck rather than resolve two copies of the protocol types — a `InMemoryTransport`-style linked pair drawn from different packages is a documented v2 footgun and is rejected at compile time.~~
- **Error-path criterion — FALSIFIED in rev 4, superseded by DR-26.** The criterion above was **measured and does not hold**, in any mixing direction. Both generations declare a *structural* `Transport`; TypeScript has no notion of nominal package identity; `tsc --strict` therefore accepts v1-into-v2, v2-into-v1, **and** the cross-package `InMemoryTransport` linked pair the criterion named as its kill fixture. The failure mode is the dangerous one: a partially-migrated tree **compiles clean and fails at runtime** as a hang or an empty result, never as an error.
  - **This is not a criterion to weaken — it is a criterion assigned to the wrong subject.** You cannot brand a third party's structural type. You *can* brand your own seam's handle type and forbid direct SDK imports, which restores the rung-2 guarantee exactly as originally claimed. That is **DR-26**.
  - **Interim state (shipped in task 049):** `architecture/sdk-generation-seam.ts` rejects any module importing both generations, at rung 3. Its test compiles the mixed fixture with `tsc` and pins the *measured* acceptance, so if a future release makes the two nominally incompatible the expectation flips and the lint retires **on evidence** rather than on belief.
  - **Lesson recorded, not discarded:** rev 3 asserted a proof rung without probing whether the subject could carry it. **A proof rung is a claim about the subject, and is falsifiable — probe it before assigning an obligation to it.** DR-27 generalizes this beyond counts to rungs.

**Sequencing:** Wave 1, before DR-9, DR-14 and DR-22. Zero wire change means it carries no era risk and unblocks three later DRs.

**Wave 1 batch-1 status (measured 2026-08-07):** the additive package split **landed** — v2 `core`/`server` at exact `2.0.0` alongside v1 `sdk@1.29.0`, lockfile insertions-only, `tools/list` pinned byte-identical by a committed golden. **The source migration is blocked and DR-0 is therefore partial:** v2 `2.0.0` **deleted the experimental Tasks store seam** — no `ServerOptions.taskStore`, and `TaskStore` / `CreateTaskOptions` / `isTerminal` have **zero matches anywhere in either v2 package**. `adapters/mcp.ts` constructs `new McpServer(…, { taskStore })` against `EventSourcedTaskStore` (#1272/#1273) and `cli.ts` calls `connect()` on it, so both adapters need a **replacement seam designed first**. The Tasks *protocol types* survive; only the server-side store wiring is gone. Tracked as task 051.

### DR-1: IR-shaped declaration envelope **[new — D2]**

Every declaration this program introduces (event tier, action contract, CLI verb) is defined as an IR-shaped record carried through the existing seam, so #1258 relocates the declaration site rather than re-binding representations.

**Acceptance criteria:**
- A single `Declaration<K>` envelope type carries `kind`, `id`, `authority`, `boundTo[]` — **and `subject` (ratified in rev 4, see below)**; event/action/CLI-verb declarations are instances, not parallel shapes.

> **`subject` ratified as the fifth field (rev 4).** Task 005 shipped `Declaration<K, S = unknown>` with a fifth `subject` field and flagged the deviation for sign-off. **Accepted, and the DR is amended rather than the implementation.** The four declared fields carry *identity* (`kind`, `id`) and *topology* (`authority`, `boundTo[]`) but not **what was declared** — so tasks 007/008 would have had to reach past the seam into registry storage to recover it, re-opening precisely the coupling DR-1 exists to close. A four-field envelope would have made the seam rule (task 006) unenforceable in practice.
>
> Two shape decisions are load-bearing and are ratified with it:
> - **`authority` is a single field, not an array.** This makes "one boundary, two authorities" — the G1/G5 defect class — **unrepresentable inside a declaration**. It can only appear as two declarations claiming one subject, which is a *census-level* finding for DR-6, not a malformed record. The defect is pushed to the layer that can see it.
> - **`subject` is a defaulted type parameter, not a per-kind union.** This keeps `Declaration<'event'>` a **supertype** of `Declaration<'event', EventRegistration>`, so a task-006 accessor typed against the widened form keeps compiling as later waves narrow it. **Open refinement:** a kind-indexed subject map (`DeclarationSubjects[K]`) would be more precise, trading that variance for exactness. Task 006 is the first real consumer and is the right place to decide; it is **not** deferred indefinitely — 006 must record the decision either way.
- Declarations are consumed **only** through the seam accessor; a direct read of registry storage from a consumer fails `layer-boundaries-seam.ts`.
- **Relocation proof — re-specified in rev 3.** Rev 2's version was both mis-sequenced and unfalsifiable: it sat in Wave 1a but asserted over G1–G5, four of which do not exist yet (G4 is Wave 2), and its `Relocation_RequiresNoConsumerEdit` criterion asserted "zero diff across the 10 consumers" from inside a runtime fixture that never edits source — true by construction, so it could not fail.
  - **Mechanism (rung 2, not rung 5):** consumers may import **only** the declaration accessor's type, never the storage module. Relocation is then proven by a *compile-time* substitution — swap the storage implementation behind the accessor and require `tsc` to pass with no consumer change. A cheaper sound layer replaces the integration fixture, per PDD's proof order.
  - **Falsifier:** seed a consumer that imports the storage module directly; the substitution must fail to compile. This is the assertion rev 2 lacked — the proof now has a way to be wrong.
  - **Sequencing:** the compile-time half lands in Wave 1a (it needs only tasks 005–006). The *guard-suite* half — "all live guards still pass after substitution" — moves to Wave 1 exit (task 027), where the guards actually exist, and re-runs at each later wave exit as guards are added.
- The envelope is additive: existing registrations compile untouched.

### DR-2: Tiered, coupling-typed event registration **[T-1]**

`EventRegistration` is a discriminated union in which report-coupling is **not a constructible variant**.

> **Corrected in rev 3 — coupling and lifecycle are two axes, not one.** Rev 2 required `EventEmissionSource` to be *derived from tier*. That is unsatisfiable: the shipped union is `'auto' | 'model' | 'hook' | 'planned' | 'retired'` (`schemas.ts:564`), and `planned` (schema exists, not yet emitted) and `retired` (schema exists, no longer emitted) are **lifecycle states orthogonal to coupling** — no total function tier→source can produce them, so no tier assignment could reproduce the current registry. Confirming the split: `registerEventType` accepts only `'auto' | 'model' | 'hook'`, so the two lifecycle values are not even registrable through the runtime seam.

```ts
type EventRegistration = {
  lifecycle: 'active' | 'planned' | 'retired';   // orthogonal axis
} & (
  | { tier: 'substrate';      rationale: SubstrateRationale }
  | { tier: 'capability';     provider: EffectProviderId; consumedBy: ConsumerId[] }
  | { tier: 'observation';    reconciler: ReconcilerId; groundTruth: GroundTruthSource }
  | { tier: 'judgment';       gate: GateClass; contentSchema: z.ZodSchema }
  | { tier: 'workflow-local'; workflow: WorkflowDefinitionId }
);
```

**Acceptance criteria:**
- All <!-- measured: event-types-total -->171<!-- /measured --> existing types carry a tier **and** a lifecycle; the union is exhaustive (`tsc` proves it).
- A registration attempting report-coupling does not compile — there is no variant to construct.
- A `capability` registration naming an unresolvable `EffectProviderId` fails at boot.
- **G3** ratchet seeds from the report-coupled count **derived at guard introduction** (<!-- measured: report-coupled-events -->25<!-- /measured --> on the landing branch) and permits only decrease. The seed is computed, never written as a literal. *Task 013 re-derived it and it held; the seed it landed is a MEMBERSHIP list, which is strictly stronger than "permits only decrease" — a count ceiling is satisfied by swapping one report-coupled type for another, a subset rule is not.*
- **Derivation is total over the emission axis only:** `source ∈ {auto, model, hook}` is derived from tier; `planned`/`retired` are produced by `lifecycle`, not tier. A seeded tier↔source disagreement fails; a `lifecycle: 'retired'` entry is *not* a disagreement.
- **Error-path criterion:** a registration whose `lifecycle` is `planned`/`retired` but which is nonetheless emitted at runtime fails the EmissionVerifier (DR-15) — the lifecycle axis is enforced, not decorative.

### DR-3: Compile-time event-name grammar **[T-2]**

**Acceptance criteria:**
- A `WellFormedEventName` template-literal type rejects malformed names at compile time.
- The grammar census is a two-way ratchet reusing the existing error vocabulary.
- Wired to an **unfiltered** CI path (#1711 — a gate in a path-filtered job is skipped-as-passed on the PRs it polices).

### DR-4: `outputSchema` non-vacuity **[MC-3 — new]**

> **Amended in rev 4 — measured, and the mechanism upgraded from rung 3 to rung 2.** Task 016's census measured **112 vacuous of 122**, not the 109/123 rev 3 asserted, and reclassified the two "HSM typed" declarations as vacuous (`WorkflowUpdateOutputSchema` *is* `EnvelopeSchema(z.unknown())`; `WorkflowTransitionOutputSchema` intersects it with a constraint on `_meta.deprecation` only, leaving `data` as `z.unknown()`). That measurement exposed something rev 3 missed: **`withCappedShape` is the sole constructor of a substantive `outputSchema` — 10 for 10.**
>
> A one-constructor surface does not need a *counting ratchet*. It needs a **constructor restriction**, which is rung 2 and matches this program's own doctrine (DR-2: "report-coupling has no variant"). Rev 3 specified a rung-3 census for a property the type system can carry outright — the same misassignment DR-0 made in the other direction.

**Acceptance criteria (amended rev 4):**
- **Vacuity is unconstructible for new actions.** `ToolAction.outputSchema` accepts only the branded return of `withCappedShape` (or an explicit allowlist entry). A new action declaring `EnvelopeSchema(z.unknown())` **does not compile** — it is not rejected by a guard that must be remembered and run.
- The **<!-- measured: output-schema-vacuous -->111<!-- /measured --> existing vacuous declarations** become an explicit **shrink-only allowlist**, each with an owner and an ISO expiry. Entries may only be removed. The list is seeded **from the census output, derived at introduction — never written as a literal.**
- **G2 is the allowlist-shrink ratchet**, not a count threshold. This is strictly stronger: a threshold permits swapping one vacuous declaration for another, an allowlist does not.
- **Non-empty denominator:** a census enumerating zero declarations **fails**, so a moved module or an import error cannot read as a clean run.
- INV-17's audit treats a vacuous declaration as a **violation of the precondition it names**, not a pass.
- The **<!-- measured: output-schema-substantive -->12<!-- /measured -->** currently-typed declarations — all `withCappedShape`; **there is no second constructor** — are the migration template; the DR-10 worktree surface is the reference implementation.
- **Ordering proof:** a fixture asserts DR-8's fourth envelope state **cannot** be declared satisfied for an action whose `outputSchema` is vacuous — the allowlist and the envelope obligation are wired to the same census, so the <!-- measured: output-schema-vacuous -->111<!-- /measured --> cannot silently absorb the new state.

### DR-5: CLI derivation guard **[MC-1 — new]**

**Acceptance criteria:**
- **G1** ships, extending `cli-vocab-guard`'s `buildCli(ctx)` walk with a derivation predicate.
- `merge-orchestrate`'s hand-written definition is rejected (kill fixture); its registry declaration is the survivor, preserving `posture: 'shared-mutating'` on the single remaining definition.
- The <!-- measured: cli-handwritten-literals -->11<!-- /measured --> hand-written top-level verbs enter an allowlist with per-entry owner and wave-scoped expiry; **the allowlist may only shrink**, enforced by ratchet.
- A seeded hand-written command with clean vocabulary fails the guard (self-test) — proving the guard measures derivation, not vocabulary.

### DR-6: Authority-topology census **[new — generalizes T-3/T-11]**

**Acceptance criteria:**
- **G5** ships; the census enumerates every boundary in the Authority-topology table and asserts one authority + bound representations.
- The CLI-surface and event-catalog rows **fail on introduction** — the census is proven live against real subjects before any remediation lands.
- Two `owner → event` predecessors for one event fails closure (*this is the P02-03 defect*).
- A T1 event whose `consumer` hop is `missing` fails closure (*this is #1716's discipline*).

**Wave 2 — Effect and envelope**

### DR-7: Effect ledger — emission as a precondition of the effect landing **[T-4]**

Extends the shipped `core/effect-carrier.ts` (P04-01), which carries `owner`/`idempotent`/`compensation` but **no event coupling**.

**Acceptance criteria:**
- `EffectPlan` gains a required `emits: EventType`; an effect cannot be planned without naming the event that records it.
- `runEffect` requires an appender and returns `Committed<T>`; `T` is unreachable without the append. The dry-run arm is unchanged and still appends nothing.
- A handler performing an effect without committing its event **fails to compile** (it holds an unusable carrier).
- Boot-time bijection: every `plan.emits` names a registered T1 event; every T1 event has exactly one **primary** owner (`role: 'primary' | 'recovery'`).
- Idempotency key is `<eventType>:<operationId>`, reusing `idempotency_claims` — no new storage (INV-8).
- `VcsMutationOwner` is the first migrated consumer (G4 kill fixture).

### DR-8: The fourth envelope state **[MC-2/MC-3 — new]**

MRTR's `input_required` is neither success nor failure. Overloading `success: false` routes it through the DR-7 `errorCode` → exit-code table and surfaces as `INVALID_INPUT: 1` — a false statement about a resumable call.

**Acceptance criteria:**
- `Envelope<T>` gains a third discriminated state, designed once, at the envelope level.
- `CLI_EXIT_CODES` gains a distinct code, **derived from the envelope discriminator**, not switched on in the adapter. A CLI-side special-case fails INV-2's audit.
- The state lands in all <!-- measured: output-schema-substantive -->12<!-- /measured --> typed `outputSchema` declarations; DR-4's ordering proof prevents the <!-- measured: output-schema-vacuous -->111<!-- /measured --> vacuous ones from silently absorbing it.
- `input_required` reconciles with `next_actions` semantics (INV-12) rather than sitting beside them — one affordance contract, not two.
- **Error-path criterion:** a malformed or expired resumption attempt returns a typed envelope, never a validation crash; an `input_required` that can never be satisfied (no capability, no operator) degrades to a typed terminal error rather than an infinite retry.

### DR-9: Core-minted resumption handle **[MC-2 — new, D6]**

**Acceptance criteria:**
- Dispatch mints the handle from the event store (pending-input event / stream position) and returns it in the `input_required` envelope.
- The MCP facade wraps it in the SDK's `createRequestStateCodec` (HMAC-SHA256, **signed not encrypted** — the client can decode it). Nothing confidential rides inside; the payload binds principal, originating method, and expiry.
- The CLI passes the same handle as an ordinary argument — emittable by the existing flag generator, so **no reserved-flag concept is required**.
- **Facade-parity proof:** one production-path fixture drives the same flow through both facades and asserts byte-identical envelopes. Note the SDK constraint: `InMemoryTransport.createLinkedPair()` is 2025-era only, so 2026-era coverage spawns `serveStdio` as a child process.
- **Error-path criterion:** a handle failing verification is rejected above the tool funnel with a typed `-32602`, and replay of a consumed handle is idempotent per INV-8 rather than double-appending.
- Flows with no `featureId` (cold `describe`, onboarding) are explicitly scoped: they use an opaque token, and the census records that exception.

### DR-10: Contract meta-model tightening **[T-10]**

**Acceptance criteria:**
- `AutoEmitSpecSchema.event` changes from `z.string()` (`meta-model.ts:93`) to a catalog-validated `EventTypeRef`; `tier` and `coupling` are added to `EvidencePolicy`.
- A stale `autoEmits` row naming an unregistered type fails compilation.
- Compilation remains byte-stable across repeated runs (P03-03).
- **Lands as its own PR**, separate from the waves — `contract/` is under active change.

**Wave 3 — Observation**

### DR-11: Reconciler interface and content-addressed observation **[T-5]**

> **Added in rev 3 — the indeterminate arm.** Rev 2 handled `indeterminate` only in DR-15. That gap is load-bearing precisely here: `observe(scope)` performs real I/O (git for worktrees/branches, the VCS API for PRs), and with a two-valued return an unreachable provider produces an **empty observation that is then treated as ground truth** — emitting a spurious `divergence.detected` and feeding DR-13's auto-repair path. That is the same "absent observation must not become positive assurance" failure DR-18 names for the oracle and rev 2 named nowhere else.

```ts
type ObservationOutcome<S> =
  | { kind: 'observed';      facts: S }
  | { kind: 'absent';        facts: S }        // the subject genuinely is not there
  | { kind: 'indeterminate'; reason: string }; // could not observe — NOT evidence
```

**Acceptance criteria:**
- `Reconciler<S>` exposes `observe(scope): ObservationOutcome<S>` (I/O, no writes, no appends) and `diff(observed, projected)` (pure, no I/O). **`diff` accepts only `observed` and `absent`** — an `indeterminate` outcome is unrepresentable as a diff input, so the failure mode is excluded at rung 2 rather than remembered.
- An `indeterminate` outcome appends **no** `divergence.detected`, never triggers `reconcile.repair`, and surfaces through the same degraded-result contract as DR-13's other non-dispositive states.
- **Kill fixture:** an unreachable VCS API on the `pr` reconciler must yield `indeterminate`, not an empty observation. Seeded by fault injection; the pre-fix behaviour is the failing subject.
- `observationKey = obs:<subject>:<subjectId>:<sha256(canonicalize(facts))>`.
- **Idempotency proof:** N runs against an unchanged world append exactly one event; fixture asserts N ≥ 100.
- `effect-port-seam.ts` governs the layer — declared port is exactly `process` + `network`, so a reconciler structurally cannot mutate (INV-1: sensing, never state).
- `layer-boundaries-seam.ts` forbids `reconcilers/ → workflow/`.

### DR-12: Boundary-triggered reconciliation **[T-6]**

**Acceptance criteria:**
- Reconcilers fire at session start, phase transition, launcher spawn/teardown, and immediately before admission evaluation. **No timer, no daemon** (INV-15).
- A handle-snapshot assertion proves no process or timer outlives the triggering operation.
- Ship order: `worktree`, `branch` (git is unambiguous), then `pr`.
- **Exit proof:** a manually-deleted worktree produces `divergence.detected` at the next boundary **with no tool call from the agent**.
- Per-reconciler staleness window + content-hash short-circuit bound latency; the VCS reconciler sits behind an explicit window.

### DR-13: Divergence recording and authority precedence **[T-7]**

**Acceptance criteria:**
- `divergence.detected` records subject, observed, projected, and the resolving authority.
- Authority precedence is declared **per resource class as data**, not branched in code (git wins for refs/worktrees; VCS API for PR state; the log for intent/decisions/evidence).
- The reconciler **proposes**; a separate `reconcile.repair` action with its own effect provider disposes. Auto-repair only where ground truth is unambiguous; everything else surfaces in `next_actions` (INV-12).
- Divergence and `projections/degraded-result.ts` surface through **one** consumer contract.

### DR-14: Per-request capability resolution **[MC-2 — new]**

`CapabilityResolver` is snapshotted once per handshake and backs the POLA gates. The revision deletes the handshake; capabilities arrive per request in `ctx.mcpReq.envelope`. The CLI already builds a fresh resolver per process — this adopts the CLI's lifetime on the MCP side.

**Acceptance criteria:**
- The resolver is request-scoped; one seam serves both eras (handshake-authoritative on 2025, envelope-authoritative on 2026).
- `enforceReadonlyGate`, `enforceSharedMutatingGate`, and `mintCapabilitiesForKind` are unchanged in *semantics*; only the capability source moves. A dedicated **security review** gates this DR — it is a trust-boundary change.
- The cross-handshake cache-bleed workaround (CodeRabbit MAJOR #1423, cleared inside `snapshot()`) is **deleted**, and a fixture proves the bug class is unreachable rather than patched.
- **Error-path criterion:** a request whose envelope declares no capabilities resolves to the *narrowest* posture, never the widest — absent declaration fails closed.

**Wave 4 — Verification**

### DR-15: EmissionVerifier **[T-8]**

**Acceptance criteria:**
- A post-dispatch interceptor in the existing `core/dispatch.ts` chain asserts every `condition: 'always'` contract landed for the operation.
- On violation it appends `emission.contract-violated` carrying action, missing set, `operationId`.
- **Fails the response in CI/dev; telemetry-only in production** (D8), selected by **policy, not build flag**.
- A seeded handler that skips its declared emission fails the CI suite.
- **Indeterminate is distinct from pass:** a verifier that cannot evaluate (store unavailable, operation unresolvable) reports `indeterminate` and does **not** promote — per PDD, protected actions must not promote on fail *or* indeterminate.

### DR-16: Derive `PHASE_EXPECTED_EVENTS` **[T-9]**

**Acceptance criteria:**
- The table is **deleted as a hand-maintained artifact**, derived from the union of `autoEmits` across the phase's reachable actions plus T4 declarations.
- **No built-in phase name appears as a literal key in substrate code** (INV-6).
- `_eventHints.missing` is computed from the derived set; a golden fixture pins current output so behavior is unchanged for existing phases.

### DR-17: Reachability `event` and `consumer` hops **[T-11]**

**Acceptance criteria:**
- `REACHABILITY_HOPS` becomes `schema → route → handler → owner → event → consumer → output → artifact → fixture`.
- `HOP_AUTHORITIES.event = 'runtime'` (resolved against the effect ledger); `HOP_AUTHORITIES.consumer = 'runtime'` (projection + gate registries). Neither is `self`; the co-located prohibition test still passes.
- Each new hop has a `kill-fixtures.test.ts` entry.

### DR-18: Oracle emission axis **[T-12]**

**Acceptance criteria:**
- `oracle/oracle-seam.ts` observes that a declared `emits` **actually appended**, rather than reading the declaration back.
- A seeded handler declaring an emission it does not perform is caught **even when the generated files agree** (P03-09: absent observation must not become positive assurance).

### DR-19: Full CLI generation **[MC-1 — new]**

**Acceptance criteria:**
- Top-level operational verbs gain a registry descriptor; the 14 hand-written `.command(...)` registrations are retired, and G1's allowlist reaches **zero**.
- A `skills:guard`-style drift gate re-derives the CLI tree and fails CI on any difference.
- Presentation rules (DR-7 exit-code table, `input_required` rendering) derive from the envelope discriminator.
- **Vacuity becomes visible:** generating a typed renderer from a vacuous `outputSchema` is impossible, so DR-4's remaining ratchet entries surface as build-time holes rather than weak assertions.

**Wave 5 — Cutover**

### DR-20: Catalog disposition **[T-13]**

**Acceptance criteria:**
- `worktree.created`, `worktree.baseline`, `test.result`, `typecheck.result` deleted; consumers read the INV-13 pair and `admission.evidence-recorded`.
- `merge.requested` becomes effect-coupled — an INV-13 **intent** must be at least as reliable as its result, or the pair cannot be correlated after a crash.
- `team.task.*` deleted; one task lifecycle owned by the dispatch/claim path.
- `team.spawned` / `team.disbanded` remain `model`-emitted, annotated `blockedBy: '#1473'` — the only permitted exemption; ratchet pins the count at exactly **2** at Wave 5 exit, reaching **0** when #1473 lands.
- `shepherd.iteration`, `stack.submitted` demoted to T4.

### DR-21: Replay and compatibility **[T-14]**

**Acceptance criteria:**
- Deleted types move to a frozen `LEGACY_EVENT_TYPES` map that reducers still fold; a replay fixture over a pre-migration stream produces **byte-identical** projected state.
- Renames fold via directional upcast (P03-02); historical streams are never rewritten.
- An older installed binary appending a deleted type fails with a **typed error, not a validation crash** (P05-04).

### DR-22: MCP era cutover and Tasks re-platform **[MC-4 — new]**

**Acceptance criteria:**
- `serveStdio(() => buildServer())` replaces `server.connect(new StdioServerTransport())`; **dual-era retained** (no `legacy: 'reject'`).
- The Tasks surface is re-platformed per the Wave-0 audit of its 14 files: `tasks/get` survives as the polling primitive, `tasks/result`/`tasks/list` are retired, `tasks/update` is added, and task creation becomes **server-directed from `longRunning` registry metadata** — retiring the `task: { ttl }` key only the MCP facade could send.
- `tasksGet`'s `task.polled` write is **removed**; it is re-based on the pure-fold discipline `VIEW_FOLLOW_ACTIONS` already proves (`cli.ts:239`).
- `hidden: true` is resolved — expose-and-annotate, or move off the tool registry. A CLI-reachable tool absent from the MCP contract contradicts the #1608 reframe.
- The local `patch-package` patch is removed if SEP-2106 covers both its fixes (2020-12 target **and** the DU-root `type: 'object'` splice); `tools-list-2020-12.test.ts` is retained as a conformance test.
- **Error-path criterion:** an era-mismatched method is rejected with the SDK's typed error before reaching the transport, never a silent no-op.
- **`server/discover` is derived from the registry, never authored beside it** *(added rev 3 — MC-4 was under-absorbed; rev 2 contained zero occurrences of it)*. The 2026-07-28 revision makes it **MUST-implement**, and it carries its own `ttlMs`/`cacheScope`. Hand-maintaining it would create exactly the second-source-of-truth this program exists to eliminate — the composition report flags it as R-G for that reason.
  - Discovery output (identity, supported versions, extensions) is generated from the declaration envelope (DR-1); a hand-edited discovery response fails the authority census (G5) as an unbound representation.
  - Cache hints on list results are **`ttlMs`/`cacheScope` only** and are kept distinct from Exarchos's in-envelope `_cacheHints` (the prompt-cache boundary marker). They are different layers; conflating them would break the DR-14 capability gate. Rev 2 omitted both.
  - **Error-path criterion:** a discovery response that disagrees with the live registry fails a conformance test rather than being served — absent verification must not become positive assurance.

### DR-23: Invariant amendments **[new — D9]**

**Acceptance criteria:**
- **INV-5b** amended: the Tasks clause reflects the extension lifecycle; the `outputSchema` clause states the **non-vacuity** requirement G2 enforces.
- **INV-11** amended: capability declaration is per-request-envelope-authoritative on 2026-era connections, handshake-authoritative on 2025-era; the unrepresentable-by-construction principle is unchanged.
- **INV-2** amended to quantify over the *facade*, closing the context-and-arguments loophole: capability adapters on `DispatchContext` and facade-exclusive arguments that gate behaviour are violations, not exemptions.
- **INV-17** corrected: `withCappedShape` covers baseline ∪ capped; `degraded` is a `_meta` marker (`economyDegraded`) admitted by envelope structure — the "triple" is a pair plus a flag.
- All amendments authored through `/exarchos:invariants`; **no hand-edited catalog YAML**.

### DR-24: Wave sequencing and anti-inertness **[T-15]**

The wiring audit's dominant finding is **shipping a correct mechanism nothing calls** (13 inert, 36 not-leveraged of 48 packages).

**Acceptance criteria:**
- Every wave exit is a **seeded-failure test against production composition** — never "the module exists", never a unit test over a mock.
- Waves 1–4 have no external dependency and may proceed as soon as Wave 0 closes.
- Wave 5 is gated on P07-01: zero unexplained disagreements across ≥20 live workflows.
- A follow-up issue is filed against #1473 to drive the report-coupled count from 2 to 0.
- **Each guard's self-test runs in the same CI job as the guard**, so guard-execution failure cannot pass as success.

---

### DR-25: Dispatch shape belongs to the provisioning contract, not orchestrator convention **[new]**

`prepare_review` and `prepare_delegation` emit `posture`, `instruction`, and `provisionedContext` — but **not the dispatch shape** the orchestrator must use to launch the agent. The orchestrator therefore improvises the harness invocation. For a `read-only` posture, where worktree isolation is genuinely pointless, the natural improvisation (`name` without `isolation`) produces an **idle mailbox teammate that never runs the prompt** — the spawn returns success, the agent emits `idle_notification` pings that read like progress, and the review never happens.

This is PDD's *"a fix relies on someone remembering a convention"* row: the correct dispatch shape exists as knowledge, and nothing mechanically requires it. It is also the sharpest possible instance of the program's own thesis — a **provisioning contract that declares a posture it does not bind**.

**Live incident (2026-08-07):** the plan-review panel for *this spec* was provisioned `posture: 'read-only'`, dispatched with `name` and no isolation, and produced three phantom teammates and zero verdicts. `ListAgents` omitted them entirely. Recovery via `SendMessage` also failed; only a fresh anonymous dispatch worked.

**Acceptance criteria:**
- `prepare_review` and `prepare_delegation` results carry a `dispatch` field naming the required launch shape for the emitted posture: `read-only` → anonymous async (`name` omitted); `task-isolated` → named **plus** worktree isolation; `shared-mutating` → main-worktree, never a subagent.
- **Totality:** a registry-enumeration test asserts every declared `AgentPosture` has exactly one `dispatch` entry. A posture with no entry fails the suite — the mapping cannot be partial.
- **Kill fixture:** today's `prepare_review` output, which carries `posture: 'read-only'` and no `dispatch` field, fails that totality test on introduction.
- The delegate skill references gain a read-only dispatch section. They currently document only worktree-isolated implementers (`workflow-steps.md` agent-teams variant: *"named teammates, each assigned to a worktree"*) and the anonymous async path — read-only dispatch is undocumented, which is the gap the incident fell through.
- **Error-path criterion:** a `dispatch` shape naming a harness capability the runtime does not declare (e.g. worktree isolation on a runtime without native support) resolves to the declared fallback rather than silently degrading to a shape that does not run the prompt (INV-4 platform agnosticity). A dispatch that cannot be honoured is a typed error, never a silent no-op.
- **Self-test:** a seeded provisioning result whose `dispatch` contradicts its `posture` (e.g. `read-only` + named-with-isolation) fails the suite, so guard-execution failure cannot pass as success.
- **The skill prose is bound to `POSTURE_DISPATCH_MAP`, not merely consistent with it** *(added rev 4.1)*. A test parses the posture table out of `skills-src/delegate/references/parallel-strategy.md` and asserts it against the shipped map; disagreement fails. **Non-empty denominator:** a parse resolving zero rows fails rather than passing clean.

> **Why rev 4.1 added that criterion.** Task 048 shipped the read-only dispatch documentation correctly and then reported the consequence against itself: **the prose is a new representation of the posture→dispatch contract, and nothing binds it.** It can drift from `agents/dispatch-shape.ts` silently. The mitigation available inside a docs task was a *convention* — the prose declares the emitted `dispatch` field authoritative — which is precisely the *"a fix relies on someone remembering a convention"* row DR-25 exists to close. So DR-25's own documentation deliverable reproduced DR-25's defect one boundary over.
>
> This is the **second** occurrence of the class at a second boundary: the topology table already records *"skill prose (#1716)"* as an unbound representation of the **event catalog**. Two independent boundaries have now grown an unbound prose representation, which makes it a pattern rather than an oversight — **documentation that restates a contract is a representation, and representations get bound.** Task 048 correctly did not write the fix, because the binding test lives in `servers/exarchos-mcp/src/**` and task 047 was concurrent there. Tracked as task 056.

**Sequencing note:** this lands in **Wave 1**, not later, because Waves 2–5 of this very program dispatch agents through these verbs. Leaving the contract unbound means the program's own execution keeps hitting the defect it exists to eliminate.

### DR-26: SDK generation seam — restore DR-0's rung-2 claim **[new in rev 4]**

DR-0's error-path criterion is **not weakened, it is relocated to a subject that can carry it.** The criterion failed because it asserted nominal separation over *someone else's* structurally-typed package. Exarchos cannot brand `@modelcontextprotocol`'s `Transport` — but it can brand **its own seam's handle type** and forbid direct SDK imports, at which point mixing generations fails `tsc` exactly as originally claimed.

This is the **DR-1 pattern applied to a second boundary**, and it uses no new instrument: the "consumers may only read through the accessor" rule is already enforced by the shipped `architecture/layer-boundaries-seam.ts` (304 lines). Per the program's own rule, *if a guard required a novel instrument, that would be evidence it was the wrong design.*

**Acceptance criteria:**
- One owned module is the sole importer of either SDK generation, re-exporting the used surface with a **generation brand** (`__gen: 'v1' | 'v2'`) on every handle type that crosses the seam.
- **Rung 2:** a value drawn from one generation and passed where the other is expected **fails typecheck**. This is DR-0's original criterion, now true.
- **Falsifier (the assertion DR-0 lacked):** seed a module importing an SDK package directly; the seam rule must reject it. A seam with no current failing subject has not been shown to work — and on introduction there were **22 such subjects across 9 directories** (42 import sites), so the denominator was non-empty by measurement, not by assertion. *(Was 40 across 13 until task 061 replaced the raw-text scanner with a parse; the tree did not change, the instrument did.)*
  - **Discharged by task 053 (rev 4.11).** Every one of those 22 was migrated, so the live count is now **<!-- measured: sdk-import-sites -->0<!-- /measured --> files across <!-- measured: sdk-import-directories -->0<!-- /measured --> directories**. The falsifier does **not** retire with its subjects: `SdkSeam_DirectSdkImport_FailsSeamRule` re-seeds a direct import into the *live* scan and asserts the rejection, because over a fully migrated tree "zero violations" and "a rule that cannot fire" are the same reading. The pre-migration tree was also replayed through the shipped rule as a one-off RED proof — 22 modules / 42 sites rejected, no other diagnostic.
  - **The zero is not self-certifying, and the non-empty denominator moved rather than disappeared.** `SdkSeam_MigratedTree_ResolvesEverySiteThroughSeam` asserts the module population is > 50, the seam is present, its own SDK import count is > 0, and **both** generations still reach it. A relocated `src`, a renamed seam or a dead specifier parser trips one of those instead of reading as a completed migration.
- **Non-empty denominator:** a seam check that resolves zero SDK import sites **fails**, so a moved or renamed module cannot pass as a clean tree.
- The rung-3 lint shipped in task 049 (`architecture/sdk-generation-seam.ts`) is **retained as the seam-bypass enforcement**, not as a substitute for the type guarantee. It retires only when the brand covers every crossing — and its retirement must be justified by measurement, not by belief that migration is complete.
- The **SDK generation** row enters the authority-topology table with `enforceFrom`, and DR-6's totality check ranges over a **derived** boundary list — a hand-maintained list is exactly how this boundary went unmodelled in rev 3.

**Sequencing:** Wave 1, after task 049's additive split, alongside DR-1's seam (task 006) so both instances of the pattern land together. Blocks the DR-0 source migration and therefore DR-9/DR-14/DR-22.

### DR-27: Measured-premise binding — the spec is a bound representation **[new in rev 4]**

Every numeric and structural claim in this document is a **representation of a derivation**, and none of them are bound to it. That is this program's own defect class, instantiated by the document that defines it. The evidence is not theoretical: **rev 1 was refuted 3/3 for stale measurements, and rev 3 reproduced the same class in DR-4** — wrong numerator, wrong denominator, and a "typed" set that was actually vacuous. DR-24 already carries the rule ("re-derive wave premises against the landing branch at plan time"), but as prose a human must remember, which is PDD's *"a fix relies on someone remembering a convention"* row.

**Acceptance criteria:**
- Measured claims in the spec carry a machine-readable annotation naming their derivation, e.g. `<!-- measured: output-schema-vacuous -->111<!-- /measured -->`.
- A checker maps each name to a derivation (a census function, a script, a counted grep) and **fails when the document's literal disagrees with the re-derived value.** The document cannot assert a number nothing produces.
- **Kill fixture:** run the checker against **rev 3 of this file** — it must report the DR-4 counts (`109`, `123`, "12 typed") as drifted. A checker that passes on a document already known to be wrong has not been shown to work.
- **Non-empty denominator:** a run that resolves zero annotated claims fails rather than passing clean.
- **Rung claims are annotated too.** DR-0 failed by asserting a proof rung its subject could not carry, which is a different failure from a stale count. Each obligation-map row's rung carries a one-line *probe* — the command or fixture that shows the subject can bear that rung — and an unprobed rung is a reportable gap, **not** a pass. ("Nothing" is a reportable answer, per the obligation map's own `Failure signal` column.)
- Scope is **this document plus `.exarchos/invariants.md`**; generalizing to all of `docs/` is explicitly out of scope and needs its own ADR.

**Sequencing:** Wave 1. It is cheap, and every later wave's premises are re-derived through it — including the Waves 2–5 re-plan that DR-24 already gates on Wave 1 exit.

## Supporting Analysis

### Obligation map

PDD deliverable 3. `Failure signal` distinguishes fail from indeterminate; "nothing" is a reportable answer.

| Property | Scope | Consequence if false | Primary proof (rung) | Proof artifact | Failure signal | Rollback |
|---|---|---|---|---|---|---|
| Every event's reliability is declared, not assumed | event catalog | Log drifts; agents learn to skip steps | 2 — types<!-- rung-probe: none --> | G3 union + ratchet | `tsc` fail; ratchet delta | Revert union; types are additive |
| No report-coupled emission can be registered | event catalog | The 25-type class regrows | 2 — types<!-- rung-probe: none --> | Unconstructible variant | Compile error | Allowlist (2 exempted, pinned) |
| Every effect's event lands with it | effect ledger | Post-crash state unreconstructable | 2 — types<!-- rung-probe: none --> | `Committed<T>` carrier | Compile error; boot bijection | `role: 'recovery'` escape; revert carrier |
| Every action's response shape is substantive | response contract | INV-17's precondition is a tautology | 3 — structural<!-- rung-probe: fixture:servers/exarchos-mcp/src/architecture/output-schema-census.test.ts --> | G2 ratchet | Ratchet delta | Allowlist w/ expiry |
| Every CLI verb derives from the registry | CLI surface | Verbs outside the parity harness | 1 — generation<!-- rung-probe: none --> | G1 + DR-19 drift gate | Guard non-zero exit | Allowlist w/ expiry; guard is additive |
| One authority per boundary | all | Silent divergence between agreeing copies | 3 — structural<!-- rung-probe: fixture:servers/exarchos-mcp/src/contract/reachability/kill-fixtures.test.ts --> | G5 census | Closure < 100% | Census is observe-only until Wave 4 |
| A declared emission actually appended | dispatch | Detection exists and is discarded | 5 — production path<!-- rung-probe: none --> | DR-15 verifier + DR-18 oracle | `emission.contract-violated`; **indeterminate ≠ pass** | Policy switch to telemetry-only |
| Projected state matches ground truth | reconcilers | Manual reconciliation cost recurs | 5 — production path<!-- rung-probe: none --> | DR-12 exit proof | `divergence.detected` | Per-reconciler disable; observe-only mode |
| `input_required` is not success or failure | envelope | Exit code lies about a resumable call | 2 — types<!-- rung-probe: none --> | DR-8 discriminated state | Type error; parity fixture | Additive state; removable pre-wire-exposure |
| Resumption is auditable | dispatch | Un-auditable resumption in an event-sourced system | 1 — construction<!-- rung-probe: none --> | DR-9 core-minted handle | Typed rejection; INV-8 claim | Fall back to opaque token |
| Capability resolution fails closed | POLA gates | Trust boundary widens silently | 2 — types<!-- rung-probe: none --> | DR-14 narrowest-posture default | Typed denial | Dual-era seam retains handshake path |
| Deleted event types still replay | event store | Historical streams unreadable | 4 — contract test<!-- rung-probe: none --> | DR-21 byte-identical fixture | Fixture diff | `LEGACY_EVENT_TYPES` is frozen, not removed |
| Invariant text is true | catalog | An authority asserting something false | 6 — human judgment<!-- rung-probe: none --> | DR-23 via `/exarchos:invariants` | **Nothing** — reportable gap | Catalog is versioned; revert |

### Production path

PDD Design-mode deliverable 3, **added in rev 3** — rev 2 offered only a flat list of integration points, which is not a path from a public root to an observable effect. This matters more here than usual: the program's dominant risk (R-11 / DR-24) is *"the mechanism ships and nothing calls it"*, and rev 2 stated that as a rule with no path model to check it against.

Per new capability: **public root → route → handler → domain port → adapter → observable effect**, with the artifact that proves each edge is live.

| Capability | Public root | Route | Handler | Port | Observable effect | Proof fixture | Rollback |
|---|---|---|---|---|---|---|---|
| **Resumable input** (DR-8/9) | `tools/call` · CLI action verb | dispatch `action` discriminator | composite handler returns `inputRequired(...)` | event store (handle mint) | `input_required` envelope on both facades + pending-input event appended | cross-facade parity fixture (child-process `serveStdio` + CLI) | envelope state additive until wire-exposed |
| **Reconciliation** (DR-11/12/13) | phase transition · session start · launcher spawn | boundary hook | `Reconciler.observe` → `diff` | `effect-port-seam` (`process` + `network` only) | `divergence.detected` appended with no agent tool call | DR-12 exit proof: manually deleted worktree | per-reconciler disable; observe-only mode |
| **Emission contract** (DR-15) | any `tools/call` | dispatch interceptor chain | `EmissionVerifier` post-dispatch | event store | `emission.contract-violated` appended; response fails in CI/dev | seeded handler that skips its declared emission | policy switch to telemetry-only |
| **Effect coupling** (DR-7) | any mutating verb | composite handler | `runEffect(plan)` | `EffectPlan.emits` | effect + its event committed together, or neither | boot-time bijection over the ledger | `role: 'recovery'` |
| **Derived CLI** (DR-5/19) | `exarchos <verb>` | `buildCli` derivation helper | registry action | — | rendered command tree | G1 source parse + DR-19 generate-and-diff | allowlist with ISO expiry |

Every row's effect is **observable in the event store or the rendered surface** — not "the module exists". A capability whose row cannot name an observable effect does not ship.

### Compatibility classification

PDD deliverable 5. Reverse-dependency closure per changed shared contract.

| Contract | Change | Class | Reverse closure | Rollback |
|---|---|---|---|---|
| `Envelope<T>` | +1 discriminated state | **Breaking** for exhaustive consumers | 118 actions, both facades, parity harness, DR-7 exit table | Additive until wire-exposed; irreversible once clients branch on it |
| `EventRegistration` | union replaces flat record | **Breaking** at registration sites | <!-- measured: event-types-total -->171<!-- /measured --> registrations | Types only; revert is mechanical |
| `EffectPlan` | `emits` becomes required | **Breaking** at all effect call sites | every `runEffect` caller | `performAndCommit()` helper absorbs the common case |
| `ToolAction` | + top-level-verb descriptor | **Additive** | registry consumers (10) | Optional field |
| `CapabilityResolver` | lifetime connection → request | **Breaking** internally; behaviour-preserving | POLA gates, dispatch, `applyCacheHints` | Dual-era seam keeps the handshake path live |
| MCP wire | 2025 → dual-era | **Non-breaking** during the window | all clients | Pin legacy; `serveStdio` default is dual |
| `PHASE_EXPECTED_EVENTS` | hand-maintained → derived | **Behaviour-preserving** | `_eventHints` consumers | Golden fixture pins output |
| Deleted event types | append removed, read retained | **Breaking** for appenders only | Wave-5 scope | Frozen `LEGACY_EVENT_TYPES` |

**Irreversible by construction:** event-type deletion (append capability); any `Envelope<T>` state once a released client branches on it. Everything else is revertible.

### Technical Design

Wave 0 closes the INV-9 defects. Wave 1 lands G1–G5 as **observe-then-enforce**: each guard ships wired to its kill fixture, proven to fail, then flipped to blocking within the same wave — so no guard is ever merged unproven, and none blocks CI before its subject is remediated.

Waves 2–4 land the mechanisms each guard now protects, in cheapest-rung order: types (DR-2, DR-7, DR-8), then generation (DR-19), then structural analysis (DR-17), then production-path (DR-12, DR-15, DR-18). Wave 5 is cutover — catalog deletion, era switch, invariant amendment.

The **relocation proof** (DR-1) is the spine that makes D2 real: at any wave boundary, moving a declaration's storage must leave every guard passing with no consumer edit. If that fixture ever needs a consumer change, the binding was written against storage rather than the seam, and #1258 would re-open the classes this program closed.

### Integration Points

`core/dispatch.ts` (interceptor chain — DR-15) · `core/effect-carrier.ts` (DR-7) · `event-store/schemas.ts` (`registerEventType` seam — DR-1, DR-2) · `event-store/atomic-appender.ts` + `idempotency_claims` (DR-7, DR-9, DR-11) · `contract/{compiler,reachability,oracle}` (DR-10, DR-17, DR-18) · `architecture/*-seam.ts` (G1–G5 vocabulary) · `scripts/cli-vocab-guard.ts` (G1) · `adapters/{cli,mcp}.ts` (DR-19, DR-22) · `capabilities/resolver.ts` (DR-14) · `orchestrate/reconcile-state.ts` (DR-11–13) · `.exarchos/invariants.md` via `/exarchos:invariants` (DR-23).

### Exploration

Research pre-pass: discovery workflow **`mcp-spec-2026-07-28-migration`** (gathering → synthesizing → completed), producing the migration evaluation and the architectural-composition report cited in Inputs. The discovery preceded this ideation rather than being escalated from it, so no `discover_bridge` `correlationId` stitches the two — provenance is by explicit path citation. The composition report's MC-1…MC-4 are the direct source of DR-4, DR-5, DR-8, DR-9, DR-14, DR-19, and DR-22.

### Alternatives considered

**B — Contract compiler as the authority.** Make the registry a compiled artifact so violations are unwritable at rung 1 rather than ratcheted at rung 3. Genuinely stronger where it applies, and its instinct is absorbed per-obligation in D4. Rejected as the *spine* because the superseded spec isolates DR-10 into its own PR precisely because `contract/` is under active change — making that churn the program's critical path trades a distributed risk for a single point of total failure.

**C — IR-first (#1258).** Build the Workflow Builder IR now and land everything on the declared destination, one migration instead of two. Rejected because #1258 is v3.0 work and the superseded spec is v2.12-shaped specifically so *"Waves 1–4 have no external dependency."* Forfeiting that makes the whole program hostage to the largest unshipped roadmap item. **D2 preserves C's benefit without its dependency:** declarations are IR-shaped now, so #1258 relocates rather than re-binds — and DR-1's relocation proof is what keeps that honest.

**Layered (two programs, taxonomy v2 as prerequisite).** Preserves the review-hardened DR-1…DR-15 verbatim and yields smaller shippable units. Rejected per D1: G1–G5 would be defined twice with two ratchet sets, and the shared defect class would be remediated from two directions with no single census proving closure.

### Open Questions

1. **How far should `outputSchema` tightening go** — full per-action data shapes, or tiered (typed for DR-10 + HSM surfaces, structured-but-loose elsewhere)? DR-4 argues the 90% floor is untenable; the ceiling is a scope call that sets Wave 4's size.
2. **Does the interactive CLI get a stdin prompt loop for `input_required`**, or is scripted handle-passing the only mode? Decides whether the CLI grows an interactive surface it has so far avoided.
3. **Should the removed `tasks/list` return as an `exarchos_view` domain verb?** A domain verb is facade-neutral by construction; a protocol method never was.
4. **Does `longRunning` alone carry enough signal for server-directed task creation**, or does it need a per-action threshold/TTL now that it is behavioural rather than presentational?
5. **What is the Wave-0 scope of the Tasks audit?** The 14-file surface includes a `RESERVED(#1273 … expires 2027-01-31)` dead stub; the live fraction sets DR-22's true size.
6. **Does the composite tool pattern survive a remote surface?** `Mcp-Name` exposes 4 tool names for 118 verbs — if v3.2 wants per-verb edge policy, this is the blocker, and it may want deciding before Wave 5 rather than after.
7. **What exactly should `sdk-import-sites` count?** *(opened rev 4.3 by task 024.)* The claim is bound to a precise derivation — *files under `servers/exarchos-mcp/src` referencing the v1 specifier, **test files included*** — and DR-27 correctly caught it drifting 38 → 40 as this wave added tests that mention the specifier as fixture text. But the **name is ambiguous even though the derivation is pinned**: task 024, measuring non-test files through the seam's own classifier, got 27 and read the difference as a disagreement. Two honest derivations, two different populations, one name.
   - The number that actually matters to DR-26 is the **production migration surface** task 053 must move — non-test files only, currently **16**. A claim that drifts whenever anyone adds a test is noise, and will keep reddening on unrelated work.
   - **RESOLVED by tasks 061 + 062 (rev 4.8).** Every prior number was wrong for the same reason: the scanners matched **raw text**, so comment mentions and template-literal fixtures counted as imports (→ tasks **061**, **062**). Task 062 reproduced 061's derivation exactly at 061's own commit and confirmed both the method and the figure.
   - **Task 053's backlog is 44 bypass sites / 23 files / 9 directories (10 non-test)** at the current tip. It was 46 at 061's commit; **the two-site drop is real work, not an instrument change** — task 051 migrated two sites in `task-store/event-sourced-task-store.ts` behind the seam. **Not 56/24/10, and not 38.**
   - ⚠️ **This very number is itself an unbound claim, which is a DR-27 gap.** `check-measured-premises.mjs` derives `sdk-import-sites` at **file** granularity only; there is no bound premise for the **site** count. So the figure above is prose, it drifted within five commits, and nothing caught it — task 062 caught it by hand. **Before task 053 runs, either bind the site count or re-derive it at dispatch**; do not read this line as authoritative.
   - **The warning above was justified, and it fired. Task 053 re-derived at dispatch and got 42 sites / 22 files / 9 directories (10 non-test) — not 44 / 23.** Two of the three prose figures had drifted again inside the same rev; the **bound** premises (`sdk-import-sites` = 22 files, `sdk-import-directories` = 9, `sdk-import-production-files` = 10) agreed with the re-derivation exactly. That is a clean natural experiment on DR-27's own thesis: **the bound claims held across five commits and the unbound prose beside them drifted twice.** Instrument: `collectSdkImportSites` + `parseModuleSpecifiers`, walked over `servers/exarchos-mcp/src`.
   - **The site count is now bound in the only place it can be — a test, not a literal.** `SdkSeam_MigratedTree_ResolvesEverySiteThroughSeam` asserts the *set* of SDK-importing modules equals `{sdk/seam.ts}`, which is the site count's totality claim without a number to go stale. Adding a `sdk-import-site-count` premise was considered and rejected: post-migration it is identically zero, so it would bind nothing that the set assertion does not bind more strongly.
   - **CLOSED by task 053 (rev 4.11): the backlog is 0 / 0 / 0.** All 42 sites across 22 files migrated onto `sdk/seam.ts`. Unlike every prior movement of these numbers, **this one is the tree changing, not the instrument** — the same instrument, at the same scan root, reports 42 → 0.
   - **CLOSED by task 061 (rev 4.4).** The scanner now parses import/export specifiers, so a comment mention, a string, or a lint fixture written as a template literal is no longer an import site. Re-derived against this branch, old → new: `sdk-import-sites` **40 → 23**, `sdk-import-directories` **13 → 9**, and the previously-unbound "16 of them production" is now bound as `sdk-import-production-files` **16 → 10**. **The tree did not change; the instrument did** — no migration progress may be read from these numbers. 052's own figures were measured with the seam's `collectSdkImports` regex, which matches specifiers but does **not** exclude comments or literals, so they inherit the defect one level down: its "56 bypass import sites across 24 files in 10 directories" parses as **46 sites across 23 files in 9 directories**, the entire 10-site delta being `architecture/sdk-generation-seam.test.ts`, whose SDK "imports" are the lint's own fixture strings. Its repo-wide "26 files / 13 directories" parses as **26 files / 12 directories**. **Task 053's backlog is 46 sites / 23 files / 9 directories, of which 10 files are non-test — not 56 / 24 / 10, and certainly not 38.** Task 061 did **not** rename or re-scope the claim: renaming would conflate a semantic change with the arithmetic correction, which is exactly what this bullet exists to keep separable.
   - **A separate finding from 024, verified independently and NOT deferred:** the row's prose claims both generations are "imported directly". **That is false.** v2 has **zero** production import sites — the only non-test file naming `@modelcontextprotocol/{core,server}` is `architecture/sdk-generation-seam.ts`, which lists them as *data* for the lint. v1 is imported; v2 is merely installed. Corrected in the row below. Also: `@modelcontextprotocol/client` appears in the seam's v2 list but **is not installed**.

8. **What denominator does `118` count?** *(opened rev 4.2 by task 054.)* The spec uses **118** for actions/verbs/`outputSchema` in several places, but the live census measures **122** runtime actions — a gap of 4 that nobody has reconciled. Candidate explanations: it counted **visible-only** actions (excluding the hidden `exarchos_sync`), or it predates `makeDescribeAction` becoming a factory serving two tools, or it predates later verb additions. Task 054 deliberately **left `118` unannotated** rather than invent a derivation to justify it — annotating a number whose meaning is unknown would manufacture exactly the false agreement DR-27 exists to prevent. **Until someone establishes what `118` counts, it is an unbound claim** and every use of it in this document is unverified. Whoever closes this should either bind it to a real derivation or replace it with the measured 122.

### Risks

| Risk | Mitigation |
|---|---|
| **R-1** Program size — 24 DRs across 6 waves | Waves 1–4 independent; each wave exit is a seeded-failure proof (DR-24). Wave 1 ships guards only, so value lands before mechanisms. |
| **R-2** Re-litigating a spec hardened over three review rounds | Absorbed DRs retain their acceptance criteria verbatim with `[T-n]` provenance; plan-review diffs against the superseded doc rather than re-deriving. |
| **R-3** Guards block CI before their subjects are remediated | Observe-then-enforce within the same wave; allowlists carry owner + expiry and may only shrink. |
| **R-4** `Envelope<T>` fourth state is irreversible once wire-exposed | Design it before any MRTR code (D5 sequencing); land in typed schemas first, behind the dual-era window. |
| **R-5** DR-14 changes a trust boundary | Dedicated security review gates the DR; semantics of the three POLA gates are unchanged, only the capability source moves; fails closed on absent declaration. |
| **R-6** Reconciler latency at every boundary | Content-hash short-circuit; per-reconciler TTL; VCS reconciler behind an explicit staleness window. |
| **R-7** `contract/` churn collides with DR-10 | DR-10 lands as an isolated PR (inherited). |
| **R-8** #1473 never lands, stranding two exempted types | Annotated `blockedBy`, ratchet-pinned at 2 so the exemption cannot widen; follow-up issue tracks the flip. |
| **R-9** The superseded spec is **untracked in git** | Commit `2026-08-05-event-taxonomy-v2.md` before this spec lands, so supersession has an ancestor and the `[T-n]` provenance resolves. |
| **R-10** 2026-era test coverage needs child-process `serveStdio` | `InMemoryTransport` is 2025-era only. Budget for flakiness on the already-fragile Windows lane (#1699); prefer shape-based unit tests where the era is not the subject. |
| **R-11** The mechanism ships and nothing calls it | DR-24 — seeded-failure exits against production composition, never "the module exists". |

---

## Decomposition

### Scope

**Target:** Partial — **Wave 0 and Wave 1 decomposed to task granularity (tasks 001–027, 046–077).** Waves 2–5 carry one anchor task per DR (028–045) for provenance, to be re-planned after Wave 1 exit.

> **Task-ID ranges, since three appends have now widened this.** 001–004 retired (rev 2). 005–027 = the rev-1/rev-3 Wave 1 body, 027 the join point. 028–045 = Waves 2–5 anchors. 046–050 = rev-4 additions (DR-25, DR-0 remainder). 051–077 = tasks *derived from running Wave 1*, each one a defect a shipped task found and reported rather than worked around. That third range is the program working as designed, not scope creep — but it means **the task count is not fixed at plan time**, and any statement of the form "N of M tasks complete" must re-derive M.

**Excluded, with rationale:** Waves 2–5 are *deliberately* not decomposed in this pass. **DR-6's authority-topology census is the instrument that enumerates the real remediation subjects** — which boundaries have unbound representations, which events lack a consumer hop, which effects lack a coupling. Decomposing Waves 2–5 before that census has run would be fabricating a subject list rather than deriving one, which is precisely the precision-manufacturing PDD warns against ("do not add abstractions, manifests, generators, or test layers without a concrete correctness obligation").

Two subject lists *are* already measured and therefore Wave 1 is fully decomposable now: the **<!-- measured: output-schema-vacuous -->111<!-- /measured --> vacuous `outputSchema` declarations** (DR-4) and the **14 hand-written CLI commands across <!-- measured: cli-handwritten-literals -->11<!-- /measured --> hand-written top-level verbs** (DR-5). Wave 1 also matches the house-standard bundle size (~26 tasks, one integration branch), and it is the wave PDD's decision table requires to land first: *add the guard that makes derivation mandatory before adding another instance of the pattern.*

Re-plan trigger: Wave 1 exit (all five guards green against their kill fixtures, censuses reporting real subject counts) → `/exarchos:plan` over Waves 2–5 with the census output as input.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| — | ~~Wave 0 prerequisite (INV-9 defects)~~ — **REMOVED rev 2**, already closed on the landing branch; tasks 001–004 retired | — |
| DR-0 | SDK v1→v2 package split, ahead of every consumer | 049, 050, 051 |
| DR-1 | IR-shaped declaration envelope | 005, 006, 007, 008 |
| DR-2 | Tiered, coupling-typed event registration | 009, 010, 011, 012, 013 |
| DR-3 | Compile-time event-name grammar | 014, 015, 075 |
| DR-4 | `outputSchema` non-vacuity | 016, 017, 018, 019, 055, 060, 069 |
| DR-5 | CLI derivation guard | 020, 021, 022, 023, 076 |
| DR-6 | Authority-topology census | 024, 025, 026, 027, 066 |
| DR-7 | Effect ledger | 028 *(anchor)* |
| DR-8 | Fourth envelope state | 029 *(anchor)* |
| DR-9 | Core-minted resumption handle | 030 *(anchor)* |
| DR-10 | Contract meta-model tightening | 031 *(anchor)* |
| DR-11 | Reconciler interface | 032 *(anchor)* |
| DR-12 | Boundary-triggered reconciliation | 033 *(anchor)* |
| DR-13 | Divergence + authority precedence | 034 *(anchor)* |
| DR-14 | Per-request capability resolution | 035 *(anchor)* |
| DR-15 | EmissionVerifier | 036 *(anchor)* |
| DR-16 | Derive `PHASE_EXPECTED_EVENTS` | 037 *(anchor)* |
| DR-17 | Reachability event/consumer hops | 038 *(anchor)* |
| DR-18 | Oracle emission axis | 039 *(anchor)* |
| DR-19 | Full CLI generation | 040 *(anchor)* |
| DR-20 | Catalog disposition | 041 *(anchor)* |
| DR-21 | Replay and compatibility | 042 *(anchor)* |
| DR-22 | MCP era cutover + Tasks re-platform | 043 *(anchor)* |
| DR-23 | Invariant amendments | 044 *(anchor)*, 068, 073 |
| DR-24 | Wave sequencing / anti-inertness | 045 *(anchor)*, 057, 058, 063, 064, 066, 067, 068, 069, 070, 071, 074, 077 |
| DR-25 | Dispatch shape belongs to the provisioning contract | 046, 047, 048, 056, 059 |
| DR-26 | SDK generation seam *(rev 4)* | 052, 053, 062, 065, 072 |
| DR-27 | Measured-premise binding *(rev 4)* | 054, 061 |

> **Matrix reconciled rev 4.10.** Rows for DR-26/DR-27 were absent and tasks 051–066 were unmapped, because the rev-4 tasks were appended without re-deriving this table. `check_plan_coverage` reads it, so its authoring-time **PASS 24/24** was measuring rev 3's task set, not the shipped one. Re-run the gate at 027; do not treat the recorded result as current.

### Tasks


**Wave 0 — REMOVED in rev 2. Tasks 001–004 withdrawn.**

> Rev 1 declared Wave 0 (INV-9 closure) the prerequisite for the whole program, on the strength of the 2026-08-04 wiring audit. All three premises are **already closed on the landing branch**, verified after rebase:
> - `makeArtifactGuard` (`servers/exarchos-mcp/src/workflow/guards.ts`) already requires a resolvable typed reference on both the canonical and legacy paths; its own comment records the retired `!= null` probe.
> - `evidenceBypass` returns **zero hits** across the tree.
> - `executeTransition` has **one** non-test call site — `workflow/hsm-transition-guard.ts`, the sanctioned INV-9 authority — plus its definition in `workflow/state-machine.ts`.
>
> Task IDs 001–004 are **retired, not reused**, so dependency edges and recorded workflow state stay stable. Task 027's dependency on 004 is dropped. **The program now begins at Wave 1 with no external prerequisite.**
>
> Lesson preserved rather than discarded: the audit that justified Wave 0 was real when written and stale when consumed. Any future wave premise must be re-derived against the landing branch at plan time — which is what DR-24's wave-exit discipline now requires explicitly.

**Wave 1-pre — DR-0: SDK v2 package split (unblocks DR-9, DR-14, DR-22)**

### Task 049: Add the v2 packages alongside v1 and migrate sources directory by directory
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-0
**Files:** `servers/exarchos-mcp/package.json`, `servers/exarchos-mcp/src/adapters/mcp.ts`, `servers/exarchos-mcp/src/adapters/cli.ts`, `servers/exarchos-mcp/src/__tests__/sdk-pin-policy.test.ts`
**Detail:** v1 and v2 have different package names and coexist, so the swap is incremental and revertible. Nothing goes on the wire — v2 speaks the 2025-era protocol until an explicit era opt-in.
**Tests:**
- `ToolsList_AfterV2Migration_ByteIdenticalToGolden` — no wire change
- `SdkPinPolicy_V2Packages_AreExactPinned` — the exact-pin policy survives retargeting
- `MixedV1V2Imports_FailTypecheck` — a partially-migrated tree cannot resolve two protocol-type copies
**Verification:** high — scoped tests + `check_test_adequacy` + integration suite (`tools/list`, `tools/call` golden fixtures).
**Dependencies:** None · **Parallelizable:** Yes

### Task 050: Evaluate the patch-package patch against v2 and retain the 2020-12 conformance test
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-0
**Files:** `servers/exarchos-mcp/patches/`, `servers/exarchos-mcp/package.json`, `servers/exarchos-mcp/src/__tests__/integration/tools-list-2020-12.test.ts`
**Detail:** The patch forces draft-2020-12 and splices `type: 'object'` onto DU-rooted schemas. SEP-2106 may cover one, both, or neither — the test decides, and it is retained regardless as a conformance check rather than a patch guard.
**Tests:**
- `ToolsList_UnderV2_EmitsNative2020_12` — decides the first half empirically
- `ToolsList_DiscriminatedUnionRoot_HasObjectType` — decides the second half
**Verification:** medium — scoped tests + `check_test_adequacy`.
**Dependencies:** 049 · **Parallelizable:** No

**Wave 1a — DR-1: the IR-shaped declaration envelope (foundation)**

### Task 005: Define the IR-shaped `Declaration<K>` envelope type as the shared contract foundation
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1
**Files:** `servers/exarchos-mcp/src/contract/declaration.ts`, `servers/exarchos-mcp/src/contract/declaration.test.ts`
**Detail:** Carries `kind`, `id`, `authority`, `boundTo[]`. Additive — every existing registration compiles untouched.
**Tests:**
- `Declaration_ExistingRegistrations_CompileUnchanged` — additivity proof
- `Declaration_MissingAuthority_FailsCompile` — compile-time assertion in a non-test source file (the `_Pola*` idiom in `capabilities/resolver.ts` is the precedent; tsconfig excludes `*.test.ts`)
- `Declaration_EventActionCliVerb_ShareOneShape` — the three kinds are instances, not parallel shapes
**Verification:** high — type-level tests + `check_test_adequacy` + integration across consumers.
**Dependencies:** None · **Parallelizable:** No *(foundation for all of Wave 1)*

### Task 006: Seam accessor + `layer-boundaries-seam` rule
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-1
**Files:** `servers/exarchos-mcp/src/contract/declaration-seam.ts`, `servers/exarchos-mcp/src/architecture/layer-boundaries-seam.ts`
**Detail:** Consumers read declarations only through the accessor; a direct registry-storage read fails the seam.
**Verification:** medium — scoped tests + kill-probe (seed a direct read → seam fails).
**Dependencies:** 005 · **Parallelizable:** No

### Task 007: Prove declaration storage can relocate to the IR without editing any consumer
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1
**Files:** `servers/exarchos-mcp/src/contract/__tests__/relocation-proof.test.ts`, `servers/exarchos-mcp/src/contract/__tests__/fixtures/in-memory-ir.ts`
**Detail:** **The load-bearing proof of D2.** Without it, "IR-shaped" is a claim rather than a property, and #1258 would re-open every class this program closes.
**Tests:**
- `Relocation_StorageMovedToStandInIr_AllGuardsStillPass` — G1…G5 green after relocation
- `Relocation_RequiresNoConsumerEdit` — asserts zero diff across the 10 registry consumers
- `Relocation_DirectStorageRead_BreaksRelocation` — negative case proving the fixture has teeth
**Verification:** high — integration across the declaration seam + `check_test_adequacy`.
**Dependencies:** 005, 006 · **Parallelizable:** No

### Task 008: Migrate `registerEventType` onto the declaration envelope as the D3 bridge
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1
**Files:** `servers/exarchos-mcp/src/event-store/schemas.ts`, `servers/exarchos-mcp/src/event-store/schemas.test.ts`
**Detail:** The bridge D3 names — the same data carried through the existing seam, distinct from the `registerCustomTool` family #1708 deletes at v3.0.
**Tests:**
- `RegisterEventType_EmitsDeclarationEnvelope` — registration produces the shared shape
- `RegisterEventType_RegistrationSnapshot_ByteStable` — no drift across repeated runs
- `RegisterEventType_LegacyCallSites_Unchanged` — additivity across all 170 registrations
**Verification:** high — integration suite + `check_test_adequacy`; byte-stable registration snapshot.
**Dependencies:** 005, 006 · **Parallelizable:** No

**Wave 1b — DR-2/DR-3: event coupling (G3)**

### Task 009: Define the five-tier `EventRegistration` union so report-coupling has no constructible variant
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-2
**Files:** `servers/exarchos-mcp/src/event-store/event-registration.ts`, `servers/exarchos-mcp/src/event-store/event-registration.test.ts`
**Detail:** Makes the class unwritable at proof rung 2 rather than detected at rung 4 — the central PDD move of Wave 1.
**Tests:**
- `EventRegistration_ReportCoupledVariant_DoesNotExist` — compile-time assertion in source (tsconfig excludes `*.test.ts`, so this must not live in a test)
- `EventRegistration_ExhaustiveSwitch_CompilesTotal` — `tsc` proves the switch is total
- `EventRegistration_EachTier_CarriesCheckableFields` — per-tier shape assertions
**Verification:** high — type-level + `check_test_adequacy` + integration.
**Dependencies:** 005 · **Parallelizable:** No

### Task 010: Annotate all 170 registered event types with their tier and coupling
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-2
**Files:** `servers/exarchos-mcp/src/event-store/schemas.ts`, `servers/exarchos-mcp/src/event-store/schemas.test.ts`
**Detail:** The bulk migration. Every existing type gains a tier; the union's exhaustiveness is what proves none was missed.
**Tests:**
- `EventRegistry_AllRegisteredTypes_CarryATier` — enumeration over the registry, no gaps
- `EventRegistry_RegistrationSnapshot_MatchesGolden` — pins the 170-type surface against drift
- `EventRegistry_ReportCoupledCount_Equals25` — the G3 ratchet's seed value, asserted
**Verification:** high — exhaustive-union compile + `check_test_adequacy` + registration snapshot.
**Dependencies:** 009 · **Parallelizable:** No

### Task 011: Derive `EventEmissionSource` from tier
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-2
**Files:** `servers/exarchos-mcp/src/event-store/schemas.ts`
**Detail:** Source is derived, never independently authored; a seeded disagreement must fail.
**Verification:** medium — scoped tests + kill-probe on the seeded disagreement.
**Dependencies:** 010 · **Parallelizable:** Yes *(with 012)*

### Task 012: Boot-time `EffectProviderId` resolution check
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-2
**Files:** `servers/exarchos-mcp/src/event-store/registration-validate.ts`
**Detail:** A `capability` registration naming an unresolvable provider fails at boot.
**Verification:** medium — scoped tests + kill-probe.
**Dependencies:** 010 · **Parallelizable:** Yes *(with 011)*

### Task 013: G3 report-coupled ratchet + kill fixture
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-2
**Files:** `servers/exarchos-mcp/src/architecture/report-coupling-census.ts`, CI wiring
**Detail:** Seed at the measured 25; permit only decrease. Kill fixture = those 25. Self-test: a new report-coupled registration fails.
**Verification:** medium — scoped tests + `check_test_adequacy`. Wired to an **unfiltered** CI path (#1711).
**Dependencies:** 010 · **Parallelizable:** No

### Task 014: `WellFormedEventName` template-literal type
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-3
**Files:** `servers/exarchos-mcp/src/event-store/event-name.ts`
**Verification:** medium — type-level tests; a malformed name must fail compilation.
**Dependencies:** 009 · **Parallelizable:** Yes

### Task 015: Grammar census two-way ratchet
**Risk Tier:** medium · **Boundary Touching:** false · **Implements:** DR-3
**Files:** `servers/exarchos-mcp/src/architecture/event-grammar-census.ts`, CI wiring
**Detail:** Reuse the existing ratchet error vocabulary; unfiltered CI path.
**Verification:** medium — scoped tests + kill-probe.
**Dependencies:** 014 · **Parallelizable:** Yes

**Wave 1c — DR-4: `outputSchema` non-vacuity (G2)**

### Task 016: Vacuity detector over the registry
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-4
**Files:** `servers/exarchos-mcp/src/architecture/output-schema-census.ts` (new)
**Detail:** Enumerate declarations; classify `EnvelopeSchema(z.unknown())` as vacuous. Must report **<!-- measured: output-schema-vacuous -->111<!-- /measured -->** on introduction — its proof of a live subject.
**Verification:** medium — scoped tests + kill-probe; snapshot pins the initial count.
**Dependencies:** None · **Parallelizable:** Yes

### Task 017: G2 ratchet + allowlist with owner/expiry
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-4
**Files:** `servers/exarchos-mcp/src/architecture/output-schema-census.ts`, allowlist data file, CI wiring
**Detail:** Count may only decrease. Allowlist entries carry owner + expiry; **expiry is enforced, not advisory**.
**Verification:** medium — scoped tests + `check_test_adequacy`; unfiltered CI path.
**Dependencies:** 016 · **Parallelizable:** No

### Task 018: G2 self-test — new vacuous action fails CI
**Risk Tier:** medium · **Boundary Touching:** false · **Implements:** DR-4
**Files:** `servers/exarchos-mcp/src/architecture/__tests__/output-schema-census.selftest.test.ts`
**Detail:** Proves guard-execution failure cannot pass as success.
**Verification:** medium — scoped tests.
**Dependencies:** 017 · **Parallelizable:** Yes

### Task 019: Wire INV-17 audit to treat vacuity as a violation
**Risk Tier:** low · **Boundary Touching:** false · **Implements:** DR-4
**Files:** `.exarchos/invariants.md` (INV-17 `audit-prompt`) via `/exarchos:invariants`
**Detail:** A vacuous declaration is a violation of the precondition INV-17 names — not a pass. **Do not hand-edit catalog YAML.**
**Verification:** low — static (catalog schema validation).
**Dependencies:** 016, **068, 069** · **Parallelizable:** Yes

> **BLOCKED on dispatch, 2026-08-07 — two prerequisites discovered, both verified by the orchestrator.** The dispatched agent declined to hand-edit the catalog and reported instead; its branch is at parity with base, zero commits. That was the correct call and it surfaced a defect pair worth more than the task.
>
> 1. **There is no sanctioned way to amend an existing entry.** `invariants_add` is append-only (`appendEntryToCatalog` calls only `YAMLSeq.add`), and no `invariants_update` / `_amend` / `_edit` / `_remove` verb exists. The `/exarchos:invariants` skill's own anti-pattern table forbids hand-writing YAML. So every sanctioned surface is closed, and **catalog entries are effectively immutable once committed** — which makes DR-23's whole "invariant amendments" line item unreachable, not just this task. → **task 068**
> 2. **The field being amended has no instructed reader.** `auditPrompt` is rendered from the catalog (probe: 21/21 entries projected, INV-17 present) and returned at `check-invariant-conformance.ts:371`. Confirmed independently: it appears in exactly five files repo-wide, four of them `.test.ts`. It *does* reach the MCP caller — but the action declares `outputSchema: vacuityWaiver('exarchos_orchestrate.check_invariant_conformance')`, so it arrives through a schema constraining nothing, and no skill, command, rule or doc tells anyone to read it. **The anti-vacuity audit prompt is delivered through a vacuous output schema.** → **task 069**
>
> Amending INV-17 before both land would ship a correction nothing is directed to act on — R-11, this program's declared dominant risk, in the very task meant to close a vacuity hole. **Re-dispatch 019 after 068 and 069.** Note 027's exit does not depend on 019, so this does not block the wave exit.

### Task 068: An amend path for the invariant catalog, and write-time id uniqueness
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-23, DR-24
**Files:** `servers/exarchos-mcp/src/orchestrate/invariants/add.ts`, `servers/exarchos-mcp/src/registry.ts`, `skills-src/invariants/SKILL.md`
**Detail:** Two defects, one root: **the catalog's write path is weaker than its own read path.**

1. **No amend verb.** Every correction to a shipped entry is unreachable through the sanctioned surface.
2. **`invariants_add` accepts a colliding explicit `id` and silently appends a duplicate** (`add.ts:320-322` honors `args.id` with no membership test). It returns `success: true` with an append diff. Committing that authors a file the loader then **refuses to read** — `invariants-loader.ts:344` throws `Duplicate invariant ID`. A writer that can produce a document its own reader rejects is the defect class this program exists to remove, and it is independently worth fixing even if the amend verb never lands.

**Acceptance criteria:**
- An id-targeted, field-scoped amendment is reachable through a verb, `dryRun`-first, emitting an event so the change is auditable. Amending is not re-scaffolding: the entry's identity and un-named fields must survive.
- **Write-time validation is at least as strong as read-time.** A colliding `id` fails at write. Derive the check from the loader's uniqueness rule rather than restating it — two independent copies of one rule is the multiple-authority defect DR-6 exists to detect.
- **Kill fixture:** the exact probe that exposed this — `invariants_add` with explicit `id: "INV-17"` against a catalog already containing INV-17 — must FAIL. It currently returns `success: true`.
- **Non-empty denominator:** a uniqueness check resolving zero existing entries fails rather than passing clean.
- The skill's anti-pattern table is updated so "route mutations through `invariants_add`" stops being unsatisfiable for an amendment.

**Verification:** medium — scoped tests + kill-probe.
**Dependencies:** None · **Parallelizable:** Yes

### Task 069: Give the audit-mode path an instructed reader, and type the gate that carries it
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-4, DR-24
**Files:** `servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts`, `servers/exarchos-mcp/src/registry.ts`, the DR-4 allowlist data file, `skills-src/` as needed
**Detail:** `check_invariant_conformance` computes `auditPrompt` and returns it, but `findings[]` are produced only from `mode: 'check'` combinator trees — so an **`audit`-mode invariant contributes text to a field no skill mentions and no formatter renders.** INV-17 is audit-mode. This is why task 019 is blocked: correcting its prompt would change a string nobody is directed to read.

The second half is the sharper one. The action declares `outputSchema: vacuityWaiver(...)`, so the field crosses the boundary **untyped** — a consumer could not rely on its presence or shape even if instructed to read it. The conformance gate for a catalog containing the anti-vacuity invariant is itself on the vacuity allowlist.

**Acceptance criteria:**
- An audit-mode invariant's prompt reaches a reader that is **instructed to act on it** — a skill or command step, not merely a field on a returned object. State the consumer by file and line.
- `check_invariant_conformance` gets a substantive `outputSchema` via the sole substantive constructor (`withCappedShape`), and its `vacuityWaiver` entry is **removed** from the allowlist. Removal is a *shrink*, which the shrink-only ratchet permits; adding or swapping is not.
- **Non-empty denominator:** an audit projection resolving zero applicable entries fails rather than rendering an empty prompt that reads as a clean audit.
- **Kill fixture:** an audit-mode invariant whose prompt is never surfaced must be detectable — prove the new path RED against the current state before wiring it.

> **Sequencing:** hold until task 017 lands. 017 is concurrently editing the DR-4 allowlist data file, and 069 removes an entry from it.

**Verification:** medium — scoped tests + kill-probe.
**Dependencies:** 017 · **Parallelizable:** No

**Wave 1d — DR-5: CLI derivation guard (G1)**

### Task 020: Derivation predicate over the `buildCli` walk
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-5
**Files:** `servers/exarchos-mcp/scripts/cli-vocab-guard.ts`
**Detail:** Extend the existing walk of the rendered Commander surface with a predicate that every command/alias/flag traces to a registry declaration. Policy is **data**, not prose in a test body.
**Verification:** medium — scoped tests + kill-probe.
**Dependencies:** 005 · **Parallelizable:** Yes

### Task 021: G1 kill fixture — reject `merge-orchestrate`'s hand-written definition
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-5
**Files:** `servers/exarchos-mcp/scripts/cli-vocab-guard.test.ts`
**Detail:** The registry declaration survives, preserving `posture: 'shared-mutating'` on the single remaining definition. A guard with no current failing subject has not been shown to work.
**Verification:** medium — scoped tests + `check_test_adequacy`.
**Dependencies:** 020 · **Parallelizable:** No

### Task 022: G1 self-test — clean-vocabulary hand-written command must fail
**Risk Tier:** medium · **Boundary Touching:** false · **Implements:** DR-5
**Files:** `servers/exarchos-mcp/scripts/cli-vocab-guard.test.ts`
**Detail:** Proves the guard measures **derivation**, not vocabulary — the exact gap in today's guard.

> **Two defects task 021 found in 020's guard and correctly reported rather than fixed — 022 owns them:**
> 1. **The non-empty-denominator tooth is only half-installed.** It lives in `scanGovernedSources`; the pure `scanSourceForCommandSites` parses an empty string cleanly and returns zero sites **without throwing**. Latent today because nothing calls the pure function directly — but a future gate wired to it bypasses the protection entirely, and the whole point of the tooth is that a moved or renamed file cannot read as a clean run. Push it down to the pure function.
> 2. `cli-derivation-allowlist.json`'s `$comment` points at `cli-derivation-seam.ts`, **a filename that does not exist** — the module was renamed to `cli-derivation-guard.ts`. A stale pointer inside policy data that a future author reads to decide whether their entry is legitimate.

**Verification:** medium — scoped tests.
**Dependencies:** 020 · **Parallelizable:** No


### Task 023: Shrink-only allowlist for the hand-written top-level CLI verbs
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-5
**Files:** `servers/exarchos-mcp/scripts/cli-derivation-allowlist.json`, `servers/exarchos-mcp/scripts/cli-derivation-guard.ts`, `servers/exarchos-mcp/scripts/cli-derivation-seed-pin.ts`, `servers/exarchos-mcp/scripts/cli-derivation-ratchet-guard.ts`, `.github/workflows/ci.yml`
**Detail:** <!-- measured: cli-allowlisted-literals -->10<!-- /measured --> verbs — `doctor`, `emissions`, `feedback`, `init`, `install-skills`, `mcp`, `onboard`, `schema`, `topology`, `version` — each with owner and an ISO expiry capped by one pinned horizon. Reaches zero at DR-19.

> **Corrected at implementation, rev 4.9.** This line previously named EIGHT verbs and INCLUDED `merge-orchestrate`. Both were wrong when re-derived against the tree: the parse reports <!-- measured: cli-handwritten-literals -->11<!-- /measured --> literals (`feedback`, `schema` and `topology` were omitted), and `merge-orchestrate` is the kill fixture that G1's own Exceptions row forbids allowlisting — the shipped guard REFUSES a policy file that names it, so following this line would have produced a policy file the mechanism rejects. The tracked population is therefore <!-- measured: cli-allowlisted-literals -->10<!-- /measured -->, and it now derives.
>
> **Unowned remediation, reported not fixed.** G1's Exceptions row says `merge-orchestrate`'s hand-written command "is deleted in DR-5, not exempted", and DR-5's acceptance criteria call the registry declaration "the single remaining definition". No task in Waves 1a–1d owns that deletion, and task 023's `**Files:**` list does not include the composition root. So `cli-derivation-guard.ts` still exits 1 on exactly one violation and keeps its `GUARD_EXEMPTIONS` entry (re-scoped to name this edit); the shrink-only RATCHET is wired blocking and unfiltered as `cli-derivation-ratchet-guard.ts`. Removing a promoted top-level verb is a user-visible surface change that the `init` / `install-skills` precedent handles with a one-release rename stub — a decision, not a guard task.
**Verification:** medium — scoped tests + kill-probe (seed a 9th entry → fail).
**Dependencies:** 021, 022 · **Parallelizable:** No

**Wave 1e — DR-6: authority-topology census (G5)**

### Task 024: Model each contract boundary as data naming one authority and its bound representations
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-6
**Files:** `servers/exarchos-mcp/src/architecture/authority-topology.ts`, `servers/exarchos-mcp/src/architecture/authority-topology.data.ts`, `servers/exarchos-mcp/src/architecture/authority-topology.test.ts`
**Detail:** Policy is data the census reads, never prose inside a test body (PDD §3a).
**Tests:**
- `BoundaryModel_TwoAuthorities_IsRepresentable_AndFlagged` — the model can express the defect it must detect
- `BoundaryModel_UnboundRepresentation_IsFlagged`
- `BoundaryModel_PolicyIsData_NotTestPredicate` — asserts the rule set loads from the data file
**Verification:** high — type-level + scoped tests + `check_test_adequacy`.
**Dependencies:** 005 · **Parallelizable:** No

### Task 025: Implement the authority census so unbound or multiply-owned boundaries fail closure
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-6
**Files:** `servers/exarchos-mcp/src/architecture/authority-topology.ts`, `servers/exarchos-mcp/src/architecture/authority-topology.census.test.ts`
**Detail:** Reuses the existing census/ratchet error vocabulary (`adapter-ownership-seam.ts`, `effect-port-seam.ts`) — no new instrument.
**Tests:**
- `Census_MoreThanOneAuthority_FailsClosure`
- `Census_UnboundRepresentation_FailsClosure`
- `Census_ErrorVocabulary_MatchesExistingSeams` — no novel error codes introduced
**Verification:** high — integration + `check_test_adequacy`; census run against the real graph.
**Dependencies:** 024 · **Parallelizable:** No

### Task 026: Prove the census fails live on the CLI-surface and event-catalog rows before remediation
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-6
**Files:** `servers/exarchos-mcp/src/architecture/__tests__/authority-topology.kill-fixtures.test.ts`
**Detail:** A guard with no current failing subject has not been shown to work — 2 authorities on the CLI surface, 4 unbound representations on the event catalog.
**Tests:**
- `KillFixture_CliSurface_ReportsTwoAuthorities`
- `KillFixture_EventCatalog_ReportsFourUnboundRepresentations`
- `KillFixture_MutatingUpstreamAuthority_DropsCensusBelow100` — the `kill-fixtures.test.ts` idiom
**Verification:** high — integration + `check_test_adequacy`.
**Dependencies:** 025 · **Parallelizable:** No

### Task 027: Flip all five guards from observe to enforce and prove the Wave 1 exit
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-6, DR-24
**Files:** `.github/workflows/ci.yml`, `servers/exarchos-mcp/src/architecture/authority-topology.data.ts`, `servers/exarchos-mcp/src/architecture/__tests__/wave1-exit.test.ts`
**Detail:** Each guard ships wired to its kill fixture, proven RED, then flipped to blocking within this wave. **Wave exit is a seeded-failure test against production composition** — never "the module exists" (DR-24).

> **Exit condition restated, rev 4.7 — the original was unachievable.** `Wave1Exit_AllFiveGuards_BlockOnSeededViolation` presumes wave-1 rows are otherwise clean, so that a *seeded* violation is what turns them red. Task 025 measured the truth: **0 of 8 boundaries pass closure, with 16 findings**, and **wave-1 already carries 5 real blocking findings** — `response-shape` ×2, `phase-sequencing` ×2, and the `action-contract` enforcement claim. Blocking counts per wave are 5 → 8 → 11 → 13 → 16.
>
> A seeded-violation test is meaningless against a subject that is already failing: it cannot distinguish "the guard caught my seed" from "the guard was already red." **027 must therefore do one of two things, and choosing is part of the task:**
> 1. **Remediate the 5 wave-1 findings first**, then assert the seeded-violation test as originally written. This is the honest reading of "flip to enforce" and is preferred — but the `action-contract` finding is that the P05-05 census *does not discharge G5*, which is real work, not a data edit.
> 2. **Restate the exit condition** as *"every wave-1 row's finding population equals the measured baseline, and a seeded violation adds exactly one finding attributable to the seed."* This is achievable today and still falsifiable, because it pins the delta rather than the absolute.
>
> **Do not take a third path of moving the `action-contract` row to a later wave to make the count zero.** Task 025 deliberately left it at `already-enforced` precisely so the finding stays visible; relabelling it would erase a measured failure rather than fix it, which is the defect class this program exists to eliminate.

**Tests:**
- `Wave1Exit_AllFiveGuards_BlockOnSeededViolation` — against shipped composition, not mocks; **see the restatement above before implementing this literally**
- `Wave1Exit_EachGuardSelfTest_RunsInSameCiJob` — guard-execution failure cannot pass as success
- `Wave1Exit_AllGuardsOnUnfilteredPaths` — #1711: a path-filtered gate is skipped-as-passed on the PRs it polices
**Verification:** high — integration suite + `check_test_adequacy`.
**Dependencies:** 013, 015, 017, 023, 026, 046, 047 · **Parallelizable:** No

**Wave 1f — DR-25: bind the dispatch shape to the declared posture**

### Task 046: Add a posture-to-dispatch mapping to the two provisioning verbs
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-25
**Files:** `servers/exarchos-mcp/src/orchestrate/prepare-review.ts`, `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`, `servers/exarchos-mcp/src/agents/dispatch-shape.ts`, `servers/exarchos-mcp/src/agents/dispatch-shape.test.ts`
**Detail:** `dispatch` becomes part of the emitted contract — `read-only` → anonymous async; `task-isolated` → named plus worktree isolation; `shared-mutating` → main worktree, never a subagent. Policy is data the verb reads, not prose in a skill.
**Tests:**
- `DispatchShape_EveryDeclaredPosture_HasExactlyOneEntry` — totality over `AgentPosture`
- `PrepareReview_ReadOnlyPosture_EmitsAnonymousAsyncShape`
- `DispatchShape_ShapeContradictsPosture_FailsValidation` — self-test: a `read-only` result carrying a named-with-isolation shape is rejected
**Verification:** medium — scoped tests + `check_test_adequacy`.
**Dependencies:** None · **Parallelizable:** Yes

### Task 047: Prove today's prepare_review output fails the dispatch totality test
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-25
**Files:** `servers/exarchos-mcp/src/orchestrate/__tests__/dispatch-shape.kill-fixture.test.ts`
**Detail:** The kill fixture is the current `prepare_review` result — `posture: 'read-only'` with no `dispatch` field. A guard with no current failing subject has not been shown to work.
**Tests:**
- `PrepareReview_CurrentOutput_LacksDispatchField` — fails on introduction
- `DispatchShape_UnsupportedRuntimeCapability_ReturnsTypedError` — INV-4 fallback, never a silent no-op
**Verification:** medium — scoped tests + `check_test_adequacy`.
**Dependencies:** 046 · **Parallelizable:** No

**Wave 1-pre (rev 4) — DR-26: SDK generation seam; DR-27: measured-premise binding; DR-0 remainder**

### Task 051: Design and land a replacement Tasks-store seam for SDK v2
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-0
**Files:** `servers/exarchos-mcp/src/task-store/`, `servers/exarchos-mcp/src/adapters/mcp.ts`, `servers/exarchos-mcp/src/adapters/cli.ts`
**Detail:** v2 `2.0.0` deleted `ServerOptions.taskStore` and the `TaskStore` / `CreateTaskOptions` / `isTerminal` interfaces; `EventSourcedTaskStore` (#1272/#1273) has no v2 counterpart. The Tasks *protocol types* survive — only the server-side store wiring is gone. Unblocks the DR-0 source migration for both adapters.
**Tests:**
- `TaskStoreSeam_V2Server_PreservesEventSourcedPersistence` — the seam keeps the event-sourced guarantee
- `TaskStoreSeam_TerminalStateQuery_MatchesV1Semantics` — `isTerminal` has a behavioural replacement, not just a type one
**Verification:** high — scoped tests + `check_test_adequacy` + integration suite.
**Dependencies:** 049 · **Parallelizable:** No

### Task 052: Owned SDK seam module with generation-branded handle types
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-26
**Files:** `servers/exarchos-mcp/src/sdk/seam.ts` (new), `servers/exarchos-mcp/src/sdk/brand.ts` (new)
**Detail:** Sole importer of either generation; re-exports the used surface with `__gen: 'v1' | 'v2'` brands on every handle crossing the seam. Restores DR-0's rung-2 claim that structural typing defeated.
**Tests:**
- `SdkSeam_HandleFromOtherGeneration_FailsCompile` — the rung-2 guarantee DR-0 originally claimed
- `SdkSeam_ZeroImportSitesResolved_FailsClosed` — non-empty denominator
**Verification:** high — type-level tests + `check_test_adequacy` + integration.
**Dependencies:** 049 · **Parallelizable:** No *(foundation for the migration)*


### Task 053: Migrate the measured SDK import sites onto the seam + layer-boundaries rule
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-26
**Files:** `servers/exarchos-mcp/src/architecture/layer-boundaries-seam.ts`, plus every measured import site
**Detail:** ~~38 files across 13 directories~~ — **re-derived at dispatch: 42 import sites across 22 files in 9 directories, 10 of them non-test.** The header's `38` was never right and the `44 / 23` in Open Question 7 had drifted again; the bound premises were correct. A direct import must fail the seam rule after migration.

**Landed (rev 4.11).** All 42 sites migrated; `SDK_SEAM_BOUNDARY` in `layer-boundaries-seam.ts` rejects a direct SDK import with **zero exemptions**. Three findings reported rather than worked around:
1. **The seam lacked one surface its own tree used.** Six sites spy on `McpServer.prototype` / `Server.prototype`, which needs the constructor IDENTITY a factory cannot supply. Added `V1_MCP_SERVER_CLASS` / `V1_SERVER_CLASS` rather than exempting the modules — *a surface the tree uses and the seam lacks is a seam with a hole, not a case for an exemption.*
2. **The `cli` layer allowance widened by two directories (`sdk`, `task-store`).** The coupling is not new; it was **invisible** to the layering census, which resolves first-party edges only, so a bare package import produces no edge at all. Routing it through the seam is what made it visible.
3. **The v2 half of the seam stays unreferenced, and that is task 049's, not a defect here.** v2 has zero import sites tree-wide; 11 of the 23 knip findings on `sdk/seam.ts` are v2 surface or uninhabited holes and cannot be discharged by a v1 migration. Reported per-symbol, not allowlisted.

**Tests:**
- `SdkSeam_DirectSdkImport_FailsSeamRule` — kill fixture, seeded into the LIVE scan. Proven RED against the real pre-migration tree first: 22 modules / 42 sites rejected, no other diagnostic.
- `SdkSeam_MigratedTree_ResolvesEverySiteThroughSeam` — totality over a DERIVED population; the SDK-importing module set must equal `{sdk/seam.ts}`, with module count, seam presence, seam import count and generation coverage all checked independently of the violation count.
**Verification:** high — scoped tests + `check_test_adequacy` + integration suite.
**Dependencies:** 052 · **Parallelizable:** No

### Task 054: Measured-premise annotation + drift checker
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-27
**Files:** `scripts/check-measured-premises.mjs` (new), `docs/specs/2026-08-06-internal-mechanics-overhaul.md`
**Detail:** Annotated claims name their derivation; the checker re-derives and fails on disagreement. Scope is this spec plus `.exarchos/invariants.md` — generalizing to all of `docs/` needs its own ADR.
**Tests:**
- `MeasuredPremises_Rev3Document_ReportsDr4CountsAsDrifted` — kill fixture against a document already known wrong
- `MeasuredPremises_ZeroAnnotationsResolved_FailsClosed` — non-empty denominator
- `MeasuredPremises_UnprobedProofRung_ReportsGapNotPass` — an unprobed rung is reportable, never a pass
**Verification:** medium — scoped tests + kill-probe.
**Dependencies:** None · **Parallelizable:** Yes

### Task 055: Make `outputSchema` vacuity unconstructible + seed the shrink-only allowlist
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-4
**Files:** `servers/exarchos-mcp/src/registry.ts`, `servers/exarchos-mcp/src/architecture/output-schema-census.ts`, allowlist data file
**Detail:** `withCappedShape` is the sole substantive constructor (<!-- measured: withcappedshape-count -->12<!-- /measured --> of <!-- measured: output-schema-substantive -->12<!-- /measured -->, measured). Type `ToolAction.outputSchema` to accept only its branded return or an allowlist entry, so vacuity stops being counted and starts being unconstructible. Supersedes the rung-3 counting ratchet planned for task 017.
**Tests:**
- `OutputSchema_NewActionDeclaringVacuous_FailsCompile` — rung 2, replaces the CI-guard formulation
- `OutputSchema_AllowlistSeed_DerivedFromCensusNotLiteral` — the 112 come from the census
- `OutputSchema_AllowlistEntrySwapped_FailsRatchet` — shrink-only beats a count threshold
**Verification:** high — type-level + scoped tests + `check_test_adequacy`.
**Dependencies:** 016 · **Parallelizable:** No *(supersedes 017; re-scope 017 to allowlist expiry enforcement)*

### Task 066: Per-row evidence keys, and typecheck the `scripts/` trees
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-6, DR-24
**Files:** `servers/exarchos-mcp/src/architecture/authority-census.ts`, `servers/exarchos-mcp/tsconfig.json`, `tsconfig.json`
**Detail:** Two structural gaps, each reported by the task that hit it rather than worked around.

1. **`HOP_EVIDENCE` cannot record what task 026 proved.** It is `Record<CensusHop, HopEvidence>` — keyed by **hop**, not by (hop, row). Task 026 upgraded the `cli-surface` and `event-catalog` rows from `declared-row` to live tree measurement, but flipping the hop-level value would claim live evidence for **all eight** rows when six still have none — precisely the over-claim the field was introduced to prevent. 026 correctly left it alone and pinned the three values unchanged. **A genuine upgrade needs a per-row evidence key**, which is a change to task 025's data model.
2. **`servers/exarchos-mcp/scripts/` is typechecked by nothing.** Both tsconfigs use `include: ["src/**/*"]`, and `**/*.test.ts` is excluded everywhere. **Three separate tasks (020, 021, 026) independently discovered this and each verified their files by hand with a standalone `tsc --noEmit`** under the project's strict flags. That is three agents paying the same tax for a hole none of them was scoped to fix. The guards now living there — `cli-derivation-guard.ts`, `authority-live-proof.ts`, `cli-vocab-guard.ts` — are exactly the enforcement code that most needs type checking.

**Acceptance criteria:**
- Evidence is recorded per (hop, row), and a row with no live measurement cannot inherit another row's evidence class.
- `scripts/` is covered by a typecheck that runs in CI; widening `include` may pull in unrelated files, so scope deliberately and say what you included.
- **Non-empty denominator** on both: an evidence map covering zero rows, or a typecheck resolving zero files, fails rather than passing clean.

**Verification:** medium — scoped tests + `check_test_adequacy`.
**Dependencies:** 025, 026 · **Parallelizable:** Yes

### Task 064: `npm run validate` dies at step 1 — 16 gates never run locally
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-24
**Files:** `package.json`, `scripts/validate-plugin.sh`, `.claude-plugin/`, `hooks/hooks.json`
**Detail:** **Measured 2026-08-07, and it is worse than an inert gate — it is a whole inert *chain*.** `validate` is a <!-- measured: validate-chain-steps -->9<!-- /measured -->-step `&&` sequence. Step 1 is `scripts/validate-plugin.sh`, which **fails 5 of its 9 checks today** (`.mcp.json` absent; `plugin.json` missing a `hooks` field; `hooks.json` missing `SessionEnd`; `hooks.json` carries the retired `SessionStart`). The last step is `check-measured-premises.mjs`. So **every step after the first never executes locally**, including DR-27's own premise gate.

> **Re-derived on the landing branch by task 064, and both counts in the paragraph above were wrong when written.** The chain was **9** steps, not 17; step 1 failed **5** of 9 checks (4 passed), not 4; and there were **four** distinct causes, not three — `plugin.json` missing `hooks` was omitted. Both numbers are now annotated and re-derived by DR-27's own gate (`validate-chain-steps`, `validate-plugin-checks`), which is where an unannotated numeric claim in this document was always supposed to end up. The four causes were then all found to be the **gate** being stale rather than the package: `.mcp.json` was deleted on purpose in `2b62e1bf3`, the `hooks` field removed on purpose in `e334a392b`, `SessionEnd` dropped by DR-7/task 016, and `SessionStart` is shipped on purpose per #1485 — each contradicting a *green* assertion in `src/plugin-validation.test.ts`. Post-fix the packaging gate reports <!-- measured: validate-plugin-checks -->24<!-- /measured --> checks, all passing, and all <!-- measured: validate-chain-steps -->9<!-- /measured --> steps execute.

This is R-11 inverted: not "the mechanism ships and nothing calls it", but *"the caller exists, is invoked, and silently reaches almost none of what it names."* Task 054 wired the premise gate into `ci.yml` separately, so **CI is unaffected** — but anyone treating a local `validate` run as evidence that any gate past step 1 passed is wrong, and has been for some time.

**Acceptance criteria:**
- The four plugin-packaging failures are fixed, or each is recorded as a deliberate, expiring exception with an owner.
- **The chain cannot silently truncate again.** Either run every step and aggregate failures rather than short-circuiting, or add a check that the number of steps actually executed equals the number declared. A `&&` chain whose early step is red makes every later gate skipped-as-passed to a human reader — the same #1711 failure the program already fights in CI, one layer up.
- **Non-empty denominator:** a `validate` run that executes zero gates fails loudly rather than reporting success.

**Verification:** medium — scoped tests + the wiring manifest's self-check.
**Dependencies:** None · **Parallelizable:** Yes *(coordinate with 063, which owns the CI-side inventory)*

### Task 065: Parse specifiers in `effect-ledger.ts`'s `extractImports` — the seventh occurrence
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-26
**Files:** `servers/exarchos-mcp/src/architecture/effect-ledger.ts`
**Detail:** `extractImports` is a hand-rolled comment/string/regex-aware lexer in **shipped `src/`**, and its own header admits the regex-versus-division rule is a heuristic. Seventh candidate occurrence of the measure-the-wrong-property pattern.

**It cannot be fixed the way 058, 061 and 062 were, and that constraint is the interesting part.** Task 062 tested this directly: adding `import ts from 'typescript'` to a module under `architecture/` **fails the effect-ledger census** with `INDETERMINATE_OWNER`, because `typescript` is not in `INERT_DEPENDENCIES`. 062 declined to vet it inert, on an argument that should be preserved: *the ledger's existing inert entries all turn on "the effectful surface is unreachable from what we import", and `import ts` puts `ts.sys` — full filesystem and process access — one property access away.* The module cannot honestly claim inertness for the compiler.

062's own resolution is the precedent: **invert the parse to the caller as a required port**, matching `architecture/import-cycles.ts`, which takes dependency-cruiser JSON rather than running it. The parser implementation lives in `src/test-helpers/`, the only directory both excluded from the effect ledger and inside `tsconfig.json`'s `include`, so it is still typechecked.

**Acceptance criteria:**
- `extractImports` either takes a parser port or is proven correct against the adversarial set (`//` inside a string, `/* */` inside a template, a regex literal containing a quote, nested template substitution).
- **Kill fixture:** an input where the heuristic and a real parse disagree, with both numbers asserted.
- The shipped bundle stays byte-identical — 062 verified its own change that way (`bun build`, 991 modules / 5.16 MB, containing neither parser symbol).

**Verification:** medium — scoped tests + `check_test_adequacy`.
**Dependencies:** 062 · **Parallelizable:** Yes

### Task 067: `validate-no-legacy` is red — the wave's own proof idiom reads as dead code
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-24
**Files:** `scripts/audit/knip-diff.ts`, `scripts/audit/knip-allowlist.json`, `knip.json`
**Detail:** **Measured 2026-08-07 on the integration tip `077dd5151`:** `bash scripts/validate-no-legacy.sh` exits 1 with `[knip-diff] FAIL (unallowlisted): 94 dead-code finding(s)`. This is a **blocking CI job** (`ci.yml:627`, rolled into `CI Gate` at `ci.yml:1279`), so the whole wave cannot merge to `main` until it is green. It was 81 findings when first recorded and has grown with each landed task — it scales with the wave, which is what makes an allowlist-per-finding the wrong shape.

**The 94 split three ways, and only one third is this task's to allowlist:**

1. **69 `_`-prefixed compile-time proof aliases** (`_DeclarationMissingAuthority_FailsCompile`, `_EventRegistration_ReportCoupledVariant_HasNoConstructibleForm`, …) across `contract/declaration.ts`, `event-store/event-registration.ts`, `event-store/event-declarations.ts`, `event-store/event-annotations.ts`, `architecture/authority-census.ts`. **These are not dead code — they are the wave's rung-2 proof mechanism.** They must live in non-test sources precisely because `tsconfig.json` excludes `*.test.ts`, which is what makes `tsc` the prover. knip sees an unreferenced exported type and is correct on its own terms; the terms are what need stating.
2. **23 `src/sdk/seam.ts` findings** (9 `export`, 14 `type`) — `createV1Server`, `V1TaskStore`, `V2StdioClientTransport`, … **Do not allowlist these.** They are unreferenced because task 052 landed the seam and **task 053 has not yet migrated the import sites onto it** — this is a true R-11 reading (the mechanism ships and nothing calls it) and it is *correct* for the guard to say so. They resolve when 053 lands, and if they do not, that is 053 failing its own totality test.
3. **2 `file` findings** — `scripts/measured-premises-derive.ts` (task 054) and `architecture/__fixtures__/declaration-seam-violator.fixture.ts` (tasks 006/007). **Determine which they are before deciding.** Either knip's entry-point config cannot see a real caller (a config gap), or nothing calls them (R-11 again, in the wave's own new code — the honest outcome is to wire the caller, not to allowlist the finding).

**Acceptance criteria:**
- The proof-alias convention is exempted **by a rule knip evaluates**, not by 69 hand-written allowlist rows — a JSDoc tag (`@proof`) consumed via knip's `tags` config, or an equivalent config-level predicate. An allowlist that must be appended to on every future proof alias re-creates the drift this task exists to remove.
- **The exemption is bounded and cannot silently widen.** It must match the proof idiom specifically, not "any unreferenced exported type". Kill fixture: a genuinely dead exported type that does **not** carry the convention still fails the sweep.
- **Non-empty denominator:** an exemption rule matching zero symbols, or a knip run resolving zero files, fails rather than passing clean.
- The seam's 23 findings are **left failing** and recorded as 053's subject; state the post-053 expected count so the next runner can falsify it.
- `bash scripts/validate-no-legacy.sh` exits 0 with the seam findings either resolved by 053 or carrying a dated, owned, expiring entry that names 053 as the discharge.

**Verification:** medium — scoped tests + kill-probe (a non-conforming dead export must still fail).
**Dependencies:** None *(coordinate with 053, which discharges group 2)* · **Parallelizable:** Yes

### Task 070: The guard inventory cannot see a guard hosted inside a wrapper script
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-24
**Files:** `scripts/guard-inventory.ts`, `scripts/guard-inventory.test.ts`
**Detail:** **`GuardInventory_EveryWave1Guard_IsReachableFromACiJob` is RED on the integration branch** — reproduced by the orchestrator at rev 4.11: 1 failed / 30 passed, `scripts/audit/knip-diff.ts [unwired-guard] no CI job executes it and no expiring reason is recorded`.

**Provenance, recorded because it matters more than the fix.** Nothing about knip-diff's wiring changed. **The spec did.** Rev 4.10 filed task 067 and named `scripts/audit/knip-diff.ts` on its `**Files:**` line, which pulled the path into the inventory's *second* discovery channel — "Wave-1 task `**Files:**` entries parsed out of the spec" — for the first time. The inventory then measured it and, correctly by its own lights, could not find a host. This is the third time task 063's discovery channels have surfaced a fact by widening (see the `validate-plugin.sh` and `cli-derivation-guard.ts` reconciliations in `ab7f2a83e`), and it is the channel working as designed.

**But the verdict is wrong, and that is the defect.** `knip-diff.ts` *is* executed in CI: `.github/workflows/ci.yml` runs `bash scripts/validate-no-legacy.sh`, and that script invokes `"$TSX_BIN" "$KNIP_DIFF"` where `KNIP_DIFF="$SCRIPT_DIR/audit/knip-diff.ts"`. **The host resolver does not follow a `bash <script>` run-step into the script's contents**, so any guard hosted one level of indirection deep reads as unwired.

**Do NOT add a `GUARD_EXEMPTIONS` entry.** The guard is not unwired, so the exemption would record a reason that is false — a wiring lie of exactly the kind the inventory's own stale-exemption tooth exists to catch. Task 017 identified this and declined it; do the same.

**Acceptance criteria:**
- The resolver resolves **indirect hosting**: a guard invoked by a shell script that a CI run-step invokes is reachable, and the reported host names the real chain (job → script → guard), not just the job.
- **Fix the class, not the path.** Special-casing `validate-no-legacy.sh` leaves the next wrapper-hosted guard mis-reported. If you bound the indirection (e.g. one level), say so explicitly and state what that misses.
- **Do not shrink the denominator to make the number go away.** Narrowing channel 2 so a task's `**Files:**` line stops classifying pre-existing infrastructure would remove the finding by removing the measurement — the precise anti-pattern this program exists to eliminate. If you believe `knip-diff.ts` is genuinely out of the Wave-1 guard population, argue it on what a guard *is*, not on what makes the test green.
- **Kill fixture:** a guard invoked only from a wrapper script must be reported reachable, **and** a guard invoked from nothing must still be reported unwired. Prove both — an indirection rule that reports everything reachable is vacuous.
- **Non-empty denominator:** a resolver that walks zero run-steps, or zero wrapper scripts, fails rather than reporting clean.

**Verification:** medium — scoped tests + kill-probe (both directions).
**Dependencies:** None *(coordinate with 067, which owns `knip-diff.ts`'s other half)* · **Parallelizable:** Yes

### Task 071: `batch_append` does not validate event data; `append` does
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-24
**Files:** `servers/exarchos-mcp/src/event-store/`, the `exarchos_event` handlers
**Detail:** **Measured 2026-08-07 by the orchestrator, against the live store.** `task.completed` registers `evidence` as an **object** — `{type: 'test'|'build'|'typecheck'|'manual', output: string, passed: boolean}`, `additionalProperties: false`. Emitting that event through `append` with `evidence` as a **string** is correctly rejected:

```
VALIDATION_ERROR: Event data validation failed for type 'task.completed':
  evidence: Invalid input: expected object, received string
```

Emitting **the identical payload** through `batch_append` **succeeds**. Six such events are on the `internal-mechanics-overhaul` stream right now (sequences 152–157), each carrying a `string` where the registered schema declares an object. Confirmed by querying them back — the malformed value is what was stored, not a rendering artifact.

**This is the same defect class as task 068's**, one layer down: a schema that exists, is enforced on one write path, and can be bypassed entirely by choosing the other door. It is worse than 068's, in one specific way — 068's duplicate id is caught later by the *reader*, so the damage surfaces. Here the event store is the authoritative record, events are immutable, and **nothing downstream re-validates**, so malformed data is permanent and silent. Every projection over `task.completed.evidence` must now defend against a type the schema says cannot occur.

**Acceptance criteria:**
- `batch_append` validates each event against its registered schema, with the **same** validator `append` uses — shared, not a second implementation. Two validators is the multiple-authority defect DR-6 exists to detect, and it is how the paths diverged in the first place.
- **Atomicity is a decision, not an accident.** State whether one invalid event rejects the whole batch or only itself, and make the tests say which. Silently appending the valid subset would trade one silent failure for another.
- **Kill fixture:** the exact payload above — `task.completed` with a string `evidence` — must fail through `batch_append`. It currently succeeds.
- **Non-empty denominator:** a batch resolving zero events, or a validator resolving zero registered schemas, fails rather than passing clean.
- **Do not migrate or rewrite the six existing events.** They are immutable history and the record of this defect. Determine instead whether any projection reads `evidence` and would break on the string form; report what you find.

**Verification:** high — scoped tests + kill-probe + integration over the real store.
**Dependencies:** None · **Parallelizable:** Yes

### Task 072: Three more near-duplicate lexers, now that a real one exists
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-26
**Files:** `servers/exarchos-mcp/src/architecture/vcs-ownership.ts`, `servers/exarchos-mcp/src/workflow/admission/remediation-purity.ts`, the `delivery-safety` module, `servers/exarchos-mcp/src/test-helpers/module-lexer.ts`
**Detail:** Reported by task 065 against its own work. Having replaced `effect-ledger.ts`'s hand-rolled lexer with a real parse behind a caller-supplied port, 065 named three surviving instances of the same construct:

- `architecture/vcs-ownership.ts :: stripComments`
- `workflow/admission/remediation-purity.ts :: extractImportSpecifiers`
- `delivery-safety :: maskLiteralsAndComments`

Each is an **eighth-occurrence candidate** of the measure-the-wrong-property pattern. This is not speculative: 065 measured its own subject and found the heuristic wrong in **both** directions — a regex containing a backtick hid a real `node:fs` import from the scan entirely (heuristic 0 specifiers, parse 1), and a nested template substitution made it **invent** an effect that was not there (heuristic 1, parse 0), falsifying that module's own written promise that it "never invents one". 065 also found `import('p').T` type queries miscounted as value imports, and flagged that class as likely present in these three.

**The work is now cheap, which is why it is worth doing:** `src/test-helpers/module-lexer.ts` already exists, already returns both `imports` and `maskedSource` from one parse, and already lives in the only directory both excluded from the effect ledger and inside `tsconfig.json`'s `include`. The port pattern is established.

**Acceptance criteria:**
- Each of the three either adopts the existing port or is **proven correct against 065's `ADVERSARIAL_SET`** — do not write a fourth adversarial table.
- **Per-site kill fixture with both numbers asserted.** 065's own rule: a table on which the two instruments never differ fails, rather than silently leaving the port unmotivated. If a site genuinely has no disagreeing input, say so and justify leaving it alone — that is a real possible outcome, not a failure.
- Check each for the `import('p').T` miscount specifically.
- **Non-empty denominator** on every scan, and **no cast-budget spend**.
- The shipped bundle stays byte-identical; 065 verified both `--target=bun` and `--target=node` at 991 modules with matching md5s.

**Verification:** medium — scoped tests + kill-probe per site.
**Dependencies:** 065 · **Parallelizable:** Yes

### Task 073: `invariants_amend` re-flows entries it was not asked to touch
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-23, DR-24
**Files:** `servers/exarchos-mcp/src/orchestrate/invariants/catalog-file.ts`, `servers/exarchos-mcp/src/orchestrate/invariants/amend.ts`
**Detail:** Found by task 019 against task 068's verb, on the first real use of it.

`invariants_amend` advertises itself as **id-targeted and field-scoped**, and semantically it is. But committing re-serializes the **whole frontmatter document**, so `yaml`'s line-width folding re-wraps folded scalars in unrelated entries. Task 019's one-field amendment to INV-17 produced a **69-insert / 34-delete** diff, roughly 35 lines of which were cosmetic re-wrap of INV-2 and INV-11.

019 proved it is whitespace-only — parsing before and after and diffing the parsed entries yields exactly one semantic change (`INV-17: enforcement`), 21/21 entries intact, markdown body byte-identical. **So it is diff noise, not content drift.** It is still not harmless, and 019 is the evidence:

- The catalog is a **frozen contract authority** whose digest is taken over the **raw file text**. The collateral re-wrap moves that digest exactly as much as the real edit does, so task 019 had to re-run the authority generator and perform the review-and-approve gesture (`CURRENT_APPROVER` bump) for what was semantically a two-string-literal change.
- **Every future one-field amendment will therefore drag a contract re-approval along with it**, and a reviewer reading the diff cannot separate the amendment from the reflow without running a parse-level comparison. That is a review surface that punishes the correct, sanctioned path — the one DR-23 exists to make usable.

**Acceptance criteria:**
- An amendment writes back **only the amended entry's serialized lines**, spliced into the original text, rather than round-tripping the whole document. Sibling entries are byte-identical.
- **Kill fixture:** amend one field of one entry in a catalog whose siblings carry folded scalars, and assert the diff touches only that entry — proved on the raw text, not the parsed form, because raw text is what the digest covers.
- **Non-empty denominator:** a splice that matches zero lines, or a write that resolves zero entries, fails rather than passing clean.
- State whether the authority digest still moves for a genuine wording change. It should — the catalog's wording is a load-bearing generation input — but it must move for the amendment and nothing else.

**Verification:** medium — scoped tests + kill-probe on the raw-text diff.
**Dependencies:** 068 · **Parallelizable:** Yes

### Task 074: Filename-coupled entrypoint predicates — a silent no-op on rename
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-24
**Files:** `servers/exarchos-mcp/scripts/cli-derivation-guard.ts`, `servers/exarchos-mcp/scripts/cli-vocab-guard.ts`, `servers/exarchos-mcp/scripts/generate-docs.ts`
**Detail:** Found and measured by task 018 while fixing the fourth instance.

A guard that self-executes via `process.argv[1].endsWith('<its own filename>')` couples **whether it runs** to **what it is called**. Task 018 measured the consequence on `output-schema-ratchet-guard.ts`: a byte-identical copy under any other name printed **0 bytes on stdout, 0 on stderr, and exited 0**. So renaming the guard and updating its `ci.yml` `run:` step — the ordinary meaning of "rename a file" — leaves CI with a step that exists, runs, resolves, and **enforces nothing**.

It is invisible to everything that would otherwise catch it. `guard-inventory` still reports the host as direct and unfiltered; the guard's own unit suite never spawns a process, so it reads the return value of a function that CI never reaches. This is R-11 with the mechanism *present and invoked* — the caller exists and still gets nothing.

018 fixed its own instance using the idiom the repo already has in `scripts/validate-plugin.mjs` and `scripts/run-validate.mjs` (resolved `argv[1]` vs `fileURLToPath(import.meta.url)`, plus `realpathSync` so a filename-shaped no-op is not traded for a symlink-shaped one), and left the other three, correctly, as out of scope.

**The three remaining, with their live exposure:**
- `cli-derivation-guard.ts` — currently `unreachable` with a `GUARD_EXEMPTIONS` entry, so **the hole goes live the moment task 020's guard is wired**. This is the one that matters.
- `cli-vocab-guard.ts` — reached only via `npm run cli:vocab-guard`. **Runs under `bun`**, whose `import.meta.url` / `argv` semantics 018 could not verify and neither should you assume; check them.
- `generate-docs.ts` — a build script, lowest exposure.

**Acceptance criteria:**
- All three use the resolved-path idiom. **The repair is the same four lines each** — the value is in closing the class, not in the individual edits.
- **Kill fixture per site:** a byte-identical copy under a different name must still enforce. 018's `LegacyFilenamePredicate_GoesSilentlyGreen` is the shape to follow, including its refusal to pass when the mutation cannot be applied (a mutation that silently produces an unmutated copy must FAIL, not pass).
- Verify the `bun` case empirically rather than by analogy with Node.
- **Non-empty denominator:** a self-test that spawns zero processes, or resolves zero guard files, fails rather than passing clean.
- Consider whether `guard-inventory` can detect the class structurally — a guard whose `hasDirectRunExit` is satisfied but whose predicate tests a filename is exactly the "declared, enforced, cannot fail" shape this program removes. If it can, that is worth more than the three edits.

**Verification:** medium — scoped tests + per-site kill-probe.
**Dependencies:** None *(coordinate with 020/023 on `cli-derivation-guard.ts`)* · **Parallelizable:** Yes

### Task 075: Collapse `EVENT_NAME_PATTERN` into the DR-3 grammar — a public-seam behaviour change
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-3, DR-6
**Files:** `servers/exarchos-mcp/src/event-store/schemas.ts`, `servers/exarchos-mcp/src/event-store/event-name.ts`, migration notes
**Detail:** Two authorities decide what an event name may be, and they disagree on **<!-- measured: event-name-pattern-divergence -->25<!-- /measured --> of 171** live names. Found by task 014, measured on the runtime path by task 015, and recorded by 015 as an owned, dated, two-way-checked concession rather than fixed — because fixing it changes a public runtime seam.

- `EVENT_NAME_PATTERN` (`schemas.ts`) is `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/` — **no `_` in either character class** — so it rejects 25 of its own built-ins. It has never failed because `registerEventType` applies it **only to custom registrations**; the built-ins are a literal array never fed through it. A validator its own authoritative corpus fails, invisible because it is never pointed at that corpus.
- The DR-3 grammar (`event-name.ts`, task 014) was derived from all 171 registered names and accepts every one of them, but is **narrower** than the shipped pattern in the other direction: no digits, single-word namespaces.

So the two disagree in **both** directions, and the runtime half is the permissive one: `registerEventType('my-app.started2', …)` **succeeds today** and lands a grammar-violating name in the live registry. That is the population no type can quantify over — which is exactly why task 015's census enumerates `getValidEventTypes()` rather than `EventTypes`.

**The change:** make `registerEventType` consume `isWellFormedEventName` and delete `EVENT_NAME_PATTERN`. That collapses two authorities into one, which is what DR-6 wants.

**Why it is its own task, and high tier.** It is a breaking change to a public seam. Custom names with digits (`deploy.v2`) or multi-word namespaces (`my-app.started`) **stop registering**; snake_case **starts**. `ExarchosConfig.events` lets users declare event types this repo knows nothing about, so real user configs can break at load.

**Acceptance criteria:**
- One authority decides name well-formedness. The census's `divergesFromShippedPattern` concession is **retired**, not re-dated — and task 015 wired the stale direction so leaving it standing after the repair trips `STALE_SEED_ENTRY`. Let that fire; do not silence it.
- **Re-examine the no-digits clause against evidence before adopting it as the runtime rule.** Task 014 chose it deliberately (0 of 171 built-ins use a digit, so the strict reading was the falsifiable one) but built-ins are not the population at risk here — user-registered names are, and `deploy.v2` is an ordinary thing to want. Decide on measured user-config evidence, and say what you measured.
- A migration note: what breaks, what starts working, and what a user with an affected name does. INV-1 makes renaming a registered event a log-compatibility break, so the note must cover already-persisted streams.
- **Kill fixture both ways:** a name the old pattern admitted and the grammar rejects must now fail *with a message naming the migration*, and a name the old pattern rejected (snake_case) must now succeed.
- **Non-empty denominator:** a validator resolving zero names fails rather than passing clean.

**Verification:** high — scoped tests + `check_test_adequacy` + integration over the registration seam and a replay of persisted streams.
**Dependencies:** 014, 015 · **Parallelizable:** Yes

### Task 076: DR-5's remediation is unowned — delete `merge-orchestrate`'s hand-written command
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-5
**Files:** `servers/exarchos-mcp/src/adapters/cli.ts`, a rename-stub release note
**Detail:** **This blocks task 027's G1 flip.** Found by task 023 while seeding the allowlist.

G1's Exceptions row says `merge-orchestrate`'s hand-written command "is deleted in DR-5, not exempted", and DR-5's criteria call the registry declaration "the single remaining definition". **No Wave-1 task owns that edit.** Task 023's Files list excludes `cli.ts`, and the shipped `readPolicy` refuses a `merge-orchestrate` allowlist entry outright — so following task 023's own Detail line verbatim (which named `merge-orchestrate` among 8 verbs) would have produced a policy file the mechanism rejects. 023 measured this, declined to widen its scope, and reported it.

**Consequence, stated plainly:** `cli-derivation-guard.ts` still exits 1 — on 1 violation now rather than 11 — so **it cannot be wired direct-and-blocking**, and `GUARD_EXEMPTIONS` still carries an entry for it. 023 narrowed that entry to name this deletion as the blocker rather than leaving it pointing at itself. Task 027 cannot flip G1 to enforce until this lands.

**Why it is a decision, not a guard task.** Removing a promoted top-level verb is user-visible. The repo's own precedent for this (`init` / `install-skills`) is a one-release rename stub, so the shape is known — but choosing to spend it, and writing the note, is a judgement call that does not belong inside a ratchet task.

**Acceptance criteria:**
- The hand-written `.command('merge-orchestrate')` literal is gone from `cli.ts`; the registry declaration survives, preserving `posture: 'shared-mutating'` on the single remaining definition.
- A rename stub or deprecation path following the `init`/`install-skills` precedent, with the release note saying what users type instead.
- `cli-derivation-guard.ts` exits **0** on the live tree, its `GUARD_EXEMPTIONS` entry is **removed** (not re-dated), and `guard-inventory` reports it `enforcement: blocks`, `pathFilteredOnly: false`, `via=direct`.
- **Kill fixture survives:** task 021's proof that the guard rejects a hand-written `merge-orchestrate` definition must still have a subject — re-seed it as a fixture rather than deleting the test with the code.
- **Non-empty denominator:** the guard must still fail if it resolves zero command sites (task 022 pushed that tooth into the pure scanner; do not route around it).

**Verification:** high — scoped tests + `check_test_adequacy` + CLI parity over the removed verb.
**Dependencies:** 020, 021, 022, 023 · **Blocks:** 027 · **Parallelizable:** No

### Task 077: The waiver-ledger idiom is triplicated
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-6, DR-24
**Files:** a new dependency-free `waiver-ledger` module; `servers/exarchos-mcp/src/architecture/output-schema-census.ts`, `report-coupling-census.ts`, `servers/exarchos-mcp/scripts/cli-derivation-ratchet-guard.ts`
**Detail:** Reported by task 023 against its own work, having just written the third copy.

`isIsoDay` / `isoDayUtc` / `daysBetween` / the key-set digest now exist **independently three times** — DR-4's `output-schema-census.ts` (task 017), DR-2's `report-coupling-census.ts` (task 013), and DR-5's `cli-derivation-ratchet-guard.ts` (task 023). The vocabulary is identical by deliberate discipline, which is why nothing has diverged yet; three copies of one rule is nonetheless exactly the multiply-owned-representation defect DR-6's census exists to detect, and this program should not be accumulating instances of it.

**One copy is already weaker than the others:** DR-2's rolls its own `isExpired` and has **no horizon pin**, so per-entry renewal is possible there in a way tasks 017 and 023 both deliberately made impossible.

023 declined to extract, with a reason worth preserving: `output-schema-census.ts` imports `TOOL_REGISTRY`, and pulling it into the CLI guard would destroy that guard's load-bearing property of not reaching `bun:sqlite`. So the extraction must go the other way — a dependency-free module the three delegate to.

**Acceptance criteria:**
- One `waiver-ledger` module, importing nothing, taking an **injected subject descriptor** so each census supplies its own population and finding vocabulary. All three delegate; no copy retains its own date arithmetic or digest.
- **DR-2 gains a horizon pin** in the process — the extraction is the moment to close that gap, not to preserve it.
- **Kill fixture per consumer:** each census's existing expiry and shrink-only tests must still bite after delegation. Prove it by mutation, not by the suite merely staying green.
- The CLI guard's no-`bun:sqlite` property is preserved and asserted, since that is why the extraction has this shape.
- **Non-empty denominator** in the shared module: a ledger resolving zero entries fails rather than passing clean.

**Verification:** medium — scoped tests + per-consumer kill-probe.
**Dependencies:** 013, 017, 023 · **Parallelizable:** Yes

### Task 063: Inventory every Wave-1 guard and prove it is reachable from CI
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-24
**Files:** `scripts/guard-inventory.ts`, `.github/workflows/ci.yml`, `scripts/enforcer-wiring-manifest.json`, guard modules as needed
**Detail:** **R-11 — "the mechanism ships and nothing calls it" — is this program's declared dominant risk, and Wave 1 has been accumulating instances.** Three are already recorded by the tasks that shipped them, each reported against its own work:
- `resolveDispatchShape` (task 046) — no production caller; exercised only by tests, with task 047 as its second test consumer.
- `auditVacuityRatchet` / `auditVacuitySeedIntegrity` / `auditVacuityAllowlist` (tasks 055, 060) — driven **only** by co-located vitest. The pre-existing `auditVacuityAllowlist` is called by no production code either, so this is inherited, not introduced.
- `cli-derivation-guard` (task 020) — correct and complete, but exits 1 on the landing branch by design and cannot be wired blocking until task 023 populates the allowlist.

Task 054 already demonstrated the failure mode is live rather than theoretical: registering its gate surfaced that **`npm run validate` is invoked by no workflow**, so a validate-only wiring would itself have been R-11. The repo's `enforcer-wiring-manifest.json` has a class for exactly this (`unreachable-npm`).

**Acceptance criteria:**
- A single inventory enumerates every guard Wave 1 shipped and records, per guard: its CI job, whether that job is path-filtered, and whether it currently blocks or observes.
- **Every guard is reachable from a CI job** — or carries a recorded, expiring reason why not (task 020's allowlist dependency is the legitimate example).
- **Non-empty denominator:** an inventory resolving zero guards fails rather than passing clean.
- **Path-filtered hosting is reported, not silently accepted** — #1711's skipped-as-passed failure is the reason this DR exists.

**Sequencing:** before **task 027**. Task 027 asserts the Wave-1 exit condition, and discovering an unwired guard at the join point would block every remaining task at once. This task front-loads that discovery.
**Verification:** medium — scoped tests + the wiring manifest's own self-check.
**Dependencies:** 020, 025, 046, 055, 060 · **Parallelizable:** Yes

### Task 062: Parse specifiers in `collectSdkImports` — the fifth occurrence, and it blocks task 053
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-26
**Files:** `servers/exarchos-mcp/src/architecture/sdk-generation-seam.ts`
**Detail:** **The same defect, a fifth time — and this instance is load-bearing, not cosmetic.** `collectSdkImports` matches specifiers with a regex carrying **no comment or string-literal exclusion**, so SDK specifiers written inside template literals count as imports. The lint's own fixture file, `sdk-generation-seam.test.ts`, contains ten such specifiers as *test input*.

**Why this blocks task 053.** DR-26's `bypassSiteCount` denominator currently includes those ten fixture strings. They are not imports and can never be migrated, so **the denominator cannot reach zero** — task 053 would be asked to drive a count to zero that is arithmetically floored above it. A migration gate that cannot succeed is worse than no gate.

It also explains a measurement disagreement worth preserving: task 052 published 053's backlog as **56 sites / 24 files / 10 dirs**, measured with this very regex. Task 061's AST parse gives **46 sites / 23 files / 9 directories** (10 non-test). The entire delta is that one fixture file. **053's backlog is 46/23/9 — not 56/24/10, and not the original 38.**

**Acceptance criteria:**
- `collectSdkImports` resolves real import/export specifiers; a specifier inside a comment, string, or template literal is not an import site.
- **Kill fixture:** the lint's own `sdk-generation-seam.test.ts` drops from 10 counted sites to 0. Assert both numbers so the defect's size is pinned.
- **Non-empty denominator:** a scan resolving zero modules fails rather than passing clean.
- `bypassSiteCount` becomes a denominator that **can** reach zero, and a test asserts that property directly.

**Verification:** medium — scoped tests + `check_test_adequacy`.
**Dependencies:** 052 · **Parallelizable:** Yes *(must land BEFORE 053)*

### Task 061: Parse specifiers in DR-27's import scanner instead of matching raw text
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-27
**Files:** `scripts/check-measured-premises.mjs`, `docs/specs/2026-08-06-internal-mechanics-overhaul.md`
**Detail:** **The defect class has now appeared a fourth time, inside the instrument built to catch it.** `sdkImportFiles` matches raw file text (`source.includes('@modelcontextprotocol/sdk')`), so a file that merely *names* the package in a comment counts as an import site — the identical text-versus-parse error task 058 corrected in the cast census, reproduced one boundary over in DR-27's own scanner. An instrument that measures text while claiming to measure imports is an unbound claim living inside the mechanism whose purpose is to bind claims.

Measured by parsing actual specifiers (task 052): **26 files across 13 directories** repo-wide — 25 excluding the lint's own fixture file — not 38. **The directory count was right; the file count is inflated by ~46%.**

**Landed (task 061).** That estimate understated the defect on both axes. Re-derived against this branch with a real parse, the claim's own scope (`servers/exarchos-mcp/src`, owned seam excluded) is **23 files across 9 directories**, down from the 40 / 13 actually in the document — the file count was inflated by **74%**, not 46%, and the directory count was **not** right. Repo-wide the parse gives **26 files / 12 directories**. 052's own figures were measured with the seam's `collectSdkImports` regex, which reads specifiers but not comment/literal context, so they carry the same defect one rung down; see Open Question 7 for the full old → new record and for task 053's corrected backlog.

**Acceptance criteria:**
- The scanner parses import/export specifiers rather than matching substrings. A package named only in a comment or a string is **not** an import site.
- **Kill fixture:** a file whose sole mention of the package is in a comment counts **0**; the same file with a real import counts **1**. Under today's scanner both count 1.
- The affected literals in this document are re-derived and updated in the same commit, with old and new recorded so the correction is auditable and cannot be confused with a real change in the tree.
- **Sweep the other `kind: 'scan'` derivations for the same defect** — `cli-handwritten-literals` already blanks comments, so the pattern is known to the codebase; the question is which others don't.

**Verification:** medium — scoped tests + `check_test_adequacy`.
**Dependencies:** 054 · **Parallelizable:** Yes *(but land before 053 relies on the count)*

### Task 060: Close the two residual holes in DR-4's compile-time claim
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-4
**Files:** `servers/exarchos-mcp/src/output-schema-declaration.ts`, `servers/exarchos-mcp/src/output-schema-vacuity-allowlist.ts`, `servers/exarchos-mcp/src/config/register.ts`
**Detail:** Task 055 made vacuity unconstructible and **reported two holes against its own claim rather than letting them pass.** Both are real and neither is unguarded, but the type system alone does not close them.

1. **`unregisteredActionOutputSchema()` is a compile-time bypass.** `config/register.ts` (custom tools from `.exarchos.yml`) and `contract/oracle/fixtures.ts` (the oracle probe) construct `ToolAction` with no compile-time-known action name, so they cannot use the allowlist union. A **new registry action** could call the same escape and compile. The runtime audit still reports it as `UNWAIVED_VACUITY`, so the failure is detected — but at rung 3, not rung 2, which is a weaker guarantee than DR-4 claims. Close it by making the escape unreachable from the registry construction path (a distinct nominal type for extension-declared actions is the obvious route), **not** by deleting the extension path.
2. **A swap that edits the allowlist file is not caught by the runtime audit alone.** Detecting "only removals happened" needs prior state. Task 055 deliberately declined a frozen seed or digest pin, on the precedent of the repo's own `LEGACY_SHAPE_DEBT`, leaving the growth tooth as the compile-time union — adding an id means editing a file headed `GENERATED SEED`, which is the reviewable act. **Task 017 owns the decision**: either accept the reviewability argument explicitly, or add the `retiredAt` + key-set digest that closes it fully. Recording it so the choice is made rather than inherited.

**Tests:**
- `OutputSchema_RegistryActionUsingExtensionEscape_FailsCompile`
- `OutputSchema_AllowlistIdSwappedInPlace_FailsTheShrinkOnlyCheck` *(only if 017 chooses the digest route)*
**Verification:** medium — scoped tests + `check_test_adequacy`.
**Dependencies:** 055 · **Parallelizable:** Yes

### Task 058: Correct the cast census to measure assertions, not text
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-24
**Files:** `scripts/tsconfig-strictness/count-casts.ts`, `src/tsconfig-strictness.test.ts`
**Detail:** **The cast census is itself an instance of this program's defect class** — a guard that is declared, enforced, and measures a property other than the one it names. `AS_CAST` matches `\bas\s+…[A-Za-z_$][\w$]*` over **raw source text**, so it counts English prose in comments ("as a", "as an") and **namespace imports** (`import * as path`) as type assertions. Neither is a cast. On the landing branch a large fraction of the 3258 matches are not assertions at all — the exact same shape as `cli-vocab-guard` binding *vocabulary* instead of *derivation* (DR-5) and `outputSchema` recording *presence* instead of *substance* (DR-4). **A budget of 5 that a JSDoc comment can consume is not measuring type debt.**

Task 057 established the second half of the problem: the two assertions pin the count into the closed window `[BASELINE, BASELINE+5]`, always six values wide, so **paydown slides the window and never widens it**. Removing 37 casts bought exactly what removing 6 would have. The wave's real constraint is therefore **5 net new matches across all remaining tasks combined** — and under the current census, ordinary documentation consumes it.

**Acceptance criteria:**
- The census counts **type assertions only**: comments and string literals are stripped before matching, and `import * as X` / `export * as X` are excluded.
- `as const`, `as unknown`, `as any` and `as <Type>` in real expression position are still counted — the correction removes false positives, it must not create false negatives.
- **Kill fixture:** a source containing `// treat this as a hint` plus `import * as path from 'node:path'` plus one genuine `x as Foo` must count **exactly 1**. On the current census it counts 3.
- **Non-empty denominator:** a census resolving zero files fails rather than passing clean.
- `BASELINE` is re-derived from the corrected census in the same commit; **`DELTA_BUDGET` stays at 5** — now denominated in real assertions, which makes it a meaningful constraint rather than a documentation tax.
- **Provenance:** the commit records old and new counts and states that the baseline change reflects a *measurement correction*, not a paydown, so the PR #1733 history stays interpretable.

**Verification:** high — scoped tests + full root suite + `check_test_adequacy`.
**Dependencies:** 057 · **Parallelizable:** No *(it redefines the measurement every other task is judged against)*

### Task 059: Deep-freeze dispatch fallbacks + close the last prose-binding cell
**Risk Tier:** low · **Boundary Touching:** false · **Implements:** DR-25
**Files:** `servers/exarchos-mcp/src/agents/dispatch-shape.ts`, `skills-src/delegate/references/parallel-strategy.md`
**Detail:** Two low-severity defects found by task 056 and verified. (1) `POSTURE_DISPATCH_MAP` is **shallow**-frozen: the map and its three entries are frozen, but `READ_ONLY_FALLBACK` and `TASK_ISOLATED_FALLBACK` are plain consts, so `POSTURE_DISPATCH_MAP['read-only'].fallback` is mutable at runtime despite the module comment claiming otherwise — and that object is exactly what `resolveDispatchShape` hands a capability-degraded runtime, so a caller could corrupt every subsequent degraded dispatch. (2) The `shared-mutating` table row omits `naming`, leaving 1 of 9 posture-field cells unbindable by task 056; adding `` `naming: "anonymous"` `` closes it with **no test change** — the parser picks it up automatically. Remember to run `npm run build:skills` and commit the regenerated tree.
**Tests:**
- `DispatchShape_FallbackMutationAttempt_LeavesTheSharedShapeIntact`
- `ProseBinding_SharedMutatingNaming_IsNowBound` — the bound-cell floor rises from 8 to 9
**Verification:** low — scoped tests; `npm run skills:guard` must pass.
**Dependencies:** 056 · **Parallelizable:** Yes

### Task 056: Bind the delegate skill prose to `POSTURE_DISPATCH_MAP`
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-25
**Files:** `servers/exarchos-mcp/src/agents/dispatch-shape.prose-binding.test.ts` (new)
**Detail:** Task 048's docs are a fifth representation of the posture→dispatch contract and are currently unbound — the prose can drift from the shipped map with nothing failing. Parse the table out of `skills-src/delegate/references/parallel-strategy.md` and assert it against `POSTURE_DISPATCH_MAP`. Read the **`skills-src/` source**, not a rendered `skills/<runtime>/` copy, so the binding sits at the authoring surface rather than on a generated artifact.
**Tests:**
- `ProseBinding_SkillTableAndPostureMap_Agree` — the binding
- `ProseBinding_SeededProseDrift_FailsTheBinding` — kill fixture: mutate one table cell, the test must go red
- `ProseBinding_ZeroRowsParsed_FailsClosed` — non-empty denominator; a renamed heading must not read clean
**Verification:** medium — scoped tests + `check_test_adequacy`.
**Dependencies:** 046, 048 · **Parallelizable:** Yes

### Task 057: Restore cast-budget headroom by paying down `as` debt
**Risk Tier:** medium · **Boundary Touching:** false · **Implements:** DR-24
**Files:** production modules under `src/` and `servers/exarchos-mcp/src/` carrying removable `as` casts
**Detail:** **Measured on the integration branch: `asCast` delta is 5 of budget 5 — ZERO headroom** (`countCasts` 3295 vs baseline 3290, `DELTA_BUDGET.asCast = 5`). The assertion is `<= 5`, so it passes today and **fails at 6**: the next production module in this wave that adds any `as <identifier>` reds the root suite. Note the census (`scripts/tsconfig-strictness/count-casts.ts`) matches `as` followed by *any* identifier over raw source, so **ordinary JSDoc prose — "as a", "as an" — counts**; `.test.ts` and `__tests__/` are excluded, which is why test-only tasks appear clean and are not evidence of headroom.
**Resolution is paydown — and paydown REQUIRES lowering the baseline, which is not the same as raising the budget.** The ratchet is **symmetric**: `expect(counts.asCast).toBeGreaterThanOrEqual(BASELINE.asCast)` (`src/tsconfig-strictness.test.ts:104`) fails if the count drops *below* `BASELINE.asCast`, deliberately, so a stale baseline cannot silently mask a future regression. Removing casts therefore **must** lower `BASELINE.asCast` to the new measured value in the same commit.
- **Legitimate:** lowering `BASELINE.asCast` to match a genuine, measured reduction. That *tightens* the ratchet — the new floor is stricter than the old one.
- **Forbidden:** raising `DELTA_BUDGET.asCast` above 5. That loosens enforcement and is the move the standing convention prohibits.
- The distinction matters because "never re-baseline" as bare prose reads as forbidding both, which would make the symmetric floor unsatisfiable and deadlock any paydown. **Record the measured before/after counts in the commit message** so the tightening is auditable.

The highest-yield pattern is *validate-then-re-assert*: replace `typeof (x as T).name === 'string'` probes plus `const {…} = x as T` with a `value is T` predicate built on `in`-narrowing — strictly better typing that removes every assertion. Also check whether each `as const` is load-bearing; several are not, and `tsc` will say so.
**Tests:**
- `CastBudget_AfterPaydown_HasHeadroomForRemainingWaveTasks` — asserts a positive margin, not merely `<= budget`
**Verification:** medium — scoped tests + full root suite.
**Dependencies:** None · **Parallelizable:** Yes *(but land BEFORE the next production-code batch)*

### Task 048: Document read-only dispatch in the delegate skill references
**Risk Tier:** low · **Boundary Touching:** false · **Implements:** DR-25
**Files:** `skills-src/delegate/references/workflow-steps.md`, `skills-src/delegate/references/parallel-strategy.md`
**Detail:** The references cover worktree-isolated implementers and the anonymous async path; read-only dispatch (reviewers, researchers, the `prepare_review` panel) is undocumented — the gap the 2026-08-07 incident fell through. Edit `skills-src/`, run `npm run build:skills`, commit both source and the regenerated tree.
**Verification:** low — static; `npm run skills:guard` must pass (the generated tree may not drift).
**Dependencies:** 046 · **Parallelizable:** Yes

#### Waves 2–5 — anchor tasks (re-planned after Wave 1 exit)

> Each anchor carries its DR's provenance and a **re-plan trigger**. They are not implementation tasks; they exist so provenance resolves and so the re-plan pass has an explicit entry point. Per the Scope note, decomposing these before DR-6's census reports its real subject list would fabricate rather than derive the work.

### Task 028: [ANCHOR] Effect ledger — `emits` coupling on `EffectPlan`
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-7 · **Dependencies:** 027 · **Parallelizable:** No
**Re-plan input:** G5 census output — which effects currently lack a coupling. First migrated consumer is `VcsMutationOwner` (the G4 kill fixture).

### Task 029: [ANCHOR] Fourth envelope state (`input_required`)
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-8 · **Dependencies:** 027 · **Parallelizable:** No
**Re-plan input:** DR-4's remaining ratchet count — the state lands in typed schemas only, and the ordering proof must be live before MRTR code.

### Task 030: [ANCHOR] Core-minted resumption handle
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-9 · **Dependencies:** 029 · **Parallelizable:** No

### Task 031: [ANCHOR] Contract meta-model tightening *(isolated PR)*
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-10 · **Dependencies:** 013 · **Parallelizable:** Yes
**Note:** Lands as its own PR — `contract/` is under active change.

### Task 032: [ANCHOR] Reconciler interface + content-addressed observation
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-11 · **Dependencies:** 028 · **Parallelizable:** No

### Task 033: [ANCHOR] Boundary-triggered reconciliation (no daemon)
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-12 · **Dependencies:** 032 · **Parallelizable:** No

### Task 034: [ANCHOR] Divergence recording + authority precedence
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-13 · **Dependencies:** 033 · **Parallelizable:** No

### Task 035: [ANCHOR] Per-request capability resolution *(security review gated)*
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-14 · **Dependencies:** 027 · **Parallelizable:** Yes

### Task 036: [ANCHOR] EmissionVerifier
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-15 · **Dependencies:** 028 · **Parallelizable:** No

### Task 037: [ANCHOR] Derive `PHASE_EXPECTED_EVENTS`
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-16 · **Dependencies:** 031 · **Parallelizable:** No
**Detail:** Delete `PHASE_EXPECTED_EVENTS` as a hand-maintained artifact and derive it from the union of `autoEmits` across each phase's reachable actions plus T4 workflow declarations. No built-in phase name may appear as a literal key in substrate code (INV-6). `_eventHints.missing` is recomputed from the derived set, with a golden fixture pinning current output.
**Re-plan input:** G5 census output — which phases currently key off literal built-in names.

### Task 038: [ANCHOR] Reachability `event` + `consumer` hops
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-17 · **Dependencies:** 028 · **Parallelizable:** No

### Task 039: [ANCHOR] Oracle emission axis
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-18 · **Dependencies:** 036 · **Parallelizable:** No

### Task 040: [ANCHOR] Full CLI generation — allowlist to zero
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-19 · **Dependencies:** 023, 029 · **Parallelizable:** No

### Task 041: [ANCHOR] Catalog disposition
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-20 · **Dependencies:** 038 · **Parallelizable:** No
**Gate:** P07-01 — zero unexplained disagreements across ≥20 live workflows.

### Task 042: [ANCHOR] Replay and compatibility
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-21 · **Dependencies:** 041 · **Parallelizable:** No

### Task 043: [ANCHOR] MCP era cutover + Tasks re-platform
**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-22 · **Dependencies:** 030, 035 · **Parallelizable:** No
**Re-plan input:** the Tasks-surface audit (Open Question 5) — the live fraction of the 14-file surface sets this task's true size.

### Task 044: [ANCHOR] Invariant amendments (INV-2, 5b, 11, 17)
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-23 · **Dependencies:** 043 · **Parallelizable:** No
**Note:** Authored via `/exarchos:invariants` — no hand-edited catalog YAML.

### Task 045: [ANCHOR] Wave sequencing / anti-inertness proofs
**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-24 · **Dependencies:** 044 · **Parallelizable:** No

### Parallelization

**Wave 0** — removed in rev 2 (already closed on the landing branch).

**Wave 1** — 005 is the foundation and blocks 1b–1e. After it:
- **Group A (events):** 009 → 010 → {011 ∥ 012} → 013; 014 → 015
- **Group B (schemas):** 016 → 017 → 018; 019 ∥
- **Group C (CLI):** 020 → {021, 022} → 023
- **Group D (census):** 024 → 025 → 026

Groups A–D are mutually parallel after 005/006 land, and touch disjoint files (`event-store/`, `architecture/output-schema-census`, `scripts/`, `architecture/authority-topology`). 027 is the join point.

**Checkpoint discipline:** insert an explicit checkpoint after 008 (foundation complete), after 019/023 (schema + CLI guards green), and at 027 (wave exit) — per the ~10-task cadence.

### Gate results at authoring time

| Gate | Result | Note |
|---|---|---|
| `check_plan_coverage` | **PASS** 24/24 | All DRs covered |
| `check_provenance_chain` | **PASS** 24/24, 0 orphans | Blocking gate — clean |
| `check_task_decomposition` (D5, advisory) | 27/45 well-decomposed; **DAG valid, parallel-safe** | The 18 non-passing tasks are **exactly** the anchors 028–045, which carry no files or tests **by design** under the declared partial scope. All 27 Wave 0–1 tasks pass. Re-run after the Waves 2–5 re-plan. |
| `spec_coverage_check` | **not run** | It verifies planned test files *exist and pass*. At authoring time, before implementation, they do not — a failure here would carry no information. Run it at Wave 1 exit, when tasks 001–027's tests exist. |
| `check_coverage_thresholds` | **not run** | Same rationale — no implementation yet. |

> Two parser conventions were confirmed empirically while running these and are worth knowing before editing this file: DR-N and Task headings must be **h3** (`### DR-1`, `### Task 001`) under an **h2 `## Requirements`**, and test names must use the three-part `Method_Scenario_Outcome` form or they are not counted. The superseded taxonomy spec uses `#### DR-n` under `### Requirements`, so its gates would fail identically until re-levelled.

### Completion checklist

- [ ] Wave 0: INV-9 closed; all three defects preserved as kill fixtures
- [ ] `Declaration<K>` envelope shipped; **relocation proof green** (D2 is a property, not a claim)
- [ ] G1 rejects `merge-orchestrate`'s hand-written definition; self-test proves it measures derivation not vocabulary
- [ ] G2 seeded at <!-- measured: output-schema-vacuous -->111<!-- /measured --> and shrink-only; new vacuous action fails CI
- [ ] G3 report-coupled ratchet pinned at 25, shrink-only
- [ ] G5 census fails on the CLI-surface and event-catalog rows before remediation
- [ ] Every guard's self-test runs in the same CI job as the guard
- [ ] All guards on **unfiltered** CI paths (#1711)
- [ ] Wave 1 exit: seeded-failure test against production composition
- [ ] Waves 2–5 re-planned with census output as input
