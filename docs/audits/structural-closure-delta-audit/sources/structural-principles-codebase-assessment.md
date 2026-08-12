# Structural principles codebase assessment

**Date:** 2026-07-21

**Repository:** `lvlup-sw/exarchos`

**Branch assessed:** `feature/phase-gate-v212-proof-substrate`

**Reference standard:** [`agent-principles.md`](../../agent-principles.md)

**Status:** Current-state architecture and enforcement assessment

## Executive summary

Exarchos already applies the seven structural principles in meaningful ways. The codebase is not starting from a convention-driven architecture. It has generated artifacts, strict TypeScript, runtime schemas, algebraic domain models, pure reducers, state machines, explicit registries, risk-tiered verification, event-sourced evidence, and a substantial collection of mechanical ratchets.

The implementation is incomplete in a consistent direction: strong local controls exist, but they do not yet compose into one closed proof system.

The largest gaps are:

1. public boundary contracts are still handwritten rather than generated from an IDL;
2. shared TypeScript result types still permit invalid success and failure combinations;
3. integration completeness is checked through several targeted guards rather than one complete ship-surface graph;
4. test code is excluded from TypeScript compilation;
5. the new proof substrate remains in audit and shadow posture;
6. several recurrent-defect controls remain advisory or model-audited.

The strongest principles today are:

- Principle 2: algebraic behavior and explicit effects;
- Principle 5: assigning claims to cheaper proof layers;
- Principle 7: converting discoveries into ratchets.

The weakest are:

- Principle 1: generated boundary contracts;
- Principle 4: integration completeness as a graph property;
- Principle 6: proof-carrying changes, although the current branch materially advances it.

## Assessment method

The assessment reviewed:

- build and code-generation scripts;
- root and MCP TypeScript configurations;
- runtime schemas and shared result carriers;
- workflow state machines and property tests;
- projection purity checks;
- dependency and composition-root checks;
- tool, view, projection, event, and gate registries;
- verification policy and routing;
- mutation and seeded-defect evaluation;
- evidence subject and admission proof contracts;
- invariant enforcement modes;
- CI wiring and advisory controls.

### Maturity scale

| Score | Meaning |
|---:|---|
| 0 | Absent |
| 1 | Isolated examples; convention remains primary |
| 2 | Partial structure; important paths remain manual or bypassable |
| 3 | Systematic structure with known enforcement gaps |
| 4 | Generated or mechanically enforced across all relevant paths |

The score is ordinal. It is intended to identify the next structural investment, not to provide a percentage quality grade.

## Summary assessment

| Principle | Score | Current state |
|---|---:|---|
| 1. Generate every boundary from one contract | 2 | Runtime schemas and generated artifacts exist, but no IDL drives public contracts |
| 2. Make domain behavior algebraic and effects explicit | 3 | Strong domain modeling and pure folds; shared carriers and some effect paths remain ambiguous |
| 3. Modularize around independently provable units | 2 | Clear pure and adapter seams in places; module contracts and ownership are not universal |
| 4. Make integration completeness a graph property | 2 | Several strong registries and wiring guards; no unified ship-surface graph |
| 5. Assign every claim to the cheapest sound proof | 3 | Verification ladder and diverse proof methods exist; important lanes remain excluded or advisory |
| 6. Make every change proof-carrying and bounded | 2 | Typed proof substrate exists on the current branch; enforcement and universal adoption are deferred |
| 7. Convert verification discoveries into structural ratchets | 3 | Extensive ratchet infrastructure; many invariants remain audits or advisories |

**Aggregate:** 17 of 28 maturity points. The architecture is systematic in parts but not closed end to end.

## Principle 1: Generate every boundary from one contract

### Applied

The repository generates several classes of artifact:

- runtime YAML is compiled into embedded TypeScript;
- agents, skills, command aliases, and hooks are generated;
- generated outputs have drift guards;
- every registered action must declare an `outputSchema`;
- shared lifecycle fields are centralized and tested against registration collisions;
- success and failure envelope schemas are runtime-discriminated by `success`.

