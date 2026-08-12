# Implementation Plan — #1486 open sub-issues (refactor)

**Workflow:** `refactor-1486-subissues` (overhaul track) · **Branch:** `refactor/1486-subissues` · **Delivery:** one bundled PR
**Source issues:** #1498 (enhancement), #1499 (bug, expanded), #1500 (bug) — all surfaced by `/exarchos:dogfood` on PR #1497.

## Goals (from brief)

1. **#1498** — surface `.exarchos/invariants.md` always-load Constraints at **design-time** in `/refactor` (brief) and `/debug` (design/rca), gated by `invariants.devCatalog`; de-dupe the brainstorming Phase 0; add catalog pointers to the `refactor.brief` + `debug.design` playbook `compactGuidance`. Acceptance requires **one shared source** (no per-skill duplication). *Shepherd dev-note deferred to a fast-follow.*
2. **#1499 (expanded)** — migrate **all 7 gate handlers** that read `.state.json` as an authoritative source to the canonical `resolveWorkflowState` (event-store fallback). INV-1: SQLite is the sole source of truth; `.state.json` is a derived stamp.
3. **#1500** — `check_tdd_compliance` on a 0-commit `base..branch` range returns a **non-pass advisory** (third status `warn`), not a vacuous PASS.

## Invariant conformance (design-time constraints)

- **INV-1 (event-sourcing-integrity)** — WS2 is *the* fix: read-models are left-folds over events, never the `.state.json` side surface. `resolveWorkflowState` (`verbs/resolve-state.ts`) materializes via `workflowStateProjection`; the `state.patched` deep-merge case means every planner-stamp field the handlers read is already in the projection.
- **INV-2 (facade-equivalence)** — all handler fixes live in the shared dispatch core (called by both CLI + MCP via `composite.ts`); zero behavior added to adapters. Registry Zod schema is the single source for CLI flags + MCP shape.
- **INV-4 (platform-agnosticity)** — WS1 edits `skills-src/` source-of-truth + `commands/`; regen `skills/<runtime>/**` via `npm run build:skills`; `skills:guard` must be clean.
- **INV-5a/5b (input/output contract)** — new args (`featureId`, optional `stateFile`) are schema-constrained; tool results keep the fixed carrier shape (`#1500`'s new status still maps to the standard `passed` envelope).

## Workstreams & tasks

File-disjoint workstreams **A / B / C run in parallel**. Within WS2, tasks **serialize** on the `composite.ts` + `registry.ts` hotspots.

### WS1 — #1498 design-time invariant parity (content + playbooks)

- **T-01** — Establish the single shared constraint-anchoring source + de-dupe brainstorming Phase 0.
  - Extract the canonical "Constraint anchoring" selection-rules into one reference (`skills-src/brainstorming/references/constraint-anchoring.md`); remove the in-file duplicate block(s) in `skills-src/brainstorming/SKILL.md` (the doubled Phase 0 at ~:30 and ~:60); point brainstorming + `commands/ideate.md` at the canonical reference.
  - *Test:* content assertion (no duplicated Phase 0 in brainstorming), `npm run lint:invariants` clean.
- **T-02** — Wire `/refactor`: add a design-time **Constraints** step to the refactor `brief` phase (skill reference + `commands/refactor.md`) that loads `.exarchos/invariants.md` always-load entries **before** approach commitment, gated by `invariants.devCatalog`, pointing at the T-01 shared source. *(dep: T-01)*
- **T-03** — Wire `/debug`: same for the debug `design`/`rca` phases (skill references + `commands/debug.md`), devCatalog-gated, pointing at the shared source. *(dep: T-01)*
- **T-04** — Playbook `compactGuidance`: add the catalog pointer to `refactor.brief` and `debug.design` in `servers/exarchos-mcp/src/workflow/playbooks.ts` so the constraint survives a compacted resume. *Test:* assert each `compactGuidance` names `.exarchos/invariants.md`. *(independent)*
- **T-05** — `npm run build:skills`; `npm run skills:guard` clean; `npm run lint:invariants` clean. *(dep: T-01..T-04 — integration)*

### WS2 — #1499 state-source migration (7 handlers → `resolveWorkflowState`)

Target adapter: `adaptArgsWithStateDirAndEventStore` (the good-pattern wiring used by `request_synthesize`/`finalize_oneshot`). Each task: add `featureId`, make `stateFile` optional (registry Zod → CLI flags auto-emit), resolve via `resolveWorkflowState({stateFile, featureId, eventStore})`, keep file-based behavior when a file is present. TDD: each adds a **fileless MCP-only** resolution test.

- **T-06** — `pre_synthesis_check` (the named #1499). Rewire `adaptArgs → adaptArgsWithStateDirAndEventStore`; `checkStateFile` → resolver; registry schema. *Test: fileless workflow runs the 7 checks (no `INVALID_INPUT`).* *(WS2 anchor — establishes the pattern)*
- **T-07** — `verify_review_triage` + `extract_fix_tasks` (both BUG, both `adaptArgs`). Migrate the `.state.json` reads; for `verify_review_triage` resolve the event-stream side from the event store too (drop the `.events.jsonl` file requirement) or keep as explicit override. *(dep: T-06 — shares `composite.ts`/`registry.ts`)*
- **T-08** — 4 LATENT handlers: `check_design_completeness` (route the pure path through the resolver), `select_debug_track`, `investigation_timer`, `assess_refactor_scope` (inject eventStore; keep `files`/`reviewReport` alt paths). *(dep: T-07 — shares hotspots)*

### WS3 — #1500 tdd-compliance vacuous pass

- **T-09** — `verbs/pure/tdd-compliance.ts`: extend `status` union with `warn`; on `commits.length === 0` emit a WARNING report + `status: 'warn'` ("no commits between base and branch — already merged? check ordering"). Handler `tdd-compliance.ts` already maps non-`pass` → `passed:false`; emit the advisory in `data`. Update both co-located tests (the existing `'no commits found returns pass'` test flips to expect the advisory). *(independent)*

## Out of scope (follow-up issues filed)

- **#1504** (v2.11.0) — `resolveWorkflowState` file-first → event-first hardening (stale on-disk stamp can shadow the authoritative log; the drift `reconcile_state` repairs). Lands after this PR.
- **#1505** (v2.11.0) — shepherd invariant-conformance pointer at the synthesize/CI gate (#1498 dev-note; a conformance reminder, not a design-time Constraints section).

## Verification gate (all tasks)

`npm run build` · `npm run typecheck` · `npm run test:run` · MCP suite (`cd servers/exarchos-mcp && npm run test:run`) · `npm run skills:guard` · `npm run lint:invariants` — all green before synthesize.

## Open decision for plan-review

**WS1 sharing mechanism.** Recommended: **pointer-based single-source** (T-01) — matches the existing convention where `commands/ideate.md` references brainstorming's "Constraint anchoring" subsection rather than inlining it; all three workflows point at one canonical reference; **no renderer change**. Alternative: build a cross-skill `_shared/` include into `build-skills.ts` (cleaner transclusion, unblocks the orphaned `_shared/references/*`, but a riskier renderer change that doesn't naturally serve `commands/*.md`).
