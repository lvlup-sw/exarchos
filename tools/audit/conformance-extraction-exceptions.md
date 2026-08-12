# Conformance extraction — measured blockers and stated exceptions (task 018a)

`src/architecture/` is 74 files and 26,492 LOC of first-party enforcement living
inside the tree it governs. Task 018a extracts it to `tools/conformance/` as a
real package.

The spec's rule for this task is that the blocker is **measured and inverted,
not ignored**, and that any edge which cannot be inverted cheaply **leaves its
module in `src/` and is recorded here** — a partial extraction that is honest
beats a circular package that type-checks by accident.

This file is the measurement. Regenerate it with
`node tools/audit/measure-conformance-extraction.mjs`.

## The first measurement was wrong, and how

The plan estimated "~26 outbound imports into the core it inspects". The first
run of the instrument reported 29 outbound edges, 21 of them value imports, and
partitioned 11 modules as needing inversion.

**Two of those eleven never had a value edge at all**, and two more had inflated
subject lists. The instrument's statement regex was unanchored, so its lazy
clause ran past a bare specifier it could not match into the *following*
statement:

```ts
import fs from 'node:fs';                                  // 'node:fs' rejected
import type { PluginFinding } from '../review/check-catalog.js';   // absorbed
```

The match began at line 1, found no `type` keyword there, and reported line 2's
type-only edge as a value import. Every `node:` import followed by a relative
`import type` was misread the same way. The regex is now line-anchored with a
`;`-free clause, so a match cannot leave its own statement.

The correction is worth stating plainly because it repeats this refactor's
standing lesson: **a measurement instrument is itself a guard, and it can lie.**
The partition below is the corrected one.

## The corrected partition

Partitioned by extraction cost, the 36 non-test modules are:

| Bucket | Count | Meaning |
| --- | ---: | --- |
| **Clean** | 20 | No outbound edge into `src/`. Moves as-is. |
| **Type-only** | 7 | Outbound edges all erase at compile time. Moves as-is. |
| **Value** | 9 | Imports a runtime value from the subject. |

**27 of 36 modules (75%) move without any inversion at all.** Of the nine value
modules, one is the composition root itself and one is a permanent stated
exception, leaving **seven genuine inversions**.

### Clean — no outbound edge (20)

`__fixtures__/swallows.fixture.ts`, `adapter-ownership-seam.ts`,
`audit-delivery-closure.data.ts`, `audit-prompt.ts`, `catalog-merge.ts`,
`delivery-safety.ts`, `description-budget-cli.ts`, `effect-ledger.ts`,
`effect-port-seam.ts`, `event-grammar-concessions.ts`, `glob-to-regexp.ts`,
`import-cycles.ts`, `invariant-schema.ts`, `layer-boundaries-seam.ts`,
`project-catalog.ts`, `report-coupling-seed-pin.ts`, `report-coupling-seed.ts`,
`sdlc-catalog.ts`, `vcs-ownership.ts`, `vocabulary-lint-cli.ts`

### Type-only — erases at compile time (7)

`authority-census.ts`, `catalog-sources.ts`, `check-evaluator.ts`,
`contract-seam.ts`, `resolve-effective-catalog.ts`, `sdk-generation-seam.ts`,
`vocabulary-lint.ts`

`contract-seam.ts` and `resolve-effective-catalog.ts` are the two the first
measurement misclassified. `vocabulary-lint.ts` earned its place here: its
`config/artifacts` edge was the first inversion applied (see below).

### The composition root (1)

`bindings.ts` holds the subject imports **by design**. Every census takes its
tables, schemas and directories as parameters; this module is the one place that
supplies the real values. Deleting the edge by re-typing those constants inside
the package would pass a naive boundary check while reintroducing exactly the
drift the constants exist to prevent — the census would assert against a copy
that no longer matches what ships. The boundary rule is therefore "no
*uninverted* edge into the subject", and this module is its sole exception.

## The premise that mattered most, and it was false

The plan's framing — "`src/architecture/` is 78 files of first-party enforcement
living inside the tree it governs" — is **true of roughly half the directory.**