Evidence:

- `package.json:24-35`
- `servers/exarchos-mcp/src/registry.test.ts:2418-2467`
- `servers/exarchos-mcp/src/registry.construction.test.ts:59-167`
- `servers/exarchos-mcp/src/contract/schemas/envelope.ts:145-176`

These controls prevent several forms of drift. In particular, registry construction rejects incompatible field shapes, and the action registry cannot omit an output schema silently.

### Gaps

There are no TypeSpec files in the assessed source tree. The invariant contract seam explicitly describes current Zod schemas as handwritten stand-ins for future `Strategos.Contracts` TypeSpec models:

- `servers/exarchos-mcp/src/architecture/contract-seam.ts:4-12`
- `servers/exarchos-mcp/src/architecture/invariant-schema.ts:14-22`

The same boundary is commonly represented in:

- a TypeScript interface;
- a Zod schema;
- handler construction code;
- registry metadata;
- CLI rendering;
- documentation.

The repository tests these representations for consistency, but it still pays the maintenance cost of multiple editable sources. `format.ts` and `contract/schemas/envelope.ts`, for example, describe matching result surfaces independently.

Not every action's success payload is strongly specific. The registry requires an output schema, but some schemas remain permissive or use generic records and unknown values.

### Assessment

**Score: 2.**

The repository has strong generation discipline for repository content and strong runtime schema discipline for tool surfaces. It has not yet reached the principle's central target: one versioned IDL generating static types, runtime validation, client and server interfaces, errors, fixtures, compatibility metadata, and documentation.

## Principle 2: Make domain behavior algebraic and effects explicit

### Applied

This is one of the strongest areas.

Examples include:

- workflow state is a discriminated union of atomic, compound, and final states;
- atomic states require a phase kind at compile time;
- admission IDs are branded and constructed through Zod parsing;
- evidence subjects are discriminated unions over workflow, phase attempt, wave, task, commit, diff, and artifact subjects;
- evidence verdicts distinguish pass, fail, and indeterminate;
- gate-provider resolution uses discriminated success and failure results;
- atomic append results distinguish committed, cache-hit, and typed failure reasons;
- workflow transitions have property tests for determinism and invalid-target rejection;
- reducers are tested against deep-frozen input to prevent mutation;
- verification policy resolution is pure and returns frozen data.

Evidence:

- `servers/exarchos-mcp/src/workflow/state-machine.ts:27-39`
- `servers/exarchos-mcp/src/workflow/state-machine.property.test.ts:118-183`
- `servers/exarchos-mcp/src/workflow/admission/types.ts:29-182`
- `servers/exarchos-mcp/src/workflow/admission/types.ts:288-324`
- `servers/exarchos-mcp/src/verbs/gates/gate-provider-registry.ts:50-78`
- `servers/exarchos-mcp/src/event-store/atomic-appender.ts:66-115`
- `servers/exarchos-mcp/src/projections/immutability.test.ts:1-40`
- `servers/exarchos-mcp/src/workflow/verification-policy-resolver.ts:63-88`

### Gaps

The shared static result carriers lag behind the stronger runtime schemas.

`ToolResult` is represented as:

- `success: boolean`;
- optional `data`;
- optional `error`;
- several optional side channels.

`TransitionResult` similarly combines:

- `success: boolean`;
- optional new phase;
- optional error fields;
- optional guard remediation;
- optional resolved gates.

Evidence:

- `servers/exarchos-mcp/src/format.ts:66-103`
- `servers/exarchos-mcp/src/workflow/state-machine.ts:81-105`

These shapes allow invalid static combinations such as success with an error, failure without an error, or success without required data. The runtime `EnvelopeSchema` is stricter than the TypeScript carrier it is intended to represent.

Policy skips also use success-shaped carriers. A skipped gate returns `success: true`, often with `data.passed: true` and a secondary discriminant. This makes skip semantics dependent on caller discipline:

