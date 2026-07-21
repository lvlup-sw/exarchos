# Structural principles for AI-driven development

## Premise

The marginal cost of producing code has collapsed. The cost of proving that code is correct, complete, compatible, and safe has not. It often grows faster than output because every generated component adds states, boundaries, interactions, and claims that must be checked.

The architecture of an AI-driven codebase should therefore optimize for verification cost, not code-production cost.

The governing rule is:

> Convert every fact that can be proved by construction into a generated, compile-time, or deterministic check. Reserve tests and human review for facts that require runtime or semantic judgment.

A useful proof order is:

1. construction and code generation;
2. compiler and type system;
3. deterministic static analysis;
4. contract and component tests;
5. production-path integration tests;
6. human judgment.

Use the earliest layer capable of proving the claim. Do not repeatedly test a fact that a stronger, cheaper layer can make impossible to violate.

## 1. Author each boundary contract once

### Rule

Every boundary should have one executable, versioned contract from which all mechanical representations are generated.

This applies to:

- public APIs;
- internal service interfaces;
- events and commands;
- persisted records;
- configuration;
- tool calls;
- CLI input and output;
- error envelopes;
- extension and plugin protocols.

### Apply it

Author the contract in an IDL or schema system such as TypeSpec, OpenAPI, Protocol Buffers, JSON Schema, GraphQL, Smithy, or an equivalent typed source.

Generate:

```text
contract
  -> language types
  -> runtime validators and parsers
  -> client SDK
  -> server interface or handler skeleton
  -> error types
  -> serialization code
  -> test fixtures and builders
  -> compatibility metadata
  -> reference documentation
```

Generate both inputs and outputs. A generated request type paired with a handwritten response object leaves half the boundary unproved.

### Prove it

CI should:

```text
generate contracts
fail if the working tree changes
compare the contract against the target branch
reject forbidden compatibility breaks
run generated provider and consumer conformance suites
```

### Avoid

- handwritten copies of the same type in several packages;
- runtime schemas that disagree with static types;
- examples used as the real specification;
- documentation that independently restates field names or allowed values;
- stringly typed errors, commands, event names, or status values.

## 2. Make illegal states unrepresentable

### Rule

Use the type system and constructors to prevent invalid state from entering the program.

### Apply it

Prefer:

- discriminated unions over related booleans;
- branded or nominal identifiers over plain strings;
- non-empty collections when emptiness is invalid;
- explicit optionality instead of sentinel values;
- validated value objects for paths, versions, digests, money, and timestamps;
- exhaustive pattern matching over default branches;
- typestate or state-specific types for lifecycle transitions;
- constructors that return typed failures instead of partially valid objects.

Example:

```ts
type GateResult =
  | { kind: "passed"; evidence: EvidenceRef }
  | { kind: "failed"; reason: FailureReason }
  | { kind: "indeterminate"; cause: InfrastructureFailure };
```

This is stronger than:

```ts
type GateResult = {
  passed: boolean;
  error?: string;
};
```

The first form forces callers to handle the difference between a product failure and missing evidence. The second permits accidental success-shaped behavior.

### Prove it

- enable strict compiler settings;
- require exhaustive switches;
- prohibit unsafe casts and unvalidated deserialization at boundaries;
- keep raw transport and persistence types out of domain code;
- test constructors and parsers, not every downstream use of a validated value.

## 3. Build independently verifiable modules

### Rule

A module should expose a narrow public contract, own its invariants, and be verifiable through that contract without knowledge of its internals.

### Apply it

Each module should declare:

- its public inputs and outputs;
- the invariants it owns;
- the dependencies it requires;
- the effects it may perform;
- the errors it may return;
- the state it owns;
- its compatibility policy.

Prefer high cohesion and explicit dependency direction. Avoid modules that share mutable state, reach into each other's persistence, or depend on undeclared globals.

A good boundary lets verification stop. Once a module proves its contract, consumers should not need to re-prove its implementation details.

### Prove it

- enforce import and dependency boundaries;
- reject dependency cycles;
- expose test seams only through public ports, not internal implementation access;
- run the module's contract suite against every implementation;
- verify that no other module writes its state directly.

If a component cannot be tested through its public interface, the boundary is probably wrong.

## 4. Separate decisions from effects

### Rule

Keep business decisions deterministic. Push I/O and mutation to explicit adapters.

### Apply it

Use a functional-core, imperative-shell shape:

```text
validated input + current state
  -> pure decision
  -> typed result and requested effects
  -> effect adapters
```

