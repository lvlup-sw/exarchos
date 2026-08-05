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
  action's real declared `outputSchema`. The declaration itself is derived from
  the **real action registry** (`registryRequiredRoles` / `registryDeclaredEffects`
  off `ToolAction.roles` and `ActionAnnotations`) — never a fixture literal.
- **Real handlers** (`fixtures.ts` `realHandlerSubjects`): the SHIPPED handler,
  resolved through the real implementation-binding table (`buildBindingTable`),
  is what the oracle invokes. Admission is declaration-based (`readOnly`,
  `!openWorld`, a real binding, an input schema that accepts the probe); every
  action not probed is reported in `notProbed` with its reason, so a shrinking
  probe set is visible rather than inferred from a still-green run.

## `not-observed` is not `pass` (DR-24)

Every axis reports one of three outcomes — `pass`, `fail`, or **`not-observed`**.
Before DR-24 the live subjects carried hard-coded `requiredRoles: []` /
`declaredEffects: []`, which made the authorization, effect and compatibility
axes structurally incapable of reporting anything about the shipped system — and
the run still read green, because an axis that was never exercised reported
`pass`. "We did not look" is now a distinct, **non-passing** outcome:

- `missing-authorization` is **differential**: `pass` requires the handler to
  SERVE an authorized caller *and* REFUSE an unauthorized one. An empty or
  open-marker (`ROLE_ANY`) role set, a subject with no `AuthorizationSurface`,
  or a handler that refuses *everyone* all yield `not-observed`.
- `undeclared-effect` yields `not-observed` when no effect evidence exists at
  all (no recorder entry and no static scan) — an empty recorder cannot
  distinguish "performed nothing" from "was never instrumented".
- `incorrect-handler` yields `not-observed` when the authorized probe was
  declined (a refusal is not the action's behavior).

`axisCoverage(reports)` publishes the per-axis census (`observed` / `pass` /
`fail` / `notObserved`) so residual vacuity is legible instead of hiding behind
an `ok` flag.

### The authorization surface

`OracleSubject.authorizationSurface` names *how* a principal can be withheld:
`observation-context` (the handler reads `ctx.caller`) or `dispatch-authority`
(an adapter projects the caller onto the real dispatch caller-authorization
scope before invoking the real handler). Omitting it is not a way to buy a
`pass` — it buys `not-observed`, which is not a passing outcome.

### The volatility mask is auditable

Real handlers stamp per-call bookkeeping (`_perf`, `data.generatedAt`,
`data.session.start`) that would otherwise read as an idempotency divergence.
`OracleSubject.volatileCarriers` excludes those paths from the **idempotency
comparison only** — never from schema validation or the compatibility shape
comparison — and each carrier declares its `VolatileCarrierKind`
(`measurement-block` | `generation-timestamp`). The oracle honors a mask only
when the *observed* values actually hold that shape; a present-but-wrong-shaped
carrier has its mask **refused**, stays in the comparison, and is named in the
diagnostic. A mask therefore cannot be widened to swallow a real behavioral
divergence.

## Convention

`oracle-seam.ts` is a **test-invoked source-lint gate** (the `-seam.ts`
convention auto-classifies it as such): its co-located `oracle-seam.test.ts`
runs the oracle against the real registry and the seeded-break fixtures. It is
not a production import target. `fixtures.ts` is a test-fixtures module.
