---
name: axiom-overlap-machinery-blast
description: axiom_overlap removal touches more than the loader — coverage-closure (DR-8) in vocabulary-lint also consumes axiomOverlap/DIM-*
metadata:
  type: project
---

The `axiom_overlap` / `axiomOverlap` machinery in the invariants catalog spans
**three** production modules, not just the loader:

1. `architecture/invariants-loader.ts` — `axiomOverlap` field on `InvariantEntry`,
   the `axiom_overlap` raw parse path, `AXIOM_OVERLAP_PATTERN`, and the
   referential-integrity block in `loadInvariants`.
2. `architecture/vocabulary-lint.ts` — `scanCoverageClosure` (DR-8) builds a
   `specialized` set from `entry.axiomOverlap` to verify every `DIM-*` is closed
   by an `INV-*`. Plus `CoverageFinding` / `hasCoverageNaMarker` helpers.
3. `architecture/vocabulary-lint-cli.ts` — calls `scanCoverageClosure` and folds
   its findings into the lint's non-zero exit.

Also note: `invariant-schema.ts` declared a **kebab-case** `'axiom-overlap'`
Zod field that the live catalog never populated (catalog uses snake_case
`axiom_overlap`, parsed by the loader's own raw path) — vestigial.

**Why:** When removing `axiomOverlap` from the `InvariantEntry` type (#1477
axiom excision, Task 2), grepping only the loader undercounts the blast radius —
the type removal breaks vocabulary-lint's coverage-closure compile. The
coverage-closure feature is entirely DIM-*/axiom_overlap-driven, so it dies
with the taxonomy (no DIM-* entries → nothing to close).

**How to apply:** For any future "excise a catalog field" task, grep the whole
`servers/exarchos-mcp/src` tree for the typed accessor name (e.g. `axiomOverlap`)
before estimating scope; the catalog has multiple consumers (loader,
vocabulary-lint coverage-closure, the audit-prompt generator). `audit-prompt.ts`
is workload-agnostic and does NOT consume per-field vocabulary, so it survives
field removals unchanged. See [[tdd-gate-blast-radius]] for the related
"per-task scope too narrow for schema/type reshapes" guidance.
