# `src/` — the shipped product

Everything that runs on a user's machine. If it is not in the published
package, it does not belong here.

The tree expresses the published layer architecture: storage, the event store,
projections, workflow primitives, the contract and dispatch core, the verb
surface, lifecycle windows, adapters, and the cooperative-agent runtime.
`tools/audit/layer-map.json` maps every directory here onto that architecture,
and `tests/architecture/layer-map.test.ts` reads the live tree rather than the
map, so a directory the map cannot see fails the build.

## What belongs here

- Product code that ships.
- Declarations the product is derived from — the tool registry, the event
  schemas, the invariant catalog loader.

## What does not

- **Tests.** They all live in `tests/`. A test beside its subject is rejected
  by `tests/architecture/test-tree-contract.test.ts`.
- **Repo automation.** Gates, build scripts and the conformance suite live in
  `tools/`. The distinction is whether it ships, not whether it is TypeScript.
- **Generated files.** Anything rendered from `content/` belongs in
  `rendered/`. The two generated files that do live here — the embedded runtime
  table and the agent specs — are emitted by `npm run codegen:runtimes` and
  `npm run generate:agents`, and each carries a header saying so.

## Two rules worth knowing before editing

**Direction.** Layers may only import what their allowance declares, and the
allowances are the exact measured surface — so adding a cross-layer import
fails, and removing the last one of a kind also fails. See
`src/architecture/layer-boundaries-seam.ts`; the rule is a two-way ratchet on
purpose, because an allowance nothing exercises is cover for a dependency that
no longer exists.

**Breadth.** No directory holds more than 25 non-test files at its own level.
`orchestrate/` once held 83, and no single commit that built it looked wrong.
Exemptions exist, but each names a reason and pins the count it was granted at.
