# Design: Author the SDLC-* Consumer Catalog + Close the sdlc-Layer Seam

> **Status:** Design — output of `/exarchos:ideate`, input to `/exarchos:plan`.
> **Date:** 2026-05-24
> **Issue:** [#1467](https://github.com/lvlup-sw/exarchos/issues/1467)
> **Research input:** [`docs/research/2026-05-24-sdlc-consumer-invariants.md`](../research/2026-05-24-sdlc-consumer-invariants.md)
> **Stacks on:** #1466 (`feature/invariants-v3-content-and-sdlc`) → #1465 (machinery). **Merges as one combined PR.**
> **Catalog:** adds the **sdlc layer** (new, plugin-bundled, default-on); dev catalog (`INV-*`) unchanged.

## Constraints (Phase 0 — devCatalog: enabled)

- **INV-11 (POLA authority gradient)** — `integrity-class: sdlc` ⇒ override-floor `advisory`: consumers tune `SDLC-*` down to advisory, never silently disable. The override-floor verification is the load-bearing acceptance test (DR-3).
- **INV-1 (no drifting side store)** — the inline catalog is a module constant; `resolveEffectiveCatalog` stays a pure read-model with **zero file-IO** for the sdlc layer.
- **INV-2 (facade-equivalence)** — the sdlc layer flows through the single `resolveEffectiveCatalog` core the gate + view + CLI already share; no second path.
- **INV-6 (workload-agnosticism)** — every `SDLC-*` entry is workload-neutral (the research §3 audience-boundary test).
- **INV-4 / INV-3** — baseline is all-audit (sandbox-free by construction); prompts are transport-neutral.
- **DIM-3 (contracts)** — `resolveEffectiveCatalog`'s signature and the entry Zod schema are unchanged; the seam change is additive.

## Problem Statement

PR #1465 wired the sdlc layer as a hardcoded empty-array placeholder (`resolve-effective-catalog.ts:131`: *"sdlc catalog CONTENT is out of scope"*), and #1467's discovery scoped the content + audience boundary. This design ships the content. The packaging reality forces the mechanism: the MCP server runs as a **single-file binary** (`command: "exarchos"`), and the npm `files` list bundles `dist/bin`, `commands`, `skills` — **not `docs/`**. A catalog under `docs/` would be absent for plugin consumers, so a "default-on" catalog cannot be a `docs/` file read at runtime.

## Chosen Approach — Inline TS module, schema-validated

Author the `SDLC-*` baseline as a typed array in `servers/exarchos-mcp/src/architecture/sdlc-catalog.ts`, validated at module load through the **same** `InvariantEntryV3Schema` the dev loader uses (INV-4 `.strict()` enforcement guarantee preserved). The seam at `resolve-effective-catalog.ts:131` becomes `const sdlc = loadSdlcCatalog();` — a constant import, no `fs`, no `devCatalog`-style gate (sdlc ships **on**). Consumers still author *their own* catalogs as `.md`/`.yml` via `config.invariants.catalogs`; only Exarchos's shipped baseline is code.

To avoid duplicating the loader's raw→typed projection, expose a pure `parseInvariantEntries(raw: unknown[]): InvariantEntry[]` from `invariants-loader.ts` (the existing internal `parseEntry` + `projectV3Fields`, minus file-IO and the devCatalog gate). Both the file loader and `sdlc-catalog.ts` call it — one parse path (INV-2 spirit), no drift.

Rejected: a shipped `.md` data file (adds packaging entries + `EXARCHOS_PLUGIN_ROOT` path resolution + runtime disk-IO); a build-time `.md`→TS embed (adds a codegen step). Both carry more failure surface for no authoring benefit on a 5-entry shipped baseline.

## Requirements

### DR-1: Author the 5-entry `SDLC-*` baseline (all-audit)
In `sdlc-catalog.ts`, author SDLC-1..5 per research §4, each with `integrity-class: sdlc`, `axis: substrate` (closest enum fit for "runtime conduct"; also yields the desired discovery-exclusion), `enforcement: { mode: audit, audit-prompt }`, `severity`, and `workflow-affinity` **excluding `discovery`** (see §below). Audit prompts are transport-neutral (INV-3) and workload-neutral (INV-6).

| id | summary | severity | workflow-affinity |
|---|---|---|---|
| SDLC-1 phase-observability | long-running ops queryable; state reconstructible | advisory | feature, debug, refactor, oneshot |
| SDLC-2 tdd-discipline | test-before-impl where declared; prompt **points at `check_tdd_compliance`** (no double-gate) | blocking; `by-workflow:{oneshot:advisory}` | feature, oneshot |
| SDLC-3 review-gate-honesty | verdict reflects findings; no advisory-laundering of HIGH | blocking | feature, debug, refactor, oneshot |
| SDLC-4 branch-pr-discipline | PR body has Summary/Changes/Test Plan; bottom-up stacked merge; no admin-merge bypass | blocking | feature, debug, refactor, oneshot |
| SDLC-5 recovery-posture | pause/resume from on-disk state; native-primitive-first, no destructive overwrite | advisory | feature, debug, refactor, oneshot |

**Acceptance:** `loadSdlcCatalog()` returns 5 schema-valid `InvariantEntry[]`; each `axis: substrate`, `integrity-class: sdlc`, `mode: audit`; a malformed inline entry fails at module load (fail-fast).

**Discovery scoping note:** `projectCatalog` already excludes `axis: substrate` entries from `discovery` workflows. SDLC entries are `axis: substrate`, so all five are excluded from discovery automatically — consistent with their `workflow-affinity` (discovery is a docs-research workflow; SDLC conduct invariants target code-bearing workflows). This deliberately tightens research §4's SDLC-5 "all" to "exclude discovery" and needs **no machinery change**.

### DR-2: Close the sdlc-layer seam
Replace `resolve-effective-catalog.ts:131`'s `const sdlc: InvariantEntry[] = []` with `const sdlc = loadSdlcCatalog()`. No gate. `mergeCatalogs` already tags sdlc entries `integrity-class: sdlc`; the inline `integrity-class` is reaffirmed, not relied upon.

**Acceptance:** with `devCatalog: disabled` (a consumer), `resolveEffectiveCatalog` at `phase=review, workflow=feature` returns the SDLC-* entries (dev layer empty, sdlc layer populated) — proving sdlc is default-on independent of the dev gate. Parity: the `invariants_effective` view + CLI `--json` surface the same SDLC entries (INV-2, reuse parity harness).

### DR-3: Verify override-floor end-to-end (the INV-11 acceptance)
A consumer `overrides: { SDLC-3: { severity: advisory } }` clamps SDLC-3 to advisory; `overrides: { SDLC-3: { enabled: false } }` is **refused** by the honored-disable filter (sdlc floor = advisory) — the entry survives and a warning is emitted, never a silent drop.

**Acceptance:** a config-driven test (real `resolveEffectiveCatalog`, no DI double) proves both: severity-clamp honored; full-disable refused + warning surfaced.

### DR-4: Update the consumer authoring guide
`docs/guides/authoring-invariants.md` documents the shipped default-on `SDLC-*` baseline, the override-floor semantics (tune-to-advisory, not disable), and the dev/sdlc/user audience split (research §3).

**Acceptance:** the guide names all five SDLC-* entries + a worked override example; no new `vocabulary-lint` findings (SDLC-* is outside the `INV-/DIM-` token regex, so it is lint-neutral).

## Integration Points

- `servers/exarchos-mcp/src/architecture/sdlc-catalog.ts` — **new**: inline catalog + `loadSdlcCatalog()` (DR-1).
- `servers/exarchos-mcp/src/architecture/invariants-loader.ts` — expose `parseInvariantEntries(raw[])` (refactor, reused by the loader + sdlc-catalog).
- `servers/exarchos-mcp/src/architecture/resolve-effective-catalog.ts` — close the seam (DR-2).
- `docs/guides/authoring-invariants.md` — DR-4.
- Tests: `sdlc-catalog.test.ts` (DR-1), `resolve-effective-catalog.test.ts` (DR-2/DR-3 default-on + override-floor).

## Testing Strategy

- **Catalog validity:** `loadSdlcCatalog()` → 5 entries, all `mode: audit`, `integrity-class: sdlc`; a malformed entry throws at load.
- **Default-on isolation:** `devCatalog: disabled` still yields SDLC-* (the consumer scenario); `devCatalog: enabled` yields dev + sdlc.
- **Override-floor:** severity-clamp honored; full-disable refused + warning (DR-3, config-driven).
- **Discovery exclusion:** `workflow=discovery` projects zero SDLC-* entries.
- **Parity:** gate + view return identical SDLC payload (reuse `__tests__/parity-harness.ts`).
- **No regression:** full MCP + root suites; `tsc --noEmit`; `skills:guard`; `lint:invariants` (coverage-closure still green, no new findings).

## Open Questions (deferred to plan/implementation)

1. **`parseInvariantEntries` extraction shape** — whether to expose the batch parser or a single-entry `parseInvariantEntry`; mechanical, decided at plan against the existing `parseEntry` signature.
2. **SDLC-2 ↔ `check_tdd_compliance` linkage** — the audit-prompt references the existing gate by name; confirm no projection wiring makes it double-fire at review.
3. **`axis` semantics for sdlc** — `substrate` is the pragmatic enum fit; a future `axis: sdlc` value is a possible machinery refinement (out of scope here, logged).
