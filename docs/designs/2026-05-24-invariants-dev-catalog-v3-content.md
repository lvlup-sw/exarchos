# Design: Author v3 Dev-Catalog Content (make the machinery bite)

> **Status:** Design — output of `/exarchos:ideate`, input to `/exarchos:plan`.
> **Date:** 2026-05-24
> **Issue:** [#1466](https://github.com/lvlup-sw/exarchos/issues/1466) (`type:bug`)
> **Stacks on:** [PR #1465](https://github.com/lvlup-sw/exarchos/pull/1465) (`feature/invariants-projection-extensibility` — the v3 *machinery*)
> **Parent design:** [`docs/designs/2026-05-23-invariants-projection-and-extensibility.md`](2026-05-23-invariants-projection-and-extensibility.md) (DR-1, §6 projection table)
> **Sibling (separate workflow):** [#1467](https://github.com/lvlup-sw/exarchos/issues/1467) — consumer `SDLC-*` catalog, authored via its own `/exarchos:discover`.
> **Catalog touched:** `docs/architecture/invariants.md` (schema-version `2 → 3`, dev layer only)

## Constraints (Phase 0 — devCatalog: enabled)

Anchored to `docs/architecture/invariants.md`. This is **content authoring against an already-built schema**, not new machinery, so the load-bearing invariants govern what the authored entries are *allowed to say*:

- **INV-4 (declarative-only)** — *the* binding constraint. Every `mode: check` tree compiles to sandbox-free `grep|structural|heuristic` leaves under `all-of/any-of/not/scope`; the schema is `.strict()` at the DSL boundary, so any embedded `script`/`exec`/`code` field fails to parse. No check may *pretend* to prove a semantic property a grep can't see.
- **INV-6 (workload-agnosticism)** — `workflow-affinity` and the severity-by-workflow downgrades are catalog *data*, not workflow-typed literals in the substrate. `scripts/lint-inv6.mjs` is itself the proven projection we reuse as INV-6's `mode: check`.
- **INV-2 + INV-5b** — not authored, but the "verify the gate produces real findings" acceptance rides `check_invariant_conformance`'s CLI↔MCP parity; the fixture-diff verification must exercise both facades.
- **INV-11 (POLA authority gradient)** — out of scope for #1466 (override-floor is the sdlc/user concern of #1467), but `integrity-class: substrate|authoring` on dev entries is the self-protection class we set here.
- **INV-3 (basileus-forward)** — `mode: audit` prompts must not presume MCP-local execution.
- **DIM-3 (contracts)** — the `schema-version 2 → 3` bump on the *live* catalog is the additive contract change; the loader back-compat test is the regression guard.
- **DIM-4/5/6/8 (coverage-closure)** — acceptance requires the coverage-closure lint satisfied: each needs a specializing `INV-*` or an explicit `coverage: n/a`. These four are axiom-owned pointers, so the disposition here is `coverage: n/a` with the axiom-skill cross-reference (not minting Exarchos-specific INVs).

**Bootstrap hazard (the defining design force).** The moment `invariants.md` reaches v3 with real `mode: check` trees, `check_invariant_conformance` evaluates those trees against *this PR's own diff* at review. The authored checks must not false-positive on the authoring diff. This dictates the **calibrate-on-HEAD rule** below and the choice of `mode: check` only for high-precision proxies.

## Problem Statement

PR #1465 shipped the v3 invariant *machinery* — multi-dimensional schema (`invariant-schema.ts`), the combinator DSL + evaluator, `check_invariant_conformance`, projection, and layered catalogs. But the live catalog `docs/architecture/invariants.md` is still authored at `schema-version: 2` with **zero v3 fields populated**. The gate therefore resolves an effectively-empty effective catalog and returns `APPROVED` trivially. The machinery exists and does nothing. This is the `type:bug`: the catalog content that makes the machinery bite was deferred out of #1465 by design, and is authored here.

Two latent inconsistencies surface on inspection of the schema vs. the live file:

1. **`axiom_overlap` key drift — deliberately left untouched.** The v3 schema (`invariant-schema.ts`) reads `axiom-overlap` (kebab-case), but the v2 loader (`invariants-loader.ts`) reads `axiom_overlap` (underscore) into `entry.axiomOverlap`, and the **coverage-closure lint depends on that v2 accessor**. Renaming the live catalog to kebab would silently break the one consumer that actually gates #1466 (coverage-closure would report DIM-1/2/3/7 as gaps). Since no #1466 acceptance criterion requires the kebab field to resolve, the catalog keeps `axiom_overlap` (underscore) **unchanged**. The schema/loader key-unification (have `invariant-schema.ts` accept underscore, or the loader emit kebab) is a *machinery* seam belonging to #1465's code surface, explicitly **out of #1466's content scope** — logged as Open Question #4 / follow-up, not done in this content PR.
2. **Two severity scales:** the catalog entry `severity` is `{ default: blocking|advisory, by-workflow?, by-phase? }` (a review-dimension verdict), while the leaf-check `severity` in `check-catalog.ts` is `HIGH|MEDIUM|LOW`. Authoring must not conflate them — entries carry the blocking/advisory scale; leaf precision is a separate axis the evaluator maps.

## Chosen Approach — B: Mechanize-where-precise, audit-the-rest (calibrated)

Author `mode: check` only for invariants that *already possess* a high-precision operational projection (an existing lint or a structural fact with near-zero false-positive rate); author `mode: audit` for every invariant whose conformance is a genuine judgment call. Each `mode: check` tree must satisfy the **calibrate-on-HEAD rule**: it produces **zero findings against the current clean tree** before it is declared, so the only finding on any diff is an *introduced* violation (and the authoring PR's own review stays green except for the deliberately-seeded fixture).

Rejected: **A (audit-first)** under-delivers against the bug — most invariants stay soft and the DSL is never exercised. **C (full mechanization)** authors greps that masquerade as semantic proofs, violating INV-4's spirit and guaranteeing review noise on legitimate future PRs.

### Enforcement-mode assignment

| Invariant | Mode | Leaf / projection | Why this mode |
|---|---|---|---|
| **INV-6** workload-agnosticism | `check` | reuse `scripts/lint-inv6.mjs` grep — workflow-typed literals in `skills-src/**` | Already a proven, enforcing lint; zero-FP today. |
| **INV-5d** action-discriminator | `check` | `structural` — count of visible composite tools registered in `registry.ts` ≤ 4 (and total visible ≤ 15) | A countable structural fact, not a judgment. |
| **INV-5a** input-ergonomics | `check` | `structural` — visible tool count < 15 (shares INV-5d's count) | Mechanical threshold. |
| **INV-4** platform-agnosticity | `check` | `grep` — direct edits to generated `skills/<runtime>/**` (source-of-truth violation) | High-precision: any diff hunk under `skills/<runtime>/` that isn't a regen is a violation. |
| **INV-2** facade-equivalence | `check` | `grep` (`scope`d) — behavior keywords appearing inside `adapters/{cli,mcp}.ts` beyond presentation | Heuristic proxy; **calibrated to zero on HEAD**, MEDIUM severity, advisory floor — flags suspicious adapter logic for human confirmation, does not claim to prove parity. |
| **INV-1** event-sourcing-integrity | `audit` | `audit-prompt` | Reducer purity / "is this a drifting side database?" is judgment. |
| **INV-11** posture / unrepresentable | `audit` | `audit-prompt` | Capability-resolution reasoning; not greppable. |
| **INV-3** basileus-forward | `audit` | `audit-prompt` | "Does this presume MCP-local?" is judgment. |
| **INV-13 / INV-14** process-manager / recovery | `audit` | `audit-prompt` | Two-event-split and recovery-primitive ordering are semantic. |

INV-7/8/9/10/12/15 keep affinity + severity metadata but no enforcement block at launch (audit-prompt may be added incrementally; absence is valid). The acceptance bar (≥1 `check` ∧ ≥1 `audit`, both exercised) is met several times over.

### Projection metadata (DR-5 §6 table)

Every authored entry gains:

- **`phase-affinity`** — enforcement-bearing substrate invariants get `[review]` (the gate phase); design-time invariants additionally get `[ideate, plan]` where they shape acceptance criteria.
- **`workflow-affinity`** — code-axis invariants exclude `discover` (docs-only workflow → code invariants N/A); all keep `feature/debug/refactor/oneshot`.
- **`severity`** — `default: blocking` for substrate invariants, with `by-workflow: { oneshot: advisory }` (the design's oneshot-downgrade) and `by-workflow: { discover: advisory }` where an invariant is retained but soft. INV-2's heuristic check is `default: advisory` (precision-limited proxy).
- **`integrity-class`** — `substrate` for INV-1..INV-15; `authoring` for the DIM-8 prose-quality pointer.

### Coverage-closure disposition (DR-8)

`DIM-4` (test-fidelity), `DIM-5` (hygiene), `DIM-6` (solid-coupling), `DIM-8` (prose-quality) are axiom-owned dimensions with no Exarchos-specific specializing invariant. Per DR-8 each is marked **`coverage: n/a`** with a one-line cross-reference to its owning axiom skill (`/axiom:verify`, `/axiom:distill`, `/axiom:critique`, `/axiom:humanize`). DIM-1/2/3/7 are already covered by specializing INVs via `axiom-overlap` and need only the key-normalization. The coverage-closure lint (additive to `npm run lint:invariants`, shipped by #1465) must exit zero after authoring.

## Requirements

### CR-1: Schema bump + back-compat
Bump `docs/architecture/invariants.md` frontmatter to `schema-version: 3`. **Do not** rename `axiom_overlap` (see Problem Statement #1 — coupling to coverage-closure). The existing loader back-compat fixture test stays green; add/extend a characterization asserting (a) the live catalog still parses under the v3 loader with zero errors, (b) v3 fields parse where authored, and (c) absent affinities resolve to all-phases/all-types.

**Acceptance:** loader parses the v3 catalog with zero errors; back-compat test green; `schema-version: 3`; coverage-closure still green (proving the `axiom_overlap` accessor is intact).

### CR-2: Author ≥1 `mode: check` + ≥1 `mode: audit`, exercised
Author the enforcement blocks per the assignment table. Each `mode: check` tree calibrated to **zero findings on HEAD**. Add a fixture-diff test: a seeded violating diff makes `check_invariant_conformance` produce a real finding with the invariant id, and a clean diff returns `APPROVED` with a `gate.executed` event (INV-10 observability).

**Acceptance:** ≥1 check and ≥1 audit authored and exercised against a fixture diff; clean-tree calibration verified; gate emits `gate.executed` on both paths.

### CR-3: Projection metadata populated
`phase-affinity`, `workflow-affinity`, `severity` authored per §DR-5 table. Verify projection excludes code invariants for `workflow-type=discover` and that `by-workflow: { oneshot: advisory }` downgrades resolve.

**Acceptance:** a projection test over the live catalog confirms discover-exclusion and oneshot-downgrade.

### CR-4: Coverage-closure satisfied
DIM-4/5/6/8 marked `coverage: n/a` with axiom cross-reference; DIM-1/2/3/7 confirmed covered. `npm run lint:invariants` exits zero.

**Acceptance:** coverage-closure lint green; `lint:invariants` byte-identical-or-cleaner than base; `skills:guard` exit 0.

### CR-5: Verify the gate bites end-to-end (INV-2 parity)
The fixture-diff verification runs through **both** the CLI and MCP adapters and asserts byte/schema-identical `ToolResult` (reuse `__tests__/parity-harness.ts`). This is the proof the authored content — not just the machinery — produces real findings on both facades.

**Acceptance:** parity test green over `check_invariant_conformance` with the authored catalog; full MCP suite + root suite green; `tsc --noEmit` clean.

## Integration Points

- `docs/architecture/invariants.md` — the authored content (all CRs).
- `servers/exarchos-mcp/src/architecture/invariant-schema.ts` — schema is the authoring target (read-only here; no code change expected unless an unforeseen field is needed).
- `servers/exarchos-mcp/src/architecture/invariants-loader.ts` + its tests — back-compat characterization (CR-1).
- `servers/exarchos-mcp/src/architecture/project-catalog.ts` + tests — projection assertions (CR-3).
- `servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.{ts,test.ts}` — fixture-diff exercise (CR-2/5).
- `scripts/lint-inv6.mjs` — referenced as INV-6's `mode: check` projection (reuse, not rewrite).
- `npm run lint:invariants` (vocabulary-lint + coverage-closure) — CR-4 gate.

## Testing Strategy

- **Back-compat:** v3-loader over the newly-bumped live catalog → zero parse errors; `axiom-overlap` resolves.
- **Calibration:** each `mode: check` tree evaluated against clean HEAD → zero findings (the bootstrap-hazard guard).
- **Fixture-diff bite:** seeded violation per authored check → finding with invariant id; clean diff → `APPROVED` + `gate.executed`.
- **Projection:** discover excludes code invariants; oneshot downgrades to advisory.
- **INV-2 parity:** gate through both adapters → identical `ToolResult`.
- **Coverage-closure:** `lint:invariants` exits zero; DIM-4/5/6/8 `n/a` markers honored.

## Open Questions (deferred to plan/implementation)

1. **INV-2 heuristic-check precision.** The adapter-behavior grep is the one genuinely-heuristic `mode: check`. If calibration on HEAD can't reach zero findings without an over-broad `not(...)` exclusion list, demote INV-2 to `mode: audit` (Approach-B fallback) rather than ship a noisy check. Decide at implementation against the real tree.
2. **Fixture-diff location.** Whether seeded violating diffs live as test fixtures under `check-invariant-conformance.test.ts` or as a small fixtures dir — a plan-time mechanical choice.
3. **INV-5a/5d shared count leaf.** Whether the visible-tool-count structural leaf is authored once and referenced, or duplicated across INV-5a and INV-5d — the DSL has no cross-entry reference, so likely duplicated with a shared pattern constant; confirm at plan.
4. **`axiom_overlap` key unification (out of #1466 scope).** The v3 schema reads `axiom-overlap` while the loader + coverage-closure read `axiom_overlap`. Unifying them is a one-line machinery change in #1465's surface (`invariant-schema.ts` or `invariants-loader.ts`), tracked as a small follow-up so `/axiom:design` pairing-discovery sees the v3 field. Not blocking #1466.
