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

## Why the raw import count overstates the work

The plan estimated "~26 outbound imports into the core it inspects". The live
count is **29 outbound module edges** — but only **21 are value imports**. The
other 8 are `import type`, which erases at compile time and cannot create a
package cycle at all.

Partitioned by extraction cost, the 35 non-test modules are:

| Bucket | Count | Meaning |
| --- | ---: | --- |
| **Clean** | 20 | No outbound edge into `src/`. Moves as-is. |
| **Type-only** | 4 | Outbound edges all erase at compile time. Moves as-is. |
| **Value** | 11 | Imports a runtime value from the subject. Needs inversion. |

**24 of 35 modules (69%) move without any inversion at all.** The extraction is
therefore not blocked in the way the raw count implies; it is blocked on eleven
named modules.

### Clean — no outbound edge (20)

`__fixtures__/swallows.fixture.ts`, `adapter-ownership-seam.ts`,
`audit-delivery-closure.data.ts`, `audit-prompt.ts`, `catalog-merge.ts`,
`delivery-safety.ts`, `description-budget-cli.ts`, `effect-ledger.ts`,
`effect-port-seam.ts`, `event-grammar-concessions.ts`, `glob-to-regexp.ts`,
`import-cycles.ts`, `invariant-schema.ts`, `layer-boundaries-seam.ts`,
`project-catalog.ts`, `report-coupling-seed-pin.ts`, `report-coupling-seed.ts`,
`sdlc-catalog.ts`, `vcs-ownership.ts`, `vocabulary-lint-cli.ts`

### Type-only — erases at compile time (4)

`authority-census.ts`, `catalog-sources.ts`, `check-evaluator.ts`,
`sdk-generation-seam.ts`

### Value — needs inversion (11)

Each row is a census module, the subject it reaches into, and the shape the
inversion takes. The pattern throughout is the spec's: the census **takes its
input as a parameter** — a source root, a lexer port, a rule table — instead of
importing the subject.

| Module | Subject | Inversion |
| --- | --- | --- |
| `vocabulary-lint.ts` | `config/artifacts` (`DEFAULT_SPEC_DIR`, `DEFAULT_LEGACY_DESIGN_DIR`) | Two directory strings become parameters. Cheapest edge in the set. |
| `authority-topology.ts` | `contract/declaration` (`DECLARATION_KINDS`) | Accept the kinds table as a rule-table parameter. |
| `description-budget.ts` | `registry` (`TOOL_REGISTRY`, `buildToolDescription`) | Accept the registry and the description builder. |
| `contract-seam.ts` | `review/check-catalog` | Accept the catalog. |
| `resolve-effective-catalog.ts` | `config/exarchos-config-schema` | Accept the parsed config schema. |
| `invariants-loader.ts` | `config/exarchos-config-schema`, `config/yaml-schema` | Accept both schemas. |
| `audit-delivery-closure.ts` | `registry`, `verbs/worktree/schemas` (`extractEnvelopeDataSchema`) | Accept the registry and the extractor as a port. |
| `event-grammar-census.ts` | `events/schemas`, `events/event-name` (`classifyEventName`) | `classifyEventName` is pure and grammar-owned; prefer relocating it into the package over threading it. |
| `report-coupling-census.ts` | `events/schemas`, `events/event-annotations`, `events/event-registration` | Accept the annotation table and the emission-source resolver. |
| `output-schema-census.ts` | `registry`, `verbs/worktree/schemas`, `contract/schemas/schema-totality`, `output-schema-vacuity-allowlist`, `output-schema-seed-pin` | Heaviest module in the set — five subjects. The two `output-schema-*` files are conformance data and should migrate WITH it rather than be threaded. |
| `__fixtures__/declaration-seam-violator.fixture.ts` | `contract/declaration`, `events/schemas` | **Stated exception candidate.** This fixture exists to BE a seam violation; its imports are the thing under test, so inverting them would destroy the fixture's purpose. Expected to stay in `src/`. |

## Acceptance condition

Identical census verdicts before and after. The 39 co-located test files already
encode those verdicts — they are the characterization, so the acceptance check
is that the architecture suite stays green across the move rather than a
separately captured verdict dump.

## Status

Measured and partitioned; the extraction itself is not yet applied. The
inversion work is eleven modules, of which one (`declaration-seam-violator`) is
expected to end as a permanent stated exception.
