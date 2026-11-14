# Testing Strategy Guide

Select verification for each task. Set `riskTier`, `boundaryTouching` and `testLayer` in the typed object. Specify examples, properties, benchmarks and characterization in `instructions` when the implementation needs them. Use the fields in `task-template.md`.

| Risk | Verification |
| --- | --- |
| Low | Static checks and focused examples when behavior changes. |
| Medium | Scoped tests and a known-bad control. Add a property test when the pure behavior has a useful invariant. |
| High | Add integration coverage across the boundary. Declare the test paths and verify the main acceptance behavior. |

For a boundary task, plan a test of the contract and choose the most faithful practical collaborator. A registered parser at the input boundary can make invalid input unrepresentable in the core.

## Category Requirements

Plan a property test when the task involves any of these categories:

| Category | Example Code | Properties to Test |
|---|---|---|
| **Data transformations** | Parse/serialize, encode/decode, format/unformat | Roundtrip: `decode(encode(x)) === x` |
| **State machines** | Workflow HSM, circuit breaker, connection lifecycle, **external stateful integrations** (a DB/queue/cache/cloud-API the task drives across calls) | Transition validity: no invalid state reachable from any valid state. For an *external* stateful boundary, use **model-based conformance** — see below |
| **Collections/ordering** | Sort, filter, deduplicate, paginate, merge | Idempotence: `sort(sort(x)) === sort(x)` |
| **Concurrency** | Optimistic locking, CAS, event ordering | Linearizability: concurrent operations produce valid state |
| **Serialization** | Event schemas, API contracts, JSON/YAML/TOML | Schema compliance: output matches declared schema for all inputs |
| **Mathematical operations** | Scoring, percentages, budgets, rates | Invariants: `score >= 0 && score <= 1.0`, conservation laws |

Assign `propertyTests: false` when the task is:
- Pure wiring (DI registration, configuration binding)
- UI layout or styling
- Simple CRUD without business logic
- Documentation or content-only changes

## Model-Based Conformance at Stateful Boundaries (SIV-6)

When a task drives an **external stateful integration** (a database, queue, cache, or stateful cloud API — not just an in-process HSM), extend the State-machines property into **model-based conformance**: author a small reference model + a command set and let the runner fuzz real-vs-model (`fc.commands` + `modelRun` in fast-check; Hypothesis `RuleBasedStateMachine`). This gives implementation-independent refactor/regression protection at the boundary — the model runner itself executes in-process, but the stateful boundary it exercises still needs its infra double (a Testcontainers/LocalStack-style fixture per the SIV-5 resolution table), so the win is *reduced* reliance on heavy production infra, not elimination of the test fixture — and is the highest-leverage workload-agnostic boundary signal.

**The provenance guardrail is non-negotiable.** The reference model is an LLM-authored oracle and carries the *same confirmation-bias defect as an LLM-authored mock*: a model reverse-engineered from the implementation just re-asserts the code's behavior, never the intended spec (fast-check's own docs warn the model "should NOT be a carbon copy"; MongoDB's *retrofit* conformance model failed and was abandoned, while the *spec-derived* sibling succeeded). A model-based gate is therefore **theater unless** the model is:

1. **Spec-grounded** — it cites the acceptance-criterion ID(s) it encodes (no citation ⇒ reject the model).
2. **Strictly simpler** than the implementation — a deliberately reduced abstraction, never a line-by-line mirror.
3. **Authored before/with the code** — never reverse-engineered from the running implementation.
4. **Validated by a known-bad-trace rejection** — the model must *reject* a seeded-wrong transition; a model that accepts the bad trace is vacuous and the gate fails.

Include these points in the task instructions. The assurance lives in the runner + the provenance checklist, never in an LLM asked to be the contract-checker.

## Hermetic Doubles (SIV-5)

When a test needs a double for an **unowned** dependency, do not hand-author a mock of it — that asserts against a fiction (the `check_mock_boundary` gate flags it). Use the **resolved hermetic double** for the dependency's class, in Google's canonical fidelity order **real > fake > stub/mock**:

| Dependency class | Preferred double | Fidelity | Cadence |
|---|---|---|---|
| Database | Testcontainers (the real engine in a container) | real | boundary/offline |
| Cloud API | LocalStack (an emulated cloud) | fake | boundary/offline |
| Message broker | Testcontainers (the real broker) | real | boundary/offline |
| Third-party HTTP | a Pact-verified contract stub | stub | inner-loop |
| Owned interface | a hand-written fake | fake | inner-loop |

Two honesty caveats the resolver carries as first-class fields: an emulator (LocalStack) is itself a **fake of the cloud** — a higher-fidelity failure mode, not a guarantee — and a container-backed real double costs real wall-clock, so it runs at **boundary/offline cadence, never the inner loop**. The `check_mock_boundary` steer resolves the concrete double automatically for a known dependency; an unrecognized dependency keeps the generic menu (resolve, don't guess).

## Specify properties

State each required property in the task instructions. For a parser and formatter, require a roundtrip over valid inputs and idempotent formatting.

## Benchmark Requirements

Plan a benchmark for the applicable performance-sensitive work below.

| Category | Example Code | What to Measure |
|---|---|---|
| **Event store operations** | Append, query, snapshot | Throughput (ops/sec), p99 latency |
| **View materialization** | Projection apply, cold-start rebuild | Events/sec, cold-start time |
| **Serialization hot paths** | JSON parse/stringify, schema validation | Throughput, memory allocation |
| **Query-heavy reads** | CQRS projections, aggregations | Query latency under load |

These categories generally need no benchmark:
- Pure wiring, configuration, or DI registration
- Content-only changes (Markdown, documentation)
- Test infrastructure (test helpers, fixtures)
- UI components or styling

Record the measurement conditions and any agreed threshold in the task instructions. For an event append benchmark, specify the workload, sample size and p99 latency target.

## Test Layer Selection (Testing Trophy Distribution)

The planner MUST assign `testLayer` to each task. Follow the Testing Trophy distribution: **integration-heavy, unit-light**.

| Layer | When to assign | Default? |
|---|---|---|
| `acceptance` | First task per feature or DR-N cluster with Given/When/Then criteria. Tests feature from user perspective with real collaborators. | No — explicitly assigned |
| `integration` | Task tests multiple components working together. Uses real collaborators, mocks only at infrastructure boundaries. | **Yes — default layer** |
| `unit` | Task involves isolated complex logic (parsers, algorithms, math). Pure functions with complex edge cases. | No — only for naturally isolated code |


> **Note:** `propertyTests: true` can coexist with any `testLayer` value — it's an independent overlay, not a mutually exclusive layer.

**Sociable test preference:** Default to using real collaborators (sociable tests). Mock only at infrastructure boundaries — external HTTP services, databases, filesystem — and for an **unowned** boundary prefer the resolved *hermetic double* over a hand-authored mock (see *Hermetic Doubles* above). If a test requires >3 mocked dependencies, the task may be at the wrong test layer.

## Characterization Testing

Assign `characterizationRequired: true` when the task modifies existing code behavior (refactoring, fixing, enhancing). The implementer captures current behavior before making changes. Not applicable for new code creation.

## Auto-Determination

Choose the primary `testLayer` before dispatch. State in the instructions when the implementer needs properties, benchmarks, or pre-change characterization. Use the task's behavior and file targets to choose the categories above.

## Reference

Background reading is in the repository design archive under Autonomous Code Verification.
