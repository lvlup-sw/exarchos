# Invariants — Projection Model & User Extensibility (seed proposal)

> **Status:** Seed proposal — input to an eventual `/exarchos:ideate` → design, NOT an implementation spec.
> **Date:** 2026-05-23
> **Parent:** [Invariants Catalog v2 Spec](2026-05-20-invariants-catalog-v2-spec.md) (epic #1441)
> **Extends:** `docs/architecture/invariants.md` (schema-version 2 → 3, additive)
> **Relates:** `project_review_contract_sot`, `.exarchos.yml` `review.dimensions` gating, the `prepare_review` quality-check catalog.

---

## 1. Problem

The v2 spec gives the catalog a clean **vocabulary** (machine-readable `INV-*`/`DIM-*` with `axis` + `cost-of-load`) and a **gate** for *who sees it* (`invariants.devCatalog`). It does not yet answer two questions that the current `/ideate`-applies-the-skills workflow exposed:

1. **The data/behavior gap.** The catalog is consumed two ways that do different jobs: the loader *surfaces* the vocabulary at ideate Phase 0 (a data load), and the `design-invariants` skill *audits* a concrete design/diff and emits findings (a behavior). `devCatalog` makes the surfacing automatic, so invoking the skills purely to *list* constraints is already redundant. But the **audit** is still a manual skill invocation, never wired onto the workflow path. The asymmetry is sharp: the `prepare_review` quality catalog is machine-readable → executed by a review gate → folded into `check_review_verdict` (no skill). `invariants.md` is equally machine-readable but is still consumed by a *skill*. Invariants are the only quality surface in the system that hasn't been promoted from skill to gate.

2. **No extensibility.** Invariants are enabled per-repo in `.exarchos.yml`, which frames them as user-facing configuration — yet the catalog is a fixed file inside the Exarchos repo. A consumer governing their *own* SDLC has no way to define "in this codebase, every handler must emit an audit event" as a first-class invariant that flows through the same surfacing/acceptance-criteria/audit machinery Exarchos uses on itself.

A third constraint emerged from the projection analysis (§3): the same invariant must behave differently by **phase**, by **workflow type**, and by **which files a change touches**. A flat `applies-to: string[]` cannot express this. The definitions must be **multi-dimensional**.

## 2. Thesis

**One source of truth, projected into phase- and type-scoped behaviors, auto-invoked on the workflow path. The skills retire exactly when those projections fire automatically.**

- A catalog entry stops being "prose a skill reads" and becomes a **multi-dimensional definition** addressable by `(phase × workflow-type × touched-files × enforcement-mode)`.
- The runtime compiles per-phase projections of the catalog and invokes them at the phase where they bite — surfacing at ideate, acceptance-criteria at plan, scoped injection at delegate, a conformance **gate** at review.
- User-defined invariants plug into the *same* multi-dimensional schema and the *same* projection machinery. Extensibility is not a bolt-on; it falls out of making the definition format rich enough to address the state machine.

This is the natural continuation of the v2 direction: v2 split *audience* (dev vs consumer) and *vocabulary*; this seed adds *execution* and *authorship*.

## 3. The three functions, placed by phase

The catalog currently smears three functions across the loader and two skills:

| Function | Today | Should live at |
|---|---|---|
| **Surface** — anchor a design in its constraints | loader / ideate Phase 0 | ideate (keep) |
| **Question** — interactive dimension probing | `axiom:design` | ideate, driven by *coverage gaps* not a generic sweep |
| **Audit** — verify an artifact, emit findings | `design-invariants` (manual) | **review, as a gate** |

A data load can never retire a behavior, so `devCatalog` retires only *Surface*. *Audit* and *Question* survive until the workflow performs them. The redundancy conditions (§8) follow directly.

## 4. Schema delta — multi-dimensional definitions (v2 → v3, additive)

v2 fields (`id`, `dimension`, `axis`, `cost-of-load`, `applies-to`, `summary`, `axiom_overlap`, `citations`, `references`) are retained unchanged. v3 adds the dimensions the projection key needs:

| New field | Type | Purpose |
|---|---|---|
| `phase-affinity` | `enum[]` | Phases where the invariant is active: `ideate \| plan \| delegate \| review \| synthesize`. Drives which projection includes it. Absent ⇒ all phases (back-compat). |
| `workflow-affinity` | `enum[]` | Workflow types where it bites: `feature \| debug \| refactor \| discover \| oneshot`. Absent ⇒ all types. Lets `refactor` emphasize INV-2/DIM-6 and `discover` drop code invariants. |
| `state-affinity` | `string[]` | Optional HSM hooks — phase/transition ids the invariant guards (e.g. `dispatch-boundary`, `merge-pending`). Ties an invariant to a point *in the state machine*, not just a file. |
| `enforcement` | object | How the invariant is checked. One of two shapes (§4.1). |
| `severity` | object | Context-keyed severity: `{ default, by-workflow?, by-phase? }`. An invariant can be `blocking` in `feature/review` and `advisory` in `oneshot`. |
| `tier` | enum | `substrate \| sdlc \| authoring \| user`. Governs who may override/disable it (§7). |

### 4.1 `enforcement` — mechanizable vs judgment

The single most important split. An invariant is either deterministically checkable or a matter of judgment, and the schema must say which:

```yaml
# Mechanizable — reuses the existing prepare_review check vocabulary
enforcement:
  mode: check
  checks:
    - kind: grep | structural | heuristic   # the SAME vocabulary the quality catalog uses
      pattern: "..."                          # declarative only — never arbitrary code
      fileGlob: "**/*.ts"
      threshold: 3                            # for structural/heuristic

# Judgment — rendered into a catalog-generated audit prompt, run by a generic executor
enforcement:
  mode: audit
  audit-prompt: >
    Does this diff let a task-isolated agent write outside its worktree?
    INV-11 requires this to be unrepresentable by construction.
```

`mode: check` invariants execute deterministically at the review gate (§5). `mode: audit` invariants are compiled into a prompt the review subagent answers. **Crucially, user-defined checks use only the declarative `kind` vocabulary** — no user-supplied executable — so extensibility stays platform-agnostic and sandbox-free (INV-4).

## 5. `check_invariant_conformance` — the gate that retires `design-invariants`

A new `exarchos_orchestrate` action, modeled exactly on the existing `prepare_review` → `check_review_verdict` flow:

1. Resolve the **effective catalog** for `(workflow-type, phase=review, touched-files)` — merge of dev/sdlc/user layers (§7), filtered by affinity.
2. Execute every `mode: check` invariant against the diff (deterministic), collect findings.
3. Render every applicable `mode: audit` invariant into the review subagent's prompt; collect its findings as `pluginFindings`.
4. Fold both into `check_review_verdict` using each invariant's context-resolved `severity`.

This makes invariant conformance a first-class review dimension alongside D1–D5, governed by the same `.exarchos.yml: review.dimensions` blocking/advisory config. The `design-invariants` skill's *vocabulary* moves into the catalog; its *audit behavior* becomes the gate. Nothing is left for the skill to do.

## 6. Projection model

The unit of optimization is the **projection key** `(phase, workflow-type, touched-files)`. One catalog, many renderings:

| Phase | Projection |
|---|---|
| **ideate** | `phase-affinity ∋ ideate` summaries as constraints; render `axiom:design` DIM-questions **only for dimensions with no specializing INV** (coverage-gap-driven, not a blanket sweep) |
| **plan** | turn applicable invariants into **testable acceptance criteria** — "T-N touches `format.ts` ⇒ emit an INV-2 parity-test task" |
| **delegate** | inject only invariants whose `applies-to ∩ task.files ≠ ∅` into the implementer prompt (capability-scoped; replaces hand-written "maintain INV-2" lines) |
| **review** | `check_invariant_conformance` gate (§5) |

### Per-workflow-type composition (why `workflow-affinity` exists)

| Workflow | Emphasis | Notes |
|---|---|---|
| **feature** | full cycle: surface → criteria → audit | all four projections fire |
| **debug** | audit-only, scoped to touched files (INV-1, INV-7/8) | skip design-time surface as noise |
| **refactor** | parity + coupling (INV-2, DIM-6); stronger characterization obligation | refactors break *these* first |
| **discover** | code invariants N/A; prose-quality (DIM-8) only | `check_invariant_conformance` should not fire on code dimensions |
| **oneshot** | most-critical always-load INV on the diff; severity downgraded to advisory | keep it cheap |

## 7. User extensibility — layered catalogs

Invariants become authorable by the consumer through three merged layers:

1. **Dev catalog** — `docs/architecture/invariants.md`, `tier: substrate|authoring`, gated by `devCatalog`. Exarchos's own. Never surfaced to consumers.
2. **SDLC catalog** — ships with the plugin, `tier: sdlc` (the consumer-facing catalog forward-pointed in v2 §10: phase observability, TDD discipline, review-gate honesty, branch/PR discipline). Default-on for consumers.
3. **User catalog** — declared in the consumer's `.exarchos.yml`, `tier: user`. Fully consumer-owned.

### `.exarchos.yml` schema (additive)

```yaml
invariants:
  devCatalog: disabled            # existing flag (Exarchos-self only)
  catalogs:                       # NEW — user-authored catalog files
    - .exarchos/invariants.yml
  overrides:                      # NEW — tune shipped invariants by id
    SDLC-3: { severity: advisory }
    SDLC-7: { enabled: false }
  enforcement:
    review: blocking              # which phase treats invariant findings as gating
```

### Merge & override semantics (a genuine fork — see Options)

- **Add:** user catalogs introduce new ids in a reserved namespace (proposal: `U-*` or free-form under `tier: user`); `INV-*`/`SDLC-*` are reserved for shipped tiers.
- **Override:** `overrides` may *tune* (severity) or *disable* a shipped invariant — but only by **tier permission**. `tier: substrate` invariants are **not** user-disablable (they protect runtime integrity — disabling INV-1 is meaningless to a consumer and dangerous if it ever reached the dev path). `tier: sdlc|authoring` are user-tunable. This mirrors how `review.dimensions` already lets users set blocking/advisory but not invent dimensions.

## 8. Redundancy conditions (the original question, answered concretely)

- **`design-invariants` is redundant ⟺** `check_invariant_conformance` exists and runs from the catalog at review, with judgment invariants rendered as catalog-generated prompts (§5). The skill is a manual stand-in for an audit that should be a gate.
- **`axiom:design` is redundant ⟺** the catalog reaches **DIM-coverage closure** — every `DIM-*` has ≥1 specializing `INV-*` (via `axiom_overlap`) or is marked N/A. The residual "uncovered dimension?" check becomes a **catalog lint**, not a per-session skill. Below closure, `axiom:design` graduates from the design hot-path to a periodic **catalog-maintenance / anti-complacency** instrument: its findings mint new invariants rather than annotate the current PR.

**Irreducible residue:** non-mechanizable invariants (INV-11 "unrepresentable by construction", INV-3 basileus-forward) keep a judgment step — but the judgment is a catalog-generated prompt run by a generic executor, not a skill carrying its own copy of the vocabulary. The vocabulary dies into the catalog; only a workflow-agnostic prompt runner survives.

## 9. Why multi-dimensional (not over-engineering)

A flat invariant list forces every consumer to either accept all invariants everywhere or fork the file. The cross-product is what lets:
- the same INV-2 be *surfaced* at ideate, *encoded as a test* at plan, *injected* only into parity-relevant tasks at delegate, and *gated* at review — without four copies;
- `debug` skip the design-time noise while `feature` runs the full cycle;
- a user add one invariant scoped to `review` + `feature` + their `src/api/**` without touching the runtime substrate set.

The dimensions are exactly the axes the workflow already varies along (phase, workflow type, file scope, state-machine position). The schema is matching the shape of the state machine it serves.

## 10. Open questions / forks for the design phase

1. **Override floor.** Can a user *disable* an `sdlc` invariant outright, or only downgrade to advisory? (Integrity argument for floor-at-advisory; autonomy argument for full disable.)
2. **User check vocabulary.** Is the declarative `grep|structural|heuristic` set expressive enough for real consumer invariants, or do we need a small safe DSL? (Hard constraint: no arbitrary code — INV-4 platform-agnosticity + sandbox safety.)
3. **Coverage-closure tracking.** Where does "DIM-X has no specializing INV" live — vocabulary-lint, or a new `check_dimension_coverage`?
4. **Catalog discovery for consumers.** Auto-load `.exarchos/invariants.yml` if present, or require explicit `catalogs:` listing? (v2 set the precedent: no auto-detection. Likely keep explicit.)
5. **MCP Resource exposure.** Does the merged effective catalog get exposed via `#1275` Resources so agents can read it without a tool round-trip?
6. **`state-affinity` binding.** How tightly should invariants bind to topology.yaml ids without coupling the catalog to a specific workflow type (INV-6 workload-agnosticism tension)?

## 11. Sequencing sketch (for the eventual plan)

1. Land v2 first (this proposal assumes v2's `axis`/`cost-of-load`/`devCatalog`).
2. Schema v3 additive fields (`phase-affinity`, `workflow-affinity`, `state-affinity`, `enforcement`, `severity`, `tier`) — defaulted so the existing catalog stays valid.
3. `check_invariant_conformance` gate (mechanizable checks first; reuse `prepare_review` infra).
4. Catalog-generated audit prompt for `mode: audit` invariants; retire `design-invariants`.
5. Plan/delegate projections (acceptance-criteria emission; capability-scoped injection).
6. Layered catalogs + `.exarchos.yml` `catalogs`/`overrides`; ship the `sdlc` tier (the v2 §10 consumer catalog).
7. Coverage-closure lint; graduate `axiom:design` to maintenance role.

## 12. References

- [Invariants Catalog v2 Spec](2026-05-20-invariants-catalog-v2-spec.md) — parent; §1.1 audience split, §4.0 gating, §10 consumer-catalog forward pointer.
- `docs/architecture/invariants.md` — current schema-version 2 source of truth.
- `prepare_review` / `check_review_verdict` — the catalog→gate pattern this proposal generalizes to invariants.
- `.exarchos.yml` `review.dimensions` — precedent for user-tunable, tier-bounded gating.
