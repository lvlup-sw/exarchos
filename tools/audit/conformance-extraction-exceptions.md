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

## Acceptance condition

Identical census verdicts before and after. The 39 co-located test files already
encode those verdicts — they are the characterization, so the acceptance check
is that the architecture suite stays green across the move rather than a
separately captured verdict dump.

Baseline at extraction time: **39 test files, 499 tests, all passing.**
