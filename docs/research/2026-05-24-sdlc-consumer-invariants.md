# Research: The SDLC-* Consumer-Facing Invariants Catalog

> **Status:** Discovery deliverable — output of `/exarchos:discover`, input to a follow-on `/exarchos:ideate`.
> **Date:** 2026-05-24
> **Issue:** [#1467](https://github.com/lvlup-sw/exarchos/issues/1467) (`type:docs` — scoping; has an implementation tail, see §5)
> **Stacks on:** #1466 (`feature/invariants-dev-catalog-v3-content`) → #1465 (machinery)
> **Mechanism delivered by:** [PR #1465](https://github.com/lvlup-sw/exarchos/pull/1465) (`integrity-class: sdlc`, layered merge, override-floor)
> **Provenance:** v2 spec [§10](../proposals/2026-05-20-invariants-catalog-v2-spec.md); design [DR-6 + Open Question #2](../designs/2026-05-23-invariants-projection-and-extensibility.md)

## 1. Research question

PR #1465 built the **sdlc layer mechanism** but authored **zero** `SDLC-*` entries; the layer is a hardcoded empty-array placeholder. This discovery answers two questions before any catalog is authored:

1. **What is the `SDLC-*` set** — which consumer-facing invariants ship default-on, and as `mode: check` vs `mode: audit`?
2. **Where is the audience boundary** — what distinguishes a consumer SDLC invariant from (a) an Exarchos *dev* invariant (`INV-*`, `devCatalog`-gated) and (b) a consumer's *own* application invariant (`U-*`, user layer)?

It does **not** author the catalog. The authoring + the code seam it requires are a follow-on `/exarchos:ideate` (§5).

## 2. What the mechanism already provides (the constraints authoring must fit)

From `catalog-merge.ts` and `resolve-effective-catalog.ts` (PR #1465):

- **Three layers, merged in order** `dev → sdlc → user` (`mergeCatalogs`). The sdlc layer is tagged `integrity-class: sdlc`.
- **Override floor.** `resolveFloor` derives a per-invariant floor from `integrity-class`; **sdlc defaults to `advisory`** — a consumer may downgrade an `SDLC-*` entry to advisory via `.exarchos.yml: invariants.overrides`, but the honored-disable filter refuses a full `enabled: false` unless the floor permits it. An entry may carry an explicit `override-floor: advisory | disable` to widen/narrow this. This is the POLA authority gradient (INV-11) realized for consumers: **tunable, never silently removable.**
- **`SDLC-*` is a reserved namespace** (`RESERVED_USER_ID_PREFIXES`). A user catalog claiming an `SDLC-*` id fails with `ReservedNamespaceError`. So the shipped sdlc set owns that prefix; consumers extend with free-form/`U-*` ids.
- **The seam is open.** `resolve-effective-catalog.ts:131` hardcodes `const sdlc: InvariantEntry[] = []` with the comment *"sdlc catalog CONTENT is out of scope for this task."* **Shipping the catalog requires closing this seam** (load a plugin-bundled catalog file into the sdlc layer) — a small code change, not pure docs (§5).
- **Projection applies uniformly.** `SDLC-*` entries carry `phase-affinity` / `workflow-affinity` / `severity` / `enforcement` exactly as the dev `INV-*` entries do (the #1466 worked reference). The same `check_invariant_conformance` gate evaluates them.

## 3. The audience boundary (the load-bearing distinction)

Three concentric audiences, three id namespaces, three integrity classes:

| Catalog | Audience | Governs | id prefix | default state |
|---|---|---|---|---|
| **dev** | Exarchos's own contributors | the Exarchos runtime substrate (event log, OCC, posture, dispatch parity) | `INV-*` / `DIM-*` | `devCatalog`-gated, **off** for consumers |
| **sdlc** | *any* engineer using Exarchos as a plugin | **how they run their SDLC through Exarchos** — workflow conduct, not application code | `SDLC-*` | **default-on** |
| **user** | a specific consumer project | *their own* application architecture | free-form / `U-*` | opt-in via `catalogs:` |

The discriminator for an `SDLC-*` entry is: **it governs the consumer's conduct of a software-development workflow, enforceable through affordances Exarchos already exposes** (lifecycle events, review gates, the PR template, checkpoint/rehydrate, posture) — and it is **workload-neutral** (true for a React app, a Go CLI, a Python service alike).

It is **not** an `SDLC-*` invariant if:
- it describes Exarchos's *internal* substrate (that's dev/`INV-*`, and consumers never touch it — they use the affordances, they don't reimplement the runtime); or
- it describes the *consumer's application* (that's their `U-*` user catalog — e.g. "all HTTP handlers validate input"; Exarchos has no opinion).

**Relationship to dev `INV-*`:** several `SDLC-*` entries are the *consumer-facing mirror* of a substrate `INV-*`. INV-10 (liveness protocol) is substrate machinery; **SDLC phase-observability** is the consumer-visible guarantee that machinery affords. INV-14 (native-primitive recovery) is substrate; **SDLC recovery-posture** is the consumer's "my workflow is resumable from disk" guarantee. The mirror is intentional — same principle, different audience, different enforcement surface.

## 4. Proposed `SDLC-*` set (default-on baseline)

Five entries for the launch baseline, drawn from v2 spec §10 and the design's named candidates. Each lists its enforcement mode (mechanizable `check` vs judgment `audit`, applying #1466's calibration discipline — *only mechanize a high-precision, diff-visible proxy*), default severity, override-floor, and workflow-affinity.

### SDLC-1 — Phase observability
*Every long-running workflow operation is queryable; nobody asks "what step are we on?"* — the workflow emits lifecycle events and state is reconstructible.
- **Mode:** `audit` (the consumer's workflow either emits via Exarchos affordances or it doesn't; a diff-grep can't judge "observable"). Mirrors substrate INV-10.
- **Severity:** advisory · **floor:** advisory · **workflow-affinity:** all except `discovery`.

### SDLC-2 — TDD discipline (when declared)
*Test-before-implementation for workflow types that name it (`feature`, `oneshot`); `discovery` exempt; `debug`/`refactor` have their own gates.* The consumer-facing analogue of `check_tdd_compliance`.
- **Mode:** `audit` at review (the RED-before-GREEN ordering is a commit-history property, not a single-diff property — the same reason #1466 kept judgment calls as audit). Candidate `check` only if a diff-visible proxy proves reliable.
- **Severity:** blocking on `feature`/`oneshot`; **`by-workflow: { discovery: advisory }`** · **floor:** advisory · **workflow-affinity:** `feature`, `oneshot`.

### SDLC-3 — Review-gate honesty
*A gate that fails surfaces its findings; the verdict reflects them. No advisory-laundering of a HIGH finding; silently passing a gate is worse than a loud fail.*
- **Mode:** `audit` (honesty is a judgment about the verdict↔findings relationship).
- **Severity:** blocking · **floor:** advisory · **workflow-affinity:** all except `discovery`.
- *Note:* this is the entry the design uses as the `override-floor` worked example (`SDLC-3` downgradable to advisory, not disable-able).

### SDLC-4 — Branch / PR discipline
*PR bodies carry the required sections (`## Summary` / `## Changes` / `## Test Plan`); stacked PRs merge bottom-up; no admin-merge bypassing review.*
- **Mode:** **`check`** for the mechanizable half — a grep over the PR body for the required section headers is a high-precision, text-visible proxy (the one strong `check` candidate in the set). `audit` for the "no admin-merge bypass" half.
- **Severity:** blocking · **floor:** advisory · **workflow-affinity:** all except `discovery`.
- *Provenance:* promotes project memory `feedback_stacked_pr_auto_merge_collapses_granularity` + the PR-template CI rule to a first-class invariant.

### SDLC-5 — Recovery posture
*Any workflow pauses (checkpoint) and resumes (rehydrate) from on-disk state without consulting human memory; recovery prefers native primitives, never destructive overwrite.*
- **Mode:** `audit`. Mirrors substrate INV-14 for the consumer.
- **Severity:** advisory · **floor:** advisory · **workflow-affinity:** all.

### Deferred candidates (named in §10, held back from the launch baseline)
- **Authoring/playbook split** — the consumer-facing mirror of INV-6; defer until consumers actually author skills/playbooks (low signal at launch).
- **Subagent boundary** — "sub-agents inherit posture; orphans are reaped" overlaps substrate INV-11 and is largely enforced by the runtime, not the consumer's conduct; defer.

**Mode tally:** 1 `check` (SDLC-4 PR-section grep) + 5 `audit`-bearing — matching #1466's finding that, under INV-4's declarative-only constraint, *most* invariants are honestly judgment calls and only a few have a high-precision diff-visible proxy.

## 5. What "shipping the catalog" actually requires (the implementation tail)

The issue's acceptance has four items; only item 1 is this discovery. The rest is a follow-on `/exarchos:ideate` and is **not pure docs**:

1. ✅ **This research artifact** — SDLC-* set + audience boundary (delivered here).
2. ⏳ **Author the catalog file** — a plugin-bundled `SDLC-*` catalog (e.g. `catalogs/sdlc-invariants.md`, shipped in the plugin package), authored in the #1466 v3 shape.
3. ⏳ **Close the loader seam** — replace `resolve-effective-catalog.ts:131`'s `const sdlc = []` with a loader that reads the bundled catalog **default-on** (no `devCatalog`-style gate; sdlc ships enabled). This is the one genuine code change.
4. ⏳ **Verify override-floor end-to-end** — a test proving a consumer can downgrade `SDLC-3` to advisory but a full `enabled: false` is refused by the honored-disable filter (the floor holds).
5. ⏳ **Update the consumer guide** — `docs/guides/authoring-invariants.md` to document the shipped baseline + how to override it.

## 6. Open questions for the follow-on ideate

1. **Catalog file location & packaging** — where the plugin bundles the sdlc catalog so the loader finds it both in-repo and when installed as a plugin (path resolution differs from the `repoRoot`-relative dev catalog).
2. **Default-on vs gate** — confirm sdlc ships with *no* opt-in flag (unlike `devCatalog`). The override mechanism is the consumer's escape hatch, not a master switch — consistent with "default-on baseline."
3. **SDLC-2 TDD enforcement surface** — whether the existing `check_tdd_compliance` gate is *reused* (SDLC-2 points at it) or re-expressed as catalog enforcement; avoid double-gating.
4. **SDLC-4 check precision** — calibrate the PR-body-section grep against real PR bodies before declaring it `check` (the #1466 calibrate-on-HEAD discipline).

## 7. Recommendation

Proceed to a follow-on `/exarchos:ideate` scoped to **author the 5-entry `SDLC-*` baseline + close the loader seam (items 2–5 above)**, stacked on this branch. The audience boundary in §3 is the acceptance test for every candidate entry: *if it isn't workload-neutral consumer workflow-conduct enforceable through an existing Exarchos affordance, it doesn't belong in `SDLC-*`.*
