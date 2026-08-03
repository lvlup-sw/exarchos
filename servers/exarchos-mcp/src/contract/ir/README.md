# Shared admission IR (`src/contract/ir/`)

**Work package:** P03-06 — *Extend and consume shared admission IR*
**Program:** PROGRAM-03 (structural closure remediation) · Source coverage: `API-007` · transition tasks 002, 004–006, 033, 047.

This directory is the **shared, cross-product admission IR wire model** — the
surface that `Strategos.Contracts` / `WorkflowDefinitionV1` conceptually own:
admission-policy definitions and references, the **closed edge-condition node
set**, evidence-requirement models, waiver + approval wire models, and **action
references**. It is data-only: it carries no shell command, arbitrary closure,
harness-specific syntax, or Exarchos implementation binding.

## No TypeSpec toolchain — authored Zod is the single source

The program design names `Strategos.Contracts` **TypeSpec** as the generative
source of the shared IR. **There is no TypeSpec compiler in this offline
environment** — no `.tsp` files, no `@typespec/*` packages resolve, and the npm
registry is unreachable so one cannot be added. Rather than fake a TypeSpec
build, the IR is authored **once** as Zod schemas in [`admission-ir.ts`](./admission-ir.ts),
and the portable JSON Schema artifact is **derived** from it deterministically.

```
                    ┌──────────────────────────────────────────────┐
                    │  admission-ir.ts   (SINGLE authored source)   │
                    │  Zod schemas  =  Exarchos runtime validators  │
                    └───────────────┬─────────────────┬────────────┘
     derive (zodToJsonSchema)       │                 │  parse()  (consume)
                    ┌───────────────▼───────┐   ┌─────▼───────────────────┐
                    │ generated/             │   │ Exarchos runtime (Zod)  │
                    │ admission-ir.schema.json│  │ validators              │
                    │ (checked-in artifact)  │   └─────────────────────────┘
                    └───────────────┬───────┘
                                    │  round-trip harness (roundtrip.test.ts)
                            ┌───────▼────────┐
                            │ Ajv 2020 (2nd  │  ← independent JSON-Schema validator
                            │ validator)     │     proves the two sides agree
                            └────────────────┘
```

If a TypeSpec toolchain is ever vendored, this Zod source becomes the thing the
`.tsp` generates *into* (or is generated *from*); the JSON Schema artifact and
the round-trip harness remain the contract either way.

## Files

| File | Role |
| --- | --- |
| [`admission-ir.ts`](./admission-ir.ts) | The single authored Zod source. Wire model + `parseAdmissionIrDocument` (the runtime validator half) + `admissionIrJsonSchema()`. |
| [`admission-ir-schema.ts`](./admission-ir-schema.ts) | Deterministic serialization (`canonicalJson` + trailing newline) and the on-disk artifact path. |
| [`admission-ir-schema-cli.ts`](./admission-ir-schema-cli.ts) | Regeneration CLI. Writes the artifact **only** when invoked directly. |
| [`generated/admission-ir.schema.json`](./generated/admission-ir.schema.json) | The checked-in JSON Schema artifact (canonical JSON, byte-stable). |
| [`references.ts`](./references.ts) | Dangling-reference resolver (exit-proof half 2). Resolves action refs against the real P03-04 ActionId source. |
| [`builder.ts`](./builder.ts) | Builder lowering to the shared IR (transition tasks 033/047) + `validateAdmissionIrDocument` consumer entry point. |
| [`index.ts`](./index.ts) | Public aggregation surface. |
| `*-fixtures.ts`, `*.test.ts` | Shared round-trip corpus + exit-proof tests. |

## Closed by construction

Every object in the authored source is `.strict()` and every leaf is a scalar, a
closed enum, a stable-id string, or the closed 7-node edge-condition union. There
is **no** `z.any()`, `z.unknown()`, `z.function()`, or open-value field anywhere.
Consequences, each pinned by a test:

- An `expression` / `command` / `script` / `exec` / `handler` escape-hatch key is
  rejected as an unknown property (strict objects).
- An edge-condition node whose `kind` is outside the closed set
  (`eventObserved`, `factPresent`, `factEquals`, `counterCompare`, `all`, `any`,
  `not`) is rejected by the closed union — the shared expression of the runtime
  closed AST in `workflow/admission/edge-condition.ts` (P06-02).
- A `factEquals` value that is a non-scalar object (a smuggled closure/descriptor)
  is rejected.

The IR carries **references** (stable string ids), never bindings. Resolving a
reference to a real Exarchos action/handler is the consumer's job; the wire never
carries the binding itself.

## The two exit-proof halves

1. **Round-trip** — [`roundtrip.test.ts`](./roundtrip.test.ts) runs every entry
   of the shared corpus ([`admission-ir-fixtures.ts`](./admission-ir-fixtures.ts))
   through **both** the generated JSON Schema (compiled by Ajv 2020) **and** the
   authored Zod validators, and asserts they agree accept/reject on every fixture
   — neither side may accept what the other rejects. Edge conditions get a
   *three-way* agreement check that also runs the real runtime
   `compileEdgeCondition`. The id/enum vocabularies are asserted equal to the
   runtime `StableId` / `EvidenceSubjectV1` / `AdmissionRequirementV1` /
   `WaiverScopeV1` / `EDGE_CONDITION_NODE_KINDS` surfaces, so runtime drift trips
   a test.
2. **Reject dangling references** — [`references.ts`](./references.ts) resolves
   policy refs (`edge.admits`), requirement refs (`policy.requires`,
   `waiver.waives`, `corroboration.sourceRequirementId`), and action refs
   (`edge.effect.actionRef`, `policy.onDeny`). Action refs resolve against the
   **live P03-04 ActionId source** (`deriveRegistrationFromRegistry` +
   `registrationActionRefs`). [`references.test.ts`](./references.test.ts) proves a
   dangling policy / action / requirement reference (and duplicate definition ids)
   fail.

## Determinism / drift discipline

The JSON Schema artifact is serialized with the same discipline as P03-03's
proof-fixture baseline: canonical, recursively key-sorted JSON with a trailing
newline, so it is byte-identical across repeated generation and across a CRLF
working tree vs. an LF checkout. The drift guard in
[`admission-ir-schema.test.ts`](./admission-ir-schema.test.ts) fails if the
checked-in artifact diverges from a fresh generation. To regenerate after an
intentional change to the authored source:

```
# from servers/exarchos-mcp
npx tsx src/contract/ir/admission-ir-schema-cli.ts
```

then review the diff and commit the regenerated artifact.

## The P07-03 seam

This package owns **lowering to the shared IR** and stops at the validated
`AdmissionIrDocumentV1` value returned by `AdmissionIrBuilder.lower()`. The later
package **P07-03 "Builder lowering and decision parity"** owns comparing
**compiled decisions**: it takes this shared IR, runs it through the runtime
admission evaluator (`policy-evaluation.ts` et al.), and asserts the decision
matches a reference. The clean seam is exactly that document value:

- everything **up to** the validated wire document is P03-06 (here);
- everything **downstream** (decision compilation + parity) is P07-03.

The builder therefore deliberately performs **no** decision evaluation and holds
no runtime state — it is pure lowering.
