# Invariants v3 — Strategos.Contracts seam

This document is the **contract seam** between the v3 invariant catalog schema
(hand-written Zod in `servers/exarchos-mcp/src/architecture/invariant-schema.ts`)
and the canonical `Strategos.Contracts` TypeSpec models that will eventually
generate these shapes.

## Hand-written now, generated later

Today the v3 schema is authored by hand in Zod. There is **no runtime
dependency on Strategos.Contracts** — Exarchos does not import or call any
Strategos package at runtime, and the build does not run a TypeSpec codegen
step. The mapping below records the *intended* TypeSpec model for each exported
schema so that, in a future milestone, these Zod shapes can be swapped for
generated equivalents without re-deriving the field mapping from scratch.

Two automated checks keep this seam honest:

- **`contract-seam.ts` (`lintSeamComments`)** asserts every exported `*Schema`
  in `invariant-schema.ts` carries a `// contract-shaped: <Model>` comment on
  the line directly above it.
- **`contract-seam-doc.test.ts`** asserts this document enumerates every
  exported top-level v3 schema (the test below would fail if a new export were
  added without a row here).

## Mapping

| Exported Zod schema (`invariant-schema.ts`) | `Strategos.Contracts` TypeSpec model | Notes |
| --- | --- | --- |
| `CheckNodeSchema` | `CheckNode` | Recursive combinator tree: leaf (`grep`/`structural`/`heuristic`) plus `all-of` / `any-of` / `not` / `scope` arms. Declarative-only (`.strict()` — no embedded executable, INV-4). |
| `EnforcementSchema` | `Enforcement` | Discriminated union on `mode`: `check` (a `CheckNode`) or `audit` (an `audit-prompt` string). |
| `InvariantEntryV3Schema` | `InvariantEntry` | v3 catalog entry — the v2 `InvariantEntry` fields plus optional v3 affinity / `enforcement` / `severity` / `integrity-class` additions. |

### Field keys are kebab-case

The catalog is YAML frontmatter, so field keys are kebab-case
(`phase-affinity`, `cost-of-load`, `audit-prompt`, `integrity-class`, …). The
TypeSpec models should use the same wire names (via `@encodedName` or
equivalent) so the generated decoder validates the frontmatter verbatim.

## Closing the seam — tracking

The "generated later" half is tracked, cross-repo:

- **lvlup-sw/strategos#98** — adds the `CheckNode` / `Enforcement` /
  `InvariantEntry` TypeSpec models to `Strategos.Contracts` (the producer).
- **#1468** — the Exarchos-side swap: consume the emitted JSON Schema and
  replace the hand-written Zod, keeping the `InvariantEntryV3` type surface
  stable so downstream consumers are unchanged. Blocked on strategos#98.

When #1468 lands, update the "Hand-written now, generated later" section to
reflect generated status (or retire this doc if the seam is fully closed).