- `servers/exarchos-mcp/src/verbs/verification-ladder-routing.test.ts:100-172`

One shared helper catches and discards gate-event persistence errors:

- `servers/exarchos-mcp/src/verbs/pure/gate-preflight.ts:143-189`

That behavior conflicts with explicit effects and durable proof for enforceable gates.

### Assessment

**Score: 3.**

The domain core uses functional and algebraic techniques well. The main deficiency is at shared carrier and orchestration boundaries, where boolean-plus-optional shapes and fire-and-forget effects preserve invalid or ambiguous states.

## Principle 3: Modularize around independently provable units

### Applied

The codebase has several deliberate module seams:

- `orchestrate/pure/` isolates deterministic decision logic;
- workflow verification policy is separated from config resolution and I/O;
- event projections use reducer interfaces;
- storage backends have shared contract tests;
- Dependency Cruiser prevents event-store and workflow domain code from importing transport adapters;
- runtime import cycles are detected with graph analysis;
- the state-store and projection back-edge has a dedicated regression assertion.

Evidence:

- `servers/exarchos-mcp/src/verbs/pure/`
- `servers/exarchos-mcp/src/storage/__tests__/backend-contract.test.ts`
- `.dependency-cruiser.cjs:55-67`
- `servers/exarchos-mcp/src/architecture/import-cycles.test.ts:15-28`
- `servers/exarchos-mcp/src/architecture/import-cycles.test.ts:121-147`

The event-store composition-root guard also prevents production modules from constructing independent stores outside approved roots:

- `scripts/check-event-store-composition-root.mjs`

### Gaps

The architecture rules cover selected seams rather than the whole module graph.

The Dependency Cruiser configuration has one domain-to-adapter rule. It does not yet express:

- ownership of every mutable state surface;
- allowed dependencies for each major module;
- forbidden internal imports across every module boundary;
- public contracts and effect ports for every module;
- replacement conformance for every adapter family.

Runtime cycles may be baselined. The import-cycle acceptance test also skips when Dependency Cruiser is unavailable:

- `servers/exarchos-mcp/src/architecture/import-cycles.test.ts:95-147`

Many handlers still receive broad contexts such as `DispatchContext` or `EventStore` directly rather than minimal effect ports. This makes the true effect surface wider than the module's public input type suggests.

### Assessment

**Score: 2.**

The repository contains strong examples of provable modules and dependency direction. The approach is not yet a repository-wide module contract system.

## Principle 4: Make integration completeness a graph property

### Applied

Exarchos uses explicit registries for:

- tools and actions;
- views;
- projections;
- events;
- review checks;
- lifecycle operations;
- gate providers;
- reserved event append ownership.

The gate-provider registry uses:

```ts
satisfies Record<SupportedGateClass, ...>
```

Adding a supported mechanical gate class without one provider becomes a compile-time error:

- `servers/exarchos-mcp/src/verbs/gates/gate-provider-registry.ts:80-106`

Registry tests require every action to carry an output schema and action annotations:

- `servers/exarchos-mcp/src/registry.test.ts:2418-2467`

The repository also has targeted reachability and ownership checks:

- event-store construction is restricted to approved composition roots;
- enforcement scripts are mapped to CI workflows;
- the enforcer-wiring gate detects orphaned scripts, unreachable npm chains, swallowed exit codes, and diff-dependent gates without synchronization;
- module-intent checks identify dead-in-production modules.

Evidence:

- `scripts/check-event-store-composition-root.mjs`
- `scripts/enforcer-wiring-manifest.json`
- `.github/workflows/ci.yml:762-782`

### Gaps

There is no single machine-readable ship-surface manifest covering every capability:

```text
public root -> schema -> route -> handler -> domain port -> adapter -> effect
```

Current checks prove selected edges:

- action registration;
- output schema presence;
- gate provider cardinality;
- event-store construction ownership;
- enforcement-script CI reachability.