The decision layer should not read clocks, random generators, environment variables, network services, global state, or the filesystem directly. Pass those values in through typed ports.

### Prove it

The pure core can be checked with:

- property-based tests;
- model-based tests;
- exhaustive tests over small state spaces;
- deterministic replay;
- mutation testing.

Adapters need smaller contract and integration suites. This prevents broad end-to-end tests from carrying the entire verification burden.

## 5. Represent integration topology as data

### Rule

The system should be able to enumerate every required integration edge and fail mechanically when an edge is missing.

### Apply it

Represent composition in typed registries, manifests, or generated graphs:

```text
operation -> route -> handler -> domain port -> adapter
event -> producer -> schema -> registry -> consumer or projector
command -> parser -> validator -> handler -> result serializer
plugin -> capability -> implementation -> activation path
```

Do not hide required wiring in reflection, naming conventions, scattered imports, or model-authored instructions unless a build step materializes and validates the graph.

### Prove it

Add structural checks for:

- public operations without handlers;
- handlers without reachable public callers;
- registered events without schemas;
- emitted events without registered consumers when a consumer is required;
- declared capabilities without implementations;
- implementations that are never selected by the composition root;
- generated clients without provider conformance;
- gates that are registered but have no production caller;
- configuration keys that are read but never declared.

The build should fail on an orphaned required edge.

