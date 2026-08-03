# Independent contract-vs-behavior oracle (P03-09)

**Tail of the PROGRAM-03 chain.** Every other package in the chain is a
*generation* pipeline: the compiler (P03-03) derives a meta-model from the live
`TOOL_REGISTRY` and emits descriptors + a checked-in proof-fixture baseline; the
binding generator (P03-04) projects the registration manifest; the CLI generator
(P03-05) projects a client. Their drift guards check the *generated files agree*.

> Exit proof: *seeded incorrect handlers, missing authorization, undeclared
> effects, malformed outputs, and compatibility breaks are caught **even when
> generated files agree**.*

## The blind spot this closes

Every generation layer, and every drift guard that polices it, is a **pure
function of the declared contract** — it compares one declaration against another
declaration derived from the *same* declaration. So if the meta-model itself is
wrong, or a handler quietly does something its contract never declared, **every
generated artifact agrees with every other generated artifact and the system is
self-consistently wrong**. Declaration-to-declaration checks cannot see it.

## How the oracle is independent of the generation pipeline

1. **Different expectation route.** It never calls `deriveMetaModel()` /
   `compile()` and never reads `compiler/generated/proof-fixtures.json`. It reads
   the declared contract (`ContractDeclaration`) directly and derives per-axis
   expectations from it and from the frozen P03-02 contract-surface primitives
   (`error-families`, `envelope`, `compatibility`).
2. **A different information source: OBSERVED BEHAVIOR.** Its decisive signal is
   not another declaration — it invokes the handler against a probe, watches the
   effects it actually performs (a runtime effect recorder), probes it with an
   unauthorized caller, validates the value it actually returns against the
   declared output schema, and compares the output shape it actually emits
   against a recorded prior-version observation.

The independence is **proven, not asserted**. A seeded break leaves the
declaration byte-identical (only the handler misbehaves), so
`deriveGeneratedDescriptor()` — a faithful model of the generation route reusing
the same `zodToJsonSchema` / `canonicalJson` / `digestText` building blocks the
real compiler uses — emits a **byte-identical** artifact for the broken and the
correct subject. No generation/drift check can tell them apart; the oracle tells
them apart by observing behavior. That is exit proof **(g)**.

## The five detection axes

| Axis | Break class | Independent runtime signal |
| --- | --- | --- |
| `incorrect-handler` | handler contradicts its declared contract | declared idempotent, but two identical-input invocations diverge (or it throws on a valid probe) |
| `missing-authorization` | a declared capability requirement not enforced | an unauthorized caller (no roles) is served instead of refused |
| `undeclared-effect` | an effect the contract doesn't declare | the effect recorder observes a performed effect ∉ declared set (static import scan is a complementary cross-check) |
| `malformed-output` | output violates the declared schema | the returned value fails `outputSchema.safeParse` |
| `compatibility-break` | change violates the declared compatibility policy | the output drops a prior-version field (breaking) while `classifyVersionChange` says the version transition is not breaking |

## Public API (`oracle-seam.ts`)

```ts
runOracle(subject, opts?): Promise<OracleReport>           // one subject, all/selected axes
runOracleSuite(subjects, opts?): Promise<OracleSuiteReport>
observeBehavior(subject): Promise<Observation>             // pure observation
checkIncorrectHandler / checkMissingAuthorization / checkUndeclaredEffect /
  checkMalformedOutput(decl, obs): AxisVerdict
checkCompatibilityBreak(subject, obs): AxisVerdict
guardRoles(ctx, requiredRoles)                             // the sanctioned refusal helper
// generation-consistency foil (the independence proof):
deriveGeneratedDescriptor(decl) / serializeGeneratedDescriptor / checkGenerationConsistency(decl)
```

## Observed at runtime vs. statically inferred

- **Seeded synthetic subjects** (`fixtures.ts` `seededBreak`): **all five axes
  are fully runtime-observed** — the handler is actually invoked (authorized,
  repeated, and unauthorized), effects are actually recorded, outputs are
  actually validated, and the output shape is actually compared against a
  recorded prior-version observation.
- **Live registry** (`fixtures.ts` `liveOutputSubjects` /
  `liveSuccessOutputSubjects`): the **output axis** is observed against the real
  runtime envelope (`format.ts` `wrapError` / `wrap`) validated against every
  action's real declared `outputSchema`. The authorization / effect /
  compatibility axes are reported `not-observed` on the live system: full runtime
  probing there requires invoking real mutating handlers against the real
  capability + effect substrate, and a *declaration-only* proxy would produce
  false positives (authorization is enforced across roles + capability gates +
  posture, so 15 write actions are legitimately role-open, gated elsewhere).

## Convention

`oracle-seam.ts` is a **test-invoked source-lint gate** (the `-seam.ts`
convention auto-classifies it as such): its co-located `oracle-seam.test.ts`
runs the oracle against the real registry and the seeded-break fixtures. It is
not a production import target. `fixtures.ts` is a test-fixtures module.