They do not establish full reachability for every public capability.

The current phase-gate specification requires a canonical gate runner and a repository census that rejects direct gate emitters:

- `docs/specs/2026-07-21-phase-gate-v212-proof-substrate.md:74-82`
- `docs/specs/2026-07-21-phase-gate-v212-proof-substrate.md:123-132`

The gate-provider registry exists, but the planned canonical gate runner and `scripts/check-gate-runner-ownership.mjs` are not present in the assessed tree.

### Assessment

**Score: 2.**

Integration is more explicit than in a typical TypeScript service, but closure remains fragmented across registries and specialized checks. The codebase cannot yet answer, from one graph, whether every declared public capability is reachable in the shipped artifact.

## Principle 5: Assign every claim to the cheapest sound proof

### Applied

Exarchos has a formal verification ladder.

The base sequence is a pure mapping from:

- risk tier;
- whether the task touches a boundary.

Higher tiers add test adequacy and integration checks. Boundary-touching work adds contract-drift and mock-boundary checks:

- `servers/exarchos-mcp/src/workflow/verification-policy.ts:27-94`

Project configuration is composed through one pure resolver:

- `servers/exarchos-mcp/src/workflow/verification-policy-resolver.ts:1-88`

Routing tests dispatch through the real composite router rather than testing handlers only:

- `servers/exarchos-mcp/src/verbs/verification-ladder-routing.test.ts`

The test substrate includes:

- unit, integration, process, and outcome projects;
- state-machine property tests;
- reducer immutability tests;
- mutation analysis;
- contract-drift checks;
- mock-boundary checks;
- seeded defect and matched-control corpora;
- hidden oracles for known ungated behavior classes.

Evidence:

- `package.json:38-46`
- `servers/exarchos-mcp/src/verbs/gates/mutation-adequacy.ts`
- `servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/corpus.ts`

### Gaps

Both TypeScript configurations exclude test files:

- `tsconfig.json:18-20`
- `servers/exarchos-mcp/tsconfig.json:19-27`

The compiler therefore cannot prove that test code is type-correct. This moves a compiler-suitable claim into runtime test execution or leaves it unproved.

The default `test:run` command runs unit and integration projects, but excludes process and outcome projects:

- `package.json:40-45`

Several proof layers remain advisory:

- mutation gate runs in observe mode;
- INV-6 lint has its exit code swallowed intentionally;
- benchmark regression is non-blocking;
- capability evals are non-blocking.

Evidence:

- `scripts/enforcer-wiring-manifest.json:29-34`
- `scripts/enforcer-wiring-manifest.json:76-80`
- `scripts/enforcer-wiring-manifest.json:149-160`
- `.github/workflows/benchmark-gate.yml:54-56`
- `.github/workflows/eval-gate.yml:101-105`

The verification routing model also represents policy skip as a passing result. That weakens the distinction between a claim proved true and a claim not required by policy.

### Assessment

**Score: 3.**

The repository has a mature vocabulary and implementation for proof selection. It still leaves compiler coverage and several high-value ratchets outside blocking enforcement.

## Principle 6: Make every change proof-carrying and bounded

### Applied

The current branch substantially advances this principle.

The admission proof domain defines:

- branded workflow, phase, wave, task, commit, diff, and artifact IDs;
- immutable content digests;
- subject-bound evidence;
- producer and authorization snapshots;
- policy and content digests;
- pass, fail, and indeterminate verdicts;
- supersession and contradiction semantics;
- typed remediation.

Evidence:

- `servers/exarchos-mcp/src/workflow/admission/types.ts`
- `servers/exarchos-mcp/src/workflow/admission/evidence-subject.ts`
- `servers/exarchos-mcp/src/event-store/schemas.ts:3122-3224`

Evidence subject content is canonicalized before hashing. Invalid JSON values, cycles, sparse arrays, non-finite numbers, unsupported algorithms, and digest mismatch fail explicitly:

- `servers/exarchos-mcp/src/workflow/admission/evidence-subject.ts:64-190`
- `servers/exarchos-mcp/src/workflow/admission/evidence-subject.ts:252-300`

The atomic appender provides:

- SQLite transaction boundaries;
- optimistic concurrency;
- idempotency claims;
- request digest conflict detection;
- injected clocks for deterministic decision closures;
- typed storage and concurrency errors.

Evidence:

- `servers/exarchos-mcp/src/event-store/atomic-appender.ts`

### Gaps

The current specification explicitly limits the proof substrate to audit and shadow posture:

- `docs/specs/2026-07-21-phase-gate-v212-proof-substrate.md:24-40`

It does not yet:

- change transition admission;
- expose a total public admission result;
- evaluate the future policy contract;
- require proof for every transition;
- remove legacy guards;
- bind every gate result through one durable producer.

Strict policy and public admission surfaces are deferred:

- `docs/specs/2026-07-21-phase-gate-v212-proof-substrate.md:140-143`
- `docs/specs/2026-07-21-phase-gate-v212-proof-substrate.md:177-187`

The canonical gate runner and ownership census described in the specification are not present. Existing action results do not universally carry evidence references, and evidence is not yet required before returning success.

### Assessment

**Score: 2.**

The types and storage primitives are strong. The principle is not complete until proof production is universal, durable, bound to the exact subject, and consumed by admission rather than recorded for observation only.

## Principle 7: Convert verification discoveries into structural ratchets

### Applied

Ratchet construction is a clear repository strength.

Examples include:

- a machine-readable architectural invariant catalog;
- generated-drift tests;
- event-store composition-root checks;
- single-fold and upcast choke-point checks;
- type-debt and coverage budgets;
- enforcement-script wiring verification;
- test-first drift lint;
- import-cycle detection with positive controls;
- seeded defects paired with matched controls;
- negative controls proving registry collision checks are live;
- gate catch-rate benchmarking;
- self-tests for check scripts.

Evidence:

- `.exarchos/invariants.md`
- `scripts/enforcer-wiring-manifest.json`
- `servers/exarchos-mcp/src/registry.construction.test.ts:83-167`
- `servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/corpus.ts`
- `.github/workflows/ci.yml:745-782`

The enforcer-wiring manifest is especially aligned with the principle. It records whether each check is gating, advisory, or retired and verifies that CI behavior matches the declaration.

### Gaps

Of invariant catalog entries with explicit enforcement modes:

- 9 use `mode: audit`;
- 4 use `mode: check`.

Audit-mode invariants rely on model judgment rather than deterministic enforcement.

Several known ratchets remain advisory:

- mutation adequacy;
- INV-6 lint;
- benchmark regression;
- capability evals.

Some tests skip when tooling is unavailable, and some unfinished test surfaces remain explicitly skipped. One gate helper treats evidence event emission as fire-and-forget.

These are not all accidental defects. Several are documented staging choices. They remain proof gaps until their exit conditions are satisfied.

### Assessment

**Score: 3.**

Exarchos has a strong habit of converting incidents into controls. The remaining work is to reduce the proportion of controls that are advisory, model-audited, unavailable under missing tooling, or disconnected from promotion decisions.

## Cross-cutting findings

### CF-1: Runtime contracts are stronger than static carriers

Zod schemas often use discriminated unions and strict parsing, while shared TypeScript interfaces use booleans and optional fields. This leaves compile-time guarantees weaker than runtime validation.

### CF-2: Architecture is ahead of enforcement

The repository frequently documents the intended final structure before the enforcement cutover:

- TypeSpec contract generation is represented by contract seams;
- proof subjects and evidence events exist before strict admission;
- mutation and capability evidence exist before blocking use;
- invariant catalog entries exist before deterministic checks.

This staged approach is reasonable, but it creates long-lived partial systems unless every stage has an explicit exit condition.

### CF-3: Local closure is strong; global closure is weak

