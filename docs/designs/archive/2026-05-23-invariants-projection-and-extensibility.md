# Design: Invariants — Projection Model & User Extensibility

> **Status:** Design — output of `/exarchos:ideate`, input to `/exarchos:plan`.
> **Date:** 2026-05-23
> **Seed:** [`docs/proposals/2026-05-23-invariants-projection-and-extensibility.md`](../proposals/2026-05-23-invariants-projection-and-extensibility.md)
> **Parent epic:** [Invariants Catalog v2 Spec](../proposals/2026-05-20-invariants-catalog-v2-spec.md) (#1441)
> **Catalog:** extends `docs/architecture/invariants.md` (schema-version 2 → 3, additive)
> **Workflow:** `invariants-projection-extensibility`

## Constraints (Phase 0 — devCatalog: enabled)

Anchored to `docs/architecture/invariants.md`. The load-bearing pair is **INV-2 + INV-5b**: the new gate must be a true facade-equivalent dispatch action whose findings ride the *existing* `check_review_verdict` carrier — not a bespoke skill replacement. Also active: INV-5a/5d (new action, not a new visible tool; static reference as Resource), INV-1 (projections are read-models, never a drifting side database), INV-6 (workflow-affinity is catalog data, not workflow-typed literals leaking into the substrate), INV-4 (user checks are declarative-only, sandbox-free), INV-9 (`state-affinity` binds to topology ids; the HSM stays the sole sequencing authority), INV-11 (the override model is a POLA authority gradient), INV-3 (the audit-prompt executor must not presume MCP-local), DIM-1/DIM-3 (the schema delta is an additive contract change).

## Problem Statement

The catalog has a clean vocabulary (`INV-*`/`DIM-*` with `axis` + `cost-of-load`) and an audience gate (`devCatalog`), but three gaps remain. **(1) Skill-not-gate asymmetry:** `prepare_review`'s quality catalog is machine-readable → executed by a gate → folded into `check_review_verdict`. `invariants.md` is equally machine-readable but is still *audited by a skill* (`design-invariants`), never wired onto the workflow path. **(2) No extensibility:** `.exarchos.yml` frames invariants as user-facing config, yet the catalog is a fixed file inside the Exarchos repo — a consumer cannot define their own first-class invariants. **(3) Single-dimensionality:** the same invariant must behave differently by phase, workflow-type, and touched files; a flat `applies-to: string[]` cannot express that.

## Chosen Approach

**Approach C — Contract-shaped seam.** Build the v3 schema and a real declarative DSL as Zod-native *today*, authored in the exact shape the `Strategos.Contracts` TypeSpec emitter will later produce — a documented "hand-written now, generated later" seam. Rationale: it is the only approach satisfying all four ideation decisions simultaneously — full §11 scope, lean-toward-Strategos-contracts, Resource exposure with CLI parity, and **no forward-dependency blocking** on #1125 (events-only spike) or #1275 (no Resource code today). Approach A (catalog-native, flat checks) under-delivers against the DSL lean and risks a second migration; Approach B (TypeSpec-first) hard-blocks the critical path on an external in-flight spike.

The buildable substrate is richer than the seed assumed: `invariants-loader.ts` already parses v2 + gates `devCatalog` + filters by scope, and `check-catalog.ts` already implements the `grep|structural|heuristic` execution kinds and the `PluginFinding` shape that `check_review_verdict` merges by severity. The gate is therefore a *mirror* of `prepare_review` → `check_review_verdict`, not new infrastructure.

## Requirements

### DR-1: v3 additive schema, contract-shaped

Extend the catalog frontmatter and `InvariantEntry` with v3 fields, all optional/defaulted so the existing v2 catalog stays valid: `phase-affinity: enum[]` (absent ⇒ all phases), `workflow-affinity: enum[]` (absent ⇒ all types), `state-affinity: string[]` (topology transition ids), `enforcement` (object, §DR-2), `severity: { default, by-workflow?, by-phase? }`, `integrity-class: substrate | sdlc | authoring | user` (renames the seed's `tier`; see DR-6). Zod types live in `servers/exarchos-mcp/src/architecture/` authored in the shape a `Strategos.Contracts` emitter would produce — field names, nullability, and nesting match the TypeSpec convention so the eventual swap to generated validators is byte-compatible.

**Acceptance criteria:**
- Given the current `schema-version: 2` catalog, When loaded under the v3 loader, Then every existing entry parses with no error and absent affinities resolve to all-phases/all-types (back-compat proven by a fixture test over the live catalog).
- Given an entry with `phase-affinity: [review]`, When the loader projects for `phase=ideate`, Then the entry is excluded.
- The v3 Zod schema is annotated with a `// contract-shaped: <TypeSpec model name>` seam comment per top-level type; a doc note records the "hand-written now, generated later" contract (DR-10).
- `schema-version` bumps to `3`; the loader accepts both 2 and 3.

### DR-2: `enforcement` — mechanizable checks + declarative combinator DSL

`enforcement` is one of two shapes. **`mode: check`** carries a combinator tree over the existing sandbox-free leaves. Grammar (launch scope): leaves are `{ kind: grep|structural|heuristic, pattern, fileGlob, threshold? }`; combinators are `all-of`, `any-of`, `not`, and `scope` (narrows `fileGlob`/`phase` for a subtree). No arithmetic, no cross-file joins, **no user-supplied executable** (INV-4). **`mode: audit`** carries an `audit-prompt` string rendered into the review subagent's prompt. A pure evaluator walks the tree against a diff and returns `PluginFinding[]`, reusing `check-catalog.ts` leaf execution.

**Acceptance criteria:**
- Given `all-of: [grep A, not(grep B)]` over `fileGlob: **/*.ts`, When evaluated against a diff matching A but not B, Then it passes; matching both ⇒ one finding.
- The evaluator is total: every node kind has a handler; an unknown `kind` throws a typed `UnknownCheckKindError` at load, not at eval (fail-closed at the boundary).
- A user catalog declaring `mode: check` with arbitrary embedded code/script fields fails schema validation (the schema admits only the declared leaf/combinator union).
- `mode: audit` entries never execute code; they only contribute prompt text.

### DR-3: `check_invariant_conformance` gate (retires the skill's audit behavior)

New `exarchos_orchestrate` action mirroring `prepare_review` → `check_review_verdict`. Registered in `registry.ts` (Zod schema → auto-emitted CLI flags), routed in `composite.ts` via `adaptWithEventStore`, `annotations: readOnly`, emits `gate.executed`. Steps: (1) resolve effective catalog for `(workflow-type, phase=review, touched-files)` (DR-6 merge); (2) evaluate every applicable `mode: check` tree against the diff → findings; (3) render every applicable `mode: audit` into the review subagent prompt → collected as `pluginFindings`; (4) fold both into `check_review_verdict` using each invariant's context-resolved `severity`. Invariant conformance becomes a review dimension governed by the same `.exarchos.yml: review.dimensions` blocking/advisory plumbing.

**Acceptance criteria:**
- Given the same `DispatchContext` + args, When invoked via the CLI adapter and the MCP adapter, Then the `ToolResult` is byte- and schema-identical (INV-2 parity test).
- Given a diff violating a `blocking` invariant, When the gate runs, Then `check_review_verdict` returns `NEEDS_FIXES`/`BLOCKED` and a `gate.executed` event is emitted with the invariant id.
- The action carries a registered Zod `outputSchema` (INV-5b) and stays within the 4 visible composite tools (INV-5d — no new top-level tool).

### DR-4: Catalog-generated audit prompt; retire `design-invariants`

A generic, workflow-agnostic prompt runner compiles applicable `mode: audit` invariants into a single review-subagent prompt block from the catalog `summary` + `audit-prompt`. The `design-invariants` skill's *vocabulary* moves entirely into the catalog (already true for INV-1..INV-15); its *audit behavior* becomes DR-3. The skill is then deleted, and `review-contract.ts` / review playbooks reference the gate.

**Acceptance criteria:**
- Given INV-11 (`mode: audit`), When the gate runs at review, Then the rendered prompt contains INV-11's `audit-prompt` verbatim and no copy of the vocabulary lives in any skill body.
- After retirement, `rg "design-invariants"` returns only historical/doc references; the skill directory is removed and `skills:guard` passes.
- The prompt runner is workflow-agnostic: it carries no `INV-*`-specific branching (INV-6) and does not presume MCP-local execution (INV-3).

### DR-5: Projection model — one catalog, per-phase renderings

The unit of optimization is the projection key `(phase, workflow-type, touched-files)`. A `projectCatalog(key)` core fn produces: **ideate** — `phase-affinity ∋ ideate` summaries as Constraints; render `axiom:design` DIM-questions *only for dimensions with no specializing INV* (coverage-gap-driven); **plan** — applicable invariants become testable acceptance criteria ("T-N touches `format.ts` ⇒ emit an INV-2 parity-test task"); **delegate** — inject only invariants whose `applies-to ∩ task.files ≠ ∅` into the implementer prompt; **review** — DR-3 gate. Per-workflow-type composition uses `workflow-affinity` (debug = audit-only scoped; refactor = parity+coupling emphasis; discover = prose-quality only, code invariants N/A; oneshot = critical always-load, severity downgraded to advisory).

**Acceptance criteria:**
- Given `workflow-type=discover`, When `projectCatalog` runs for `phase=review`, Then code-axis invariants are excluded and `check_invariant_conformance` does not fire on them.
- Given a task touching only `docs/**`, When projecting for delegate, Then no code-invariant injection occurs.
- The projection is a pure left-fold over the loaded catalog (INV-1) — it holds no mutable cache that can drift from the catalog file.

### DR-6: Layered catalogs + per-invariant override floor

Three merged layers: **dev** (`docs/architecture/invariants.md`, `integrity-class: substrate|authoring`, gated by `devCatalog`, never surfaced to consumers); **sdlc** (ships with the plugin, `integrity-class: sdlc`, default-on for consumers); **user** (declared in `.exarchos.yml: invariants.catalogs`, `integrity-class: user`). Additive `.exarchos.yml` keys on `InvariantsConfigSchema`: `catalogs: string[]`, `overrides: Record<id, {severity?, enabled?}>`, `enforcement: { review: blocking|advisory }`. **Override authority is per-catalog-relative, not a global ladder** (resolves the substrate-tier concern): `integrity-class` is a self-protection class each catalog declares *within its own audience*. Each shipped invariant carries an `override-floor: advisory | disable` (default `advisory` for sdlc). Exarchos's substrate invariants never cross the `devCatalog` boundary, so consumers never face them; a consumer may declare *their own* substrate-class invariants immutable to *their* sub-agents.

**Acceptance criteria:**
- User catalogs may introduce only `U-*`/free-form ids; `INV-*`/`SDLC-*` are reserved and a collision fails validation.
- Given an sdlc invariant with `override-floor: advisory`, When a consumer sets `overrides: { SDLC-3: { enabled: false } }`, Then resolution clamps to `advisory` (floor honored) and emits a warning, not a hard error.
- A consumer cannot tune a `devCatalog`-gated substrate invariant because it is never present in their resolved catalog (proven by a merge test with `devCatalog: disabled`).

### DR-7: Dual-facade effective catalog (CLI parity now, Resource later)

The merged, projected catalog is exposed by one core fn `resolveEffectiveCatalog(ctx)`. Two facades call it for byte-identical payload (INV-2): a CLI `export`-style verb (INV-5c, e.g. `exarchos_view` invariants query / CLI `--json`) available *now*, and an MCP Resource (`resources/exarchos-invariants/effective`) added as an *additive third facade* when #1275 lands. No hard dependency on #1275.

**Acceptance criteria:**
- Given a repo with dev+sdlc+user layers, When the CLI export verb runs, Then it returns the same structured payload the gate resolved (single core fn).
- The design adds no `resources/*` registration today; a seam comment marks the future Resource facade.
- When #1275 lands, exposing the Resource requires only registering the existing core fn's output — zero change to CLI behavior or payload shape.

### DR-8: Coverage-closure lint + `axiom:design` graduation

`axiom:design` becomes redundant on the hot path ⟺ the catalog reaches **DIM-coverage closure**: every `DIM-*` has ≥1 specializing `INV-*` (via `axiom_overlap`) or is marked N/A. The residual "uncovered dimension?" check moves into the existing `vocabulary-lint` scanner (per ideation Q#3 — reuse CI infra, no new action). Below closure, `axiom:design` graduates from the design hot-path to a periodic catalog-maintenance instrument whose findings *mint new invariants* rather than annotate the current PR.

**Acceptance criteria:**
- Given a `DIM-X` with no specializing `INV-*` and no N/A marker, When `vocabulary-lint` runs, Then it emits a coverage-gap finding (non-zero exit).
- The lint check is additive to `npm run lint:invariants`; no new orchestrate action is introduced.

### DR-9: Error handling, failure modes, and edge cases

The gate and loader must fail safe and observably.

**Acceptance criteria:**
- Given a malformed user catalog (bad YAML, unknown `kind`, reserved-namespace id), When loaded, Then the loader throws a typed error naming the file and id; the gate degrades to evaluating *only the valid shipped layers* and reports the user-catalog load failure as an advisory finding (INV-1: no silent swallow — surfaces the signal).
- Given `mode: check` evaluation throwing on a single leaf, When the tree is walked, Then the failure is captured as a `LOW`-severity finding with the invariant id, not propagated to abort the whole gate.
- Given `devCatalog: disabled` in a consumer repo, When any projection runs, Then dev-layer entries are absent and no Constraints surface from them (existing gate behavior preserved).
- Given an empty effective catalog (no applicable invariants for the key), When the gate runs, Then it returns `APPROVED` with zero findings and still emits a `gate.executed` event (observability, INV-10).

### DR-10: Strategos contract-seam discipline (the "two-phase truth")

The hand-written Zod must remain faithful to the future TypeSpec emit so the swap is invisible. A documented mapping records each v3 Zod type ↔ its intended `Strategos.Contracts` model name.

**Acceptance criteria:**
- A `docs/architecture/invariants-v3-contract-seam.md` note enumerates every v3 type and its target TypeSpec model; CI (or a doc lint) flags v3 types lacking a seam entry.
- No runtime dependency on `Strategos.Contracts` is introduced today; the seam is documentation + shape-discipline only.

## Technical Design

```
docs/architecture/invariants.md  ──load──▶  invariants-loader.ts (v3, scope+devCatalog)
.exarchos/invariants.yml (user)  ──┐                    │
plugin sdlc catalog            ──┼──merge──▶  resolveEffectiveCatalog(ctx)
                                   │            (integrity-class + override-floor)
                                   ▼                    │
                          projectCatalog(phase,wf,files) ──┬─▶ ideate: Constraints
                                                           ├─▶ plan: acceptance criteria
                                                           ├─▶ delegate: scoped injection
                                                           └─▶ review: check_invariant_conformance
                                                                          │
                              mode:check tree ──evaluator──▶ findings ────┤
                              mode:audit prompt ──subagent──▶ pluginFindings┤
                                                                          ▼
                                                            check_review_verdict (severity fold)
```

The combinator evaluator and `resolveEffectiveCatalog` are pure functions in the dispatch core (INV-2 — adapters carry zero behavior). The gate handler is the only stateful piece, and only via `eventStore` for `gate.executed`.

## Integration Points

- `servers/exarchos-mcp/src/architecture/invariants-loader.ts` — extend `InvariantEntry` + parsing (DR-1).
- `servers/exarchos-mcp/src/review/check-catalog.ts` — reuse leaf execution + `PluginFinding` (DR-2/3).
- `servers/exarchos-mcp/src/verbs/gates/check-invariant-conformance.ts` — new handler (DR-3).
- `servers/exarchos-mcp/src/registry.ts` + `composite.ts` — register action (DR-3).
- `servers/exarchos-mcp/src/config/exarchos-config-schema.ts` — `InvariantsConfigSchema` additive keys (DR-6).
- `servers/exarchos-mcp/src/workflow/review-contract.ts` — add invariant-conformance dimension (DR-3/4).
- `scripts` + `vocabulary-lint.ts` — coverage-closure check (DR-8).
- Skill removal: `.claude/skills/design-invariants/` (DR-4).

## Testing Strategy

- **Loader back-compat:** fixture test loads the live v2 catalog under the v3 loader — zero diff in resolved entries.
- **Evaluator unit tests:** truth-table over `all-of/any-of/not/scope` × leaf kinds; total-function proof (unknown kind throws at load).
- **INV-2 parity harness:** `check_invariant_conformance` through both adapters → identical `ToolResult` (reuse `__tests__/parity-harness.ts`).
- **Merge/override tests:** dev+sdlc+user layering; floor-clamp; reserved-namespace collision; `devCatalog: disabled` isolation.
- **Gate fold test:** seeded findings → expected `check_review_verdict` verdict + emitted `gate.executed`.
- **Failure-mode tests:** malformed user catalog → advisory degradation, not abort (DR-9).

## Open Questions (deferred to plan/implementation)

1. **`state-affinity` binding (seed Q#6).** Exact coupling to `topology.yaml` transition ids without re-introducing workflow-typed assumptions into the substrate (INV-6 tension). Likely a soft reference resolved at projection time, not a hard topology import.
2. **sdlc catalog content.** The shipped `SDLC-*` set (phase observability, TDD discipline, review-gate honesty, branch/PR discipline) is named but not authored here — its authoring is a DR-6-dependent follow-on, plausibly via `/exarchos:discover consumer-sdlc-invariants`.
3. **Catalog discovery (seed Q#4).** Keep explicit `catalogs:` listing (v2 precedent: no auto-detection) — assumed yes; flagged for confirmation at plan.