This directly addresses the recurring "present but not working" failure. In Exarchos, [PR #1424](https://github.com/lvlup-sw/exarchos/pull/1424), [issue #1436](https://github.com/lvlup-sw/exarchos/issues/1436), and [issue #1451](https://github.com/lvlup-sw/exarchos/issues/1451) showed that helpers, schemas, and adapters could all exist while the production feature remained dead.

## 6. Prove the composition root and shipped artifact

### Rule

Every user-visible capability needs at least one proof that starts from the real public entry point and crosses the actual production composition root.

### Apply it

The test should use the same:

- generated client or public CLI;
- transport;
- dependency-injection graph;
- configuration loader;
- persistence implementation;
- packaged or bundled artifact;
- authorization path;
- serialization boundary.

It should verify the externally observable result and any required durable side effects.

Examples:

- invoke the packaged CLI, not its command function;
- use a real protocol client against the server transport, not a direct handler call;
- start the application from its production bootstrap;
- install the built package into a clean fixture;
- restart and verify persisted behavior where replay matters.

### Prove it

Maintain a small ship-surface matrix:

| Capability | Public entry point | Shipped artifact | Durable effect | Production-path proof |
|---|---|---|---|---|
| Create task | CLI and API | bundled CLI/server | task stream | fixture ID |
| Transition workflow | API | server bundle | state projection | fixture ID |
| Install plugin | bootstrap script | release archive | installed files | fixture ID |

Every required row must have a passing proof. This is integration completeness expressed as data, not confidence inferred from unit-test volume.

## 7. Layer proofs to minimize cost

### Rule

Use a verification ladder in which each layer proves only what cheaper layers cannot.

### Apply it

| Layer | Best use |
|---|---|
| Code generation | consistency among repeated representations |
| Compiler | shape, exhaustiveness, ownership, invalid state |
| Static structural checks | dependency direction, registry closure, forbidden APIs |
| Contract tests | boundary behavior and provider/consumer agreement |
| Component tests | module semantics with controlled dependencies |
| Integration tests | composition, transport, persistence, packaging |
| End-to-end tests | a small set of high-value user outcomes |
| Human review | intent, tradeoffs, maintainability, novel risk |

Do not use expensive end-to-end tests to prove field names, enum closure, or handler registration. Do not expect the compiler to prove distributed side effects or business meaning.

### Prove it

For every acceptance criterion, name the cheapest proof layer that can establish it. A criterion without a named proof is incomplete.

## 8. Generate conformance tests with contracts

### Rule

A boundary contract should generate executable obligations for both providers and consumers.

### Apply it

Generate:

- valid and invalid examples;
- serialization round trips;
- required-field and unknown-field behavior;
- error-code coverage;
- pagination and ordering cases;
- compatibility fixtures;
- protocol state-machine cases;
- provider and consumer test harnesses.

Run the same conformance suite against every implementation. For external consumers, publish the suite or fixtures with the contract package.

### Prove it

- every provider passes the generated provider suite;
- every client passes the generated consumer suite;
- compatibility tests run against the previous supported version;
- contract changes declare additive, deprecated, or breaking semantics;
- deprecations have a measured consumer-removal condition.

## 9. Model state transitions explicitly

### Rule

State changes should occur through typed commands and validated transitions, not arbitrary field mutation.

### Apply it

Define:

- legal states;
- legal transitions;
- required evidence for each transition;
- transition-specific inputs;
- emitted events;
- side effects;
- retry and compensation behavior.

Use one transition function or state-machine boundary. Do not let callers set `status`, `phase`, or related fields directly.

### Prove it

- the compiler or state-machine generator enumerates legal transitions;
- illegal transitions fail before side effects;
- transition admission and state persistence are atomic;
- concurrent writers use optimistic concurrency control or equivalent;
- repeated commands are idempotent;
- replay reaches the same state;
- partial failure has a tested recovery path.

[Issue #1370](https://github.com/lvlup-sw/exarchos/issues/1370) found 31 defects caused in part by prose instructing agents to mutate phase through an API that rejected phase mutation. The structural fix is one typed transition path, not better reminders.

## 10. Make changes proof-carrying

### Rule

A change should arrive with machine-verifiable evidence describing what changed, what contracts it affects, and what proves it.

### Apply it

For each change, derive:

- changed public contracts;
- affected modules and consumers;
- required compatibility checks;
- selected tests;
- generated artifacts;
- migration requirements;
- production-path proofs;
- rollback or feature-disable path.

Use the dependency and contract graph to select verification. Do not ask an agent or reviewer to rediscover the blast radius from the diff.

### Prove it

Attach evidence to the exact commit or artifact digest:

```text
change
  -> affected contracts
  -> generated diff
  -> selected checks
  -> results
  -> packaged artifact
  -> production-path proof
```

Evidence from another revision is stale. A green check without a subject binding is not proof.

## 11. Bound the blast radius of every component and change

### Rule

Architecture should make the impact of a change predictable before the change is implemented.

### Apply it

- keep dependencies directional;
- avoid shared mutable state;
- isolate persistence ownership;
- use adapters for external systems;
- version public contracts;
- use feature flags at stable boundaries;
- split work by independently buildable and testable slices;
- keep commits and pull requests small enough to reason about;
- forbid unrelated cleanup in behavior-changing changes.

### Prove it

- compute reverse dependencies for changed contracts;
- fail on dependency cycles or forbidden cross-module imports;
- run affected-module tests plus contract consumers;
- verify that a rollback or disable path exists for high-risk changes;
- track review and verification time by change size and boundary count.

## 12. Test behavior spaces, not generated examples

### Rule

AI can cheaply generate many example tests that repeat the implementation's assumptions. Use verification techniques that search the behavior space or challenge those assumptions.

### Apply it

Use:

- property-based testing for invariants;
- metamorphic testing when exact outputs are expensive to specify;
- fuzzing for parsers and boundary inputs;
- model-based testing for state machines;
- differential testing across implementations;
- mutation testing to test the tests;
- fault injection for retries, concurrency, and recovery;
- generated adversarial cases from the contract, not from the implementation.

### Prove it

Track whether tests kill representative faults. A high line-coverage number with surviving obvious mutations is weak evidence.

Keep example tests for important scenarios and readable specifications. Do not use their count as a proxy for assurance.

## 13. Make failure explicit, typed, and non-silent

### Rule

Every boundary should state how it fails. Failure must remain distinguishable from success and from infrastructure uncertainty.

### Apply it

Define stable error codes and typed metadata such as:

- retryable or permanent;
- caller, dependency, policy, or infrastructure fault;
- safe to compensate;
- partial side effects performed;
- required remediation;
- correlation and subject identifiers.

Avoid:

- broad exception catches;
- empty defaults after parse failure;
- skipped gates reported as passing;
- fallback to stale or unrelated state;
- success responses with warning text;
- logs as the only error channel.

### Prove it

- require exhaustive handling of error unions;
- test negative paths at every public boundary;
- inject dependency failures;
- verify that partial effects are reconciled;
- assert that unknown failures cannot become success.

## 14. Turn recurring findings into ratchets

### Rule

The second occurrence of a defect class is an architecture failure. Convert it into a structural prevention mechanism.

### Apply it

Choose the earliest reliable control:

1. type or constructor;
2. generated contract;
3. state-machine restriction;
4. architecture or registry check;
5. contract fixture;
6. property or mutation test;
7. production-path regression;
8. human checklist only when none of the above can express the rule.

Every ratchet needs a kill fixture that proves the check fails on the old defect.

Review is how a defect class is discovered. The ratchet is how the organization stops paying to rediscover it.

## 15. Treat duplication as verification debt

### Rule

Every independent copy of behavior, schema, configuration, or policy creates another fact that must remain synchronized.

### Apply it

- generate repeated representations;
- centralize shared behavior behind stable contracts;
- remove duplicate tests that prove the same claim through the same path;
- keep one canonical vocabulary and identifier set;
- generate reference documentation from executable contracts;
- use templates only when generated output is guarded against drift.

Do not deduplicate code that only looks similar but owns different invariants. The objective is one source per fact, not minimum line count.

### Prove it

- run code-generation drift checks;
- scan for duplicate registrations and contract definitions;
- reject repeated authoritative constant sets;
- measure handwritten boundary representations;
- require explicit justification for a second source of truth.

## Repository baseline

An AI-driven repository should provide the following structural substrate.

### For every module

- one public contract;
- explicit state and invariant ownership;
- generated static and runtime boundary types;
- a deterministic core where practical;
- contract tests;
- property or model-based tests for important state spaces;
- one integration proof for each required external edge;
- typed failures;
- an owner and compatibility policy.

### For every public capability

- a row in a machine-readable ship-surface manifest;
- a reachable composition path;
- a packaged-artifact proof;
- a declared durable or external effect;
- a production-path fixture;
- a rollback or disable mechanism when consequence is high.

### For CI

Run, in order:

1. regenerate contracts and require a clean tree;
2. compile with strict and exhaustive checks;
3. validate dependency and ownership boundaries;
4. validate integration-graph closure;
5. compare public contracts against the target branch;
6. run generated conformance suites;
7. run affected component and property tests;
8. run mutation tests for critical logic;
9. run the smallest production-path suite that proves shipped composition;
10. bind results to the produced artifact.

## Definition of done

A change is done when:

- its public contracts are explicit and versioned;
- repeated representations are generated;
- invalid states are rejected by construction where possible;
- affected modules can be verified independently;
- all required integration edges are present and reachable;
- the shipped entry point produces the intended outcome;
- failure paths are typed and tested;
- concurrency and retry behavior are defined where relevant;
- generated and compatibility checks pass;
- tests demonstrate fault detection, not only execution;
- verification evidence is bound to the exact revision and artifact;
- the blast radius and rollback path are known.

## What to measure

Do not optimize for generated lines, pull-request count, or test count. Measure whether the structure is shrinking the proof burden.

Useful measures include:

- percentage of boundary representations generated from one contract;
- number of handwritten copies per public contract;
- compile-time versus runtime defect detection;
- orphaned integration edges;
- production-path coverage of public capabilities;
- mutation score for critical modules;
- contract compatibility failures caught before merge;
- median verification time per changed boundary;
- end-to-end suite duration and flake rate;
- escaped defects caused by missing wiring;
- repeated defect classes without a ratchet;
- change failure and rollback rates.

The target is not maximum automation. The target is a codebase in which most correctness claims are local, mechanical, and cheap to re-prove.

## Evidence from Exarchos

The repository history supports the focus on proof structure:

- [PR #1424](https://github.com/lvlup-sw/exarchos/pull/1424), [issue #1436](https://github.com/lvlup-sw/exarchos/issues/1436), and [issue #1451](https://github.com/lvlup-sw/exarchos/issues/1451) show why component presence and unit tests do not prove production wiring.
- [Issue #1370](https://github.com/lvlup-sw/exarchos/issues/1370) and [issue #1696](https://github.com/lvlup-sw/exarchos/issues/1696) show the cost of repeating executable rules in prose.
- [Issue #1701](https://github.com/lvlup-sw/exarchos/issues/1701) and [issue #1721](https://github.com/lvlup-sw/exarchos/issues/1721) show that verification gates need their own scope, invocation, failure, and resource guarantees.
- The [event-sourced task-store audit](docs/research/2026-05-16-event-sourced-task-store-audit.md) shows that an architectural label does not prove concurrency, replay, cache, ordering, or cost properties.
- The [E2E testing strategy](docs/research/2026-04-19-e2e-testing-strategy.md) documents the gap between implementation topology and ship topology.
- The [methodology drift audit](docs/research/2026-06-21-methodology-drift-audit.md) shows why one executable source must drive model-facing instructions and runtime behavior.

## Supporting research

- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic, [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- OpenAI, [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
- Princeton, [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793)
- NIST, [Secure Software Development Framework 1.1](https://csrc.nist.gov/pubs/sp/800/218/final)
- SWE-bench, [Verified dataset](https://www.swebench.com/verified.html)
