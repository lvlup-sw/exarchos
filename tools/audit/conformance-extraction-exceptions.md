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

## Status: LANDED

The move is applied. `tools/conformance/` is a real package of 15 test files /
186 tests; 24 files / 315 tests stay in `servers/exarchos-mcp/src/architecture/`.
The pre-move architecture suite was 39 files / 499 tests, so **file count is
conserved exactly and no test case was dropped** — the two extra tests are the
new conformance-package effect-port proof described below.

Three things were learned in the applying that the plan did not predict. Each is
recorded here rather than in a commit message, because each is a rule for the
next extraction rather than a fact about this one.

### 1. The closure was computed in only one direction, and it was the wrong half

`measure-conformance-movable.mjs` grew the STAYS set upward: *a module stays if
it VALUE-depends on a stayer*. That rule is real — moving such a module would
leave an uninverted runtime edge into the subject, which DR-1 permits only in
`bindings/`.

It is not sufficient. The set must also be closed DOWNWARD: *a module stays if a
stayer depends on it*. Without that half the partition classified
`sdk-generation-seam.ts` movable while `layer-boundaries-seam.ts` — a stayer —
imported three of its **values**. Applying the move produced a `src/` →
`tools/` edge: shipped source importing from a dev-tooling package, the exact
inversion this task exists to avoid. `tsc --rootDir` rejected it.

The downward rule counts **type edges too**, and that distinction is load-bearing
in the other direction from the upward rule. A type-only import erases at
runtime, so it cannot create the DR-1 edge — but it still pulls the target into
the program, so `--rootDir` still fails. `test-helpers/module-specifier-parser.ts`
is the live instance: its import of `sdk-generation-seam`'s types is
`import type`, and it broke the build anyway.

Both fixpoints now run in the script. `sdk-generation-seam.ts` stays.

### 2. Tests co-locate; a sibling `tests/` tree would have un-governed the suite

The first application put tests in `tools/conformance/tests/`. That is a second
convention, and three mechanisms already define a guard as a module with a
**co-located** self-test — `selfTestCandidates`, `resolveHosts`, and the new
guard-suite channel, one of which is DR-24 itself. Under the split layout every
extracted census resolves to no self-test: an unreachable guard, or the same
convention threaded through all three. Tests moved beside their subjects, which
is also the repo-wide rule (CLAUDE.md).

### 3. A census whose subject stayed must stay with it

`contract-seam-doc.test.ts` passes the import-following movability filter because
it reaches `invariant-schema.ts` **by path, not by import**. Its subject is
pinned in `src/`, so it is now an explicit non-member of `MOVING_TESTS` rather
than something the closure can be trusted to catch.

`effect-port-seam.ts`'s curated port table hit the mirror image: two of its five
declared modules moved out of the tree it scans, turning both rules phantom.
Deleting them would have been a silent weakening — both modules still read the
filesystem, and "never grows a process or network port" is no less true for
their having moved. The rules moved to a second table
(`CONFORMANCE_EFFECT_PORTS`) evaluated in a second pass over the second root.

## How it was unblocked (the guard-discovery gap, recorded below)

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

### How it was closed

1. **Channel 4** (`GUARD_SUITE_ROOTS` in `scripts/guard-inventory.ts`). Under a
   declared guard-suite root, a non-test module with a co-located self-test is a
   guard. It fails closed three ways — unreadable root, root yielding zero
   guards, empty root list — because a discovery channel that contributes
   nothing is indistinguishable from one that was never needed. It was landed
   and proven BEFORE the move, over the pre-move tree, so the move retargeted
   one constant instead of introducing an untested mechanism mid-flight.
2. `node tools/audit/move-conformance.mjs --apply`.
3. The enumerated repairs, plus the three findings above that the plan missed.
4. A `conformance` project in the root `vitest.config.ts`, deliberately WITHOUT
   `passWithNoTests` — a glob that matches nothing must fail for the enforcement
   suite above all.
5. `desc:budget-guard` re-pointed at the moved CLI.

### The path-pinned registers the move invalidated

Every one of these was a real gate that would have gone quiet, and none of them
is reachable by following imports. They are listed because the list itself is
the finding — a directory move breaks governance in more places than a compiler
can see.

| Register | What broke | Repair |
| --- | --- | --- |
| `wave1-exit.test.ts` `WAVE1_GUARDS` | G2/G3/G5 pinned by old path | retargeted |
| `guard-inventory.test.ts` | named guards + the `pathFilteredOnly` example | retargeted; the example moved to `layer-boundaries-seam` because the extraction's unfiltered host cleared the old one |
| `effect-port-seam.ts` `NARROW_EFFECT_PORTS` | 2 of 5 rules went phantom | second table + second pass |
| `legacy-shape-debt.ts` | 4 debt entries dangling | retargeted, not deleted |
| `@oracle-sources` (DR-30) | 2 annotations unresolvable | retargeted |
| `knip-allowlist.json` | fixture entry dangling | retargeted |
| `count-casts` `CENSUS_ROOTS` | ~6 casts left the census's jurisdiction | fifth root added |
| `check-module-intent` | `output-schema-seed-pin.ts` became dead-in-prod | moved into the package, as this doc always intended |
| `output-schema-ratchet-guard.test.ts` | 2 path literals | retargeted |
| test-inventory baseline | 15 relocated test files | regenerated after `git add` |

### Two guards were ALREADY dead before the move, and only the retarget found them

Task 042's own subject, met head-on. Neither is a consequence of the extraction;
both were surfaced by going looking.

- **`lint:envelopes` had been matching zero files.** Both its flat-config `files`
  key and `scripts/lint-envelopes.mjs`'s default target named
  `servers/exarchos-mcp/src/orchestrate/**`, a directory task 015 renamed to
  `verbs/`. The gate has been failing closed (eslint exit 2) rather than passing
  green — the fail-closed design working — but the config was stale and the lint
  was running over nothing. Retargeted: **122 source files, 0 findings.**
- **knip could not see `tools/conformance/`.** Its root workspace `project`
  covers `src`, `scripts` and `test`, so dead code in the extracted package would
  have gone unreported forever. The gate reported this ITSELF, as a
  `stale-entry` warning against the retargeted `swallows.fixture.ts` allowlist
  row — an entry pointing at a file knip no longer scanned. Scope widened;
  the warning cleared.

The ESLint scope widening folded in from the comment-hygiene spec took BOTH
gates, as that spec insists: the flat-config `files` key *and* the `lint`
script's CLI glob, which bounds the run regardless of what the config admits.
The required pre-widening findings baseline over the newly-linted directory is
**zero**, measured rather than assumed.

Four CI steps in the unfiltered `grep-gates` job named these tests by path.
Rather than splitting each, the conformance half collapsed into ONE step that
runs the whole package (`npm run test:conformance`). The reason is the
two-surface subset rule, not brevity: `tools/conformance/**` matches no
`dorny/paths-filter` key, so the package's only other host (`test-root`, filtered
on `root`) is armed by no PR that edits it — #1711's skipped-as-passed aimed at
the enforcement suite itself. Widening `root` was rejected for the reason already
recorded in `GUARD_EXEMPTIONS`: that key also arms `test-windows-root`, the lane
#1699 has never proven green.

## Acceptance condition

Identical census verdicts before and after. The 39 co-located test files already
encode those verdicts — they are the characterization, so the acceptance check
is that the architecture suite stays green across the move rather than a
separately captured verdict dump.

Baseline at extraction time: **39 test files, 499 tests, all passing.**