Individual registries and checks are often exhaustive. The full chain across all registries is not. The codebase can prove:

- all gate classes have providers;
- all actions have output schemas;
- all check scripts have declared CI dispositions.

It cannot yet prove:

- every public action reaches its declared effect;
- every implementation is selected by a production root;
- every proof-producing gate persists subject-bound evidence;
- every shipped capability has one packaged-artifact fixture.

### CF-4: Advisory status is generally honest but still costly

The enforcer-wiring manifest accurately records advisory controls. This prevents false claims of enforcement. It does not reduce the verification work that remains manual while those controls are advisory.

## Prioritized remediation

### Priority 0: Contract and result convergence

#### R-1: Establish the first IDL-generated public boundary

Select one complete surface, preferably the composite action contract, and generate:

- input schemas;
- output data schemas;
- success and failure carriers;
- TypeScript types;
- provider interfaces;
- client bindings or CLI metadata;
- conformance fixtures;
- compatibility reports.

**Exit condition:** the selected boundary has one editable source and CI fails on generated drift or forbidden compatibility change.

#### R-2: Replace boolean-plus-optional result types

Introduce a static discriminated result union:

```ts
type Result<T, E> =
  | { kind: 'success'; data: T }
  | { kind: 'failure'; error: E }
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'indeterminate'; cause: InfrastructureFailure };
```

Generate or derive the runtime envelope schema from the same definition.

**Exit condition:** success with error, failure without error, and skipped-as-passed are unrepresentable.

#### R-3: Typecheck test code

Add a dedicated test TypeScript configuration or project references that compile test and benchmark sources with the repository's strict options.

**Exit condition:** CI fails on type errors in tests without changing production emit.

### Priority 1: Integration and proof closure

#### R-4: Generate a ship-surface manifest

Build one graph from the existing registries:

```text
public action -> input contract -> dispatch branch -> handler
-> provider or adapter -> event or external effect -> output contract
```

Include the packaged artifact and proof fixture for each public capability.

**Exit condition:** missing handlers, unreachable implementations, unowned effects, and absent packaged-artifact proofs fail one graph-closure check.

#### R-5: Complete the canonical gate runner

Route every enforceable gate through one evidence-producing runner. Persist evidence before returning success. Add the planned ownership census.

**Exit condition:** direct gate emissions and unowned shell paths fail CI, and every enforceable result carries a durable evidence reference.

#### R-6: Bind proof to promotion

Move from audit and shadow posture to explicit admission after the reliability data and compatibility requirements are met.

**Exit condition:** a protected transition cannot proceed with missing, stale, contradictory, or indeterminate evidence.

### Priority 2: Ratchet completion

#### R-7: Promote advisory checks by exit condition

Resolve and promote:

- mutation adequacy after Stryker dry-run reliability;
- INV-6 lint after false-positive control;
- selected capability evals after variance and cost thresholds;
- benchmark regression where stable budgets are available.

**Exit condition:** each promoted control is blocking, fail-closed, kill-probed, and hosted on an unfiltered path.

#### R-8: Expand module ownership rules

Declare module state ownership, allowed effects, and permitted dependency directions for each major subsystem.

**Exit condition:** the repository can compute reverse dependencies and detect undeclared cross-module state or effect access.

## Conclusion

Exarchos already reflects the core thesis of the seven principles: verification cost should be reduced through structure rather than absorbed through larger review and test effort.

The main problem is not lack of architectural intent. It is incomplete convergence.

The codebase has:

- schemas without an IDL source;
- algebraic domain types beside boolean carriers;
- registries without a unified integration graph;
- evidence contracts without admission enforcement;
- ratchets that remain advisory.

The next stage should not add more independent checks. It should connect the existing structures into one proof chain:

```text
contract
-> generated code
-> typed module
-> explicit integration graph
-> selected proof
-> subject-bound evidence
-> promotion decision
```

That chain is the practical definition of a codebase optimized for AI-driven development.