Measuring which modules are imported from OUTSIDE `architecture/` by
*production* code (`tools/audit/` has the script; it is reproduced in
`measure-conformance-extraction.mjs`'s sibling analysis) found **eleven modules
with production value consumers**:

| Module | Production consumers |
| --- | --- |
| `effect-ledger.ts` | 7 — `contract/oracle/{fixtures,oracle-seam}`, `contract/reachability/{collect,providers}`, `events/{event-registration,registration-validate}`, `test-helpers/module-lexer` |
| `invariants-loader.ts` | 3 — `verbs/gates/check-invariant-conformance`, `verbs/invariants/{add,amend}` |
| `resolve-effective-catalog.ts` | 3 — `projections/views/effective-catalog`, `verbs/doctor/probes`, `verbs/gates/check-invariant-conformance` |
| `invariant-schema.ts` | 2 — `verbs/invariants/{add,amend}` |
| `glob-to-regexp.ts` | 2 — `verbs/team/{prepare-delegation,prepare-synthesis}` |
| `catalog-sources.ts`, `catalog-merge.ts` | `verbs/doctor/probes` |
| `project-catalog.ts`, `check-evaluator.ts`, `audit-prompt.ts`, `audit-delivery-closure.data.ts` | `verbs/gates/check-invariant-conformance` |

These are not enforcement instruments. They are the **invariants-catalog
subsystem and shared utilities** — the machinery behind the `invariants_add` /
`invariants_amend` verbs and the `check_invariant_conformance` gate, which are
product features. They are misfiled under `architecture/`, and moving them into a
dev-tooling package would make production code import from `tools/`, inverting
the dependency direction.

Adding the modules that transitively depend on them, **18 of 39 modules stay and
21 move**. Notably `layer-boundaries-seam.ts` (51 tests) and `vocabulary-lint.ts`
stay only because they reach `effect-ledger.ts` and `invariants-loader.ts`
respectively — re-homing those two pinned modules out of `architecture/` into a
proper `src/` domain would unblock both, and that belongs to task 019's residual
mapping rather than here.

### Value — needs inversion (7)

| Module | Subject | Inversion |
| --- | --- | --- |
| `vocabulary-lint.ts` | `config/artifacts` (`DEFAULT_SPEC_DIR`, `DEFAULT_LEGACY_DESIGN_DIR`) | **Done.** `DATED_RECORD_TREES` became `datedRecordTrees(dirs)`; the two prefixes arrive from `bindings.ts`. |
| `authority-topology.ts` | `contract/declaration` (`DECLARATION_KINDS`) | Accept the kinds table as a rule-table parameter. |
| `description-budget.ts` | `registry` (`TOOL_REGISTRY`, `buildToolDescription`) | Accept the registry and the description builder. |
| `invariants-loader.ts` | `config/yaml-schema` | Accept the schema. |
| `audit-delivery-closure.ts` | `registry`, `verbs/worktree/schemas` (`extractEnvelopeDataSchema`) | Accept the registry and the extractor as a port. |
| `event-grammar-census.ts` | `events/schemas`, `events/event-name` (`classifyEventName`) | `classifyEventName` is pure and grammar-owned; prefer relocating it into the package over threading it. |
| `report-coupling-census.ts` | `events/schemas`, `events/event-annotations`, `events/event-registration` | Accept the annotation table and the emission-source resolver. |
| `output-schema-census.ts` | `registry`, `verbs/worktree/schemas`, `contract/schemas/schema-totality`, `output-schema-vacuity-allowlist`, `output-schema-seed-pin` | Heaviest module in the set. The two `output-schema-*` files are conformance data and migrate WITH the package rather than being threaded. |

### Stated exception — stays in the subject tree (1)

`__fixtures__/declaration-seam-violator.fixture.ts` imports `events/schemas`.
This fixture exists to **be** a seam violation; its imports are the thing under
test, so inverting them destroys the fixture's purpose. It is a permanent stated
exception and remains in `src/`.

## Where the path constants went

The censuses previously computed the repository root per-module with
`path.resolve(__dirname, '../../../..')`. That idiom fails silently across a
move: a stale hop count still resolves to a real directory, so the census scans
the wrong tree, finds nothing, and reports green — the guard goes vacuous rather
than red.

`tools/conformance/src/subject-root.ts` replaces it. The root is found by
searching upward for the sentinel `package.json` named `@lvlup-sw/exarchos`, in
one place, and it throws rather than guessing when it cannot be found. Relocating
the subject tree (task 019 folds `servers/exarchos-mcp/src/` up to `src/`) is a
one-line change to `SUBJECT_SRC_REL`.

## Status: inversions landed, the physical move is blocked on guard discovery

Every inversion is applied and green. **No movable module carries an uninverted
edge into the subject any more** — re-run `measure-conformance-extraction.mjs`
and the only VALUE rows left are the five `bindings/*` composition-root modules
(by design), plus the two stayers and the stated-exception fixture.

The move itself was executed end-to-end and then **deliberately reverted**. It is
worth recording exactly how far it got and what stopped it, because the blocker
is real and belongs to another task.

`move-conformance.mjs` performs the move: 39 files (22 modules + 17 tests), 100
arithmetic specifier rewrites. Applying it and repairing the fallout left the
extracted suite at **15 of 16 files green**. What was repaired along the way:

- **Seven test files carried stale root computations** — `'../../../..'`,
  `resolve(HERE, '..')`, `resolve(MCP_PACKAGE_ROOT, '..', '..')`. Every one
  still resolved to a real directory at the new depth, so each would have gone
  vacuous rather than red. `subject-root.ts` (plus a `SUBJECT_PACKAGE_ROOT`
  export) replaces all of them.
- **Five stale path literals in no import position** — the codemod's declared
  blind spot. A fixture root, a docs path, a census key, and `wave1-exit`'s four
  governed-artifact paths.
- **`contract-seam-doc.test.ts` had to move back.** It reads
  `invariant-schema.ts` **by path rather than by import**, so the movable-closure
  analysis — which follows imports — could not see that its subject stayed
  behind. A second instance of the same class: `contract-seam.test.ts` lints the
  same file and needed re-pointing at the subject tree.
- **Four CI steps** invoke these tests by path from `servers/exarchos-mcp`. Two
  had to split, because a single step now spans both workspaces and dropping
  either half would recreate #1711's skipped-as-passed.

### The blocker

`wave1-exit.test.ts` asserts every Wave-1 guard is present in
`buildGuardInventory()` and hosted on an unfiltered CI path. The inventory
discovers guard artifacts through exactly three channels:

1. `scripts/enforcer-wiring-manifest.json` — `scripts/check-*|lint-*` primaries;
2. the `**Files:**` entries of `docs/specs/2026-08-06-internal-mechanics-overhaul.md`;
3. `servers/exarchos-mcp/scripts/`.

A census that moves to `tools/conformance/src/` is visible to **none** of them.
Channel 2 is a dated record of shipped work and must not be rewritten to point at
today's tree; channel 1 is scoped to shell/mjs primaries; channel 3 is a single
directory. So after the move, G2, G3 and G5 fall out of the inventory entirely and
their exit proof fails — not because the guards stopped working, but because
nothing can find them.

Closing that gap means giving guard discovery a fourth channel, or a
relocation-aware resolution step, and re-baselining `guard-inventory.test.ts`
(which itself names `.../architecture/output-schema-census.ts`). That is a change
to how the repository knows what its guards ARE — squarely
**task 042 ("Retarget the audit configs and assert glob liveness")**, not a
side effect of an extraction.

Completing the move ahead of that would leave three Wave-1 exit guards
undiscoverable, which is strictly worse than not moving: the same
"honest-partial beats complete-but-blind" rule this task already applies to its
module set, applied one level up.

### What is owed to finish it

1. Task 042's guard-discovery channel for `tools/conformance/`.
2. Re-run `node tools/audit/move-conformance.mjs --apply`.
3. Re-apply the repairs listed above (they are mechanical and enumerated).
4. A `conformance` project in the root `vitest.config.ts` — the moved tests match
   no existing project glob, and a test that matches no project passes by never
   executing.
5. Re-point `desc:budget-guard` at the moved CLI.

## Acceptance condition

Identical census verdicts before and after. The 39 co-located test files already
encode those verdicts — they are the characterization, so the acceptance check
is that the architecture suite stays green across the move rather than a
separately captured verdict dump.

Baseline at extraction time: **39 test files, 499 tests, all passing.**
