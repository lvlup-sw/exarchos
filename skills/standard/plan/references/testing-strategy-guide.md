# Testing Strategy Guide

When creating implementation plans, assign a `testingStrategy` to each task. This field controls which verification techniques agents apply during implementation.

## Risk Tier Coupling

Verification depth is **risk-proportional**, not uniform. Each task's `riskTier` (`low | medium | high`) and `boundaryTouching` tag — derived mechanically by `classifyTask`, overridable explicitly in the plan — select the gate sequence via `workflow/verification-policy.ts`:

- **low** — static analysis only; a 3-line verification note suffices in the dispatch prompt.
- **medium** — adds scoped tests + the `check_test_adequacy` kill-probe (revert source → assert the new test goes red → restore).
- **high** — the medium set plus the full integration suite at the merge boundary (and mutation-adequacy), judged test-after per `_shared/references/verification.md`. Granular per-behavior red-green is an explicit opt-in, not the default.
- **boundaryTouching** — adds `check_contract_drift` (every tier) and `check_mock_boundary` (medium/high): structure is compiler-verifiable; keep exactly ONE semantic test per boundary and mock only what you own. **Parse, don't validate at the edge** (methodology E): untrusted IO crosses a single registered parser before entering the core, so the type-checker becomes the first-line integration test; the `check_static_analysis` boundary-parse leg (SIV-3 Layer B) enforces this when a repo commits the ruleset. For a flagged unowned mock, the gate's steer resolves the **concrete hermetic double** (SIV-5) — see *Hermetic doubles* below.

Planners set `riskTier`/`boundaryTouching` explicitly only when the mechanical derivation would misclassify (see the derivation table in `task-template.md`); the gate *sequence* itself is never encoded in plan prose.

## Tier → Default `testingStrategy` (the cheap verification mix)

The default verification mix is **risk-proportional and table-driven** — read the `testingStrategy`
fields straight off the row for the task's `riskTier`. This is data, not a judgement call: the planner
emits these fields verbatim per tier and only deviates when the category tables below force a stronger
signal (e.g. a data-transformation task always gets `propertyTests: true` regardless of tier).

For **medium/high** the default is the **cheap mix** — strict/branded types + inline
invariants/assertions + **one** property test on the pure core + **one** acceptance north-star test —
deliberately omitting granular per-behavior red-green. Per-behavior RED→GREEN is an **explicit opt-in**
(`exampleTests` stays `true`, but exhaustive per-case example tests are added only when the plan calls
for them), not the default.

| `riskTier` | `exampleTests` | `propertyTests` | `testLayer` | `characterizationRequired` | Default mix |
|---|---|---|---|---|---|
| **high** | `true` | `true` (one PBT on the pure core) | `acceptance` (one north-star test) | `true` when modifying existing code, else `false` | Strict/branded types + inline invariants/assertions + 1 PBT + 1 acceptance test; granular per-behavior red-green is opt-in |
| **medium** | `true` | `true` (one PBT on the pure core) | `integration` | `true` when modifying existing code, else `false` | Same cheap mix as high, at the integration layer; granular per-behavior red-green is opt-in |
| **low** | `true` | `false` | `unit` | `false` | Minimal — example tests only; no PBT, no characterization |

**Why this is safe (the relaxation is guarded, not unguarded).** Omitting granular per-behavior
red-green for medium/high is backstopped by two adequacy probes that catch the vacuous-test and
vacuous-PBT-property failure modes the omission could otherwise admit:

- **R5 mutation-adequacy** (`/review` boundary, high tier) — runs the resolved mutation command
  diff-scoped and surfaces surviving mutants as "write a test that kills `<file>:<line>`" follow-ups.
- **R3 `check_test_adequacy`** (per-task kill-probe, already shipped) — reverts the task's source hunks,
  asserts the new test(s) go red, then restores: proves the test isn't tautological with no extra tool.

A category-table match always **overrides upward** from the tier default (it never relaxes it): a
medium-tier serialization task still gets `propertyTests: true` with a roundtrip property even though the
tier row already sets it. The tier row is the floor; the category tables raise it.

## Schema

```typescript
testingStrategy: {
  exampleTests: true;           // Always required (literal true)
  propertyTests: boolean;       // Property-based tests required?
  benchmarks: boolean;          // Performance benchmarks required?
  testLayer: 'acceptance' | 'integration' | 'unit';  // Required (property is a separate axis via propertyTests)
  characterizationRequired?: boolean;  // Pre-capture behavior before modifying existing code?
  properties?: string[];        // Guidance: which properties to verify
  performanceSLAs?: PerformanceSLA[]; // Guidance: performance targets
}
```

## Category Requirements

Assign `propertyTests: true` when the task involves any of these categories:

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

Encode these as the model's own checklist (carried on the task via `task-template.md`). The assurance lives in the runner + the provenance checklist, never in an LLM asked to be the contract-checker.

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

## Populating the `properties` Array

When `propertyTests: true`, provide guidance strings in the `properties` array describing which properties to verify:

```json
{
  "exampleTests": true,
  "propertyTests": true,
  "benchmarks": false,
  "properties": [
    "roundtrip: decode(encode(x)) === x for all valid inputs",
    "idempotence: format(format(x)) === format(x)"
  ]
}
```

## Benchmark Requirements

Assign `benchmarks: true` when the task involves any of these categories:

| Category | Example Code | What to Measure |
|---|---|---|
| **Event store operations** | Append, query, snapshot | Throughput (ops/sec), p99 latency |
| **View materialization** | Projection apply, cold-start rebuild | Events/sec, cold-start time |
| **Serialization hot paths** | JSON parse/stringify, schema validation | Throughput, memory allocation |
| **Query-heavy reads** | CQRS projections, aggregations | Query latency under load |

Assign `benchmarks: false` when the task is:
- Pure wiring, configuration, or DI registration
- Content-only changes (Markdown, documentation)
- Test infrastructure (test helpers, fixtures)
- UI components or styling

When `benchmarks: true`, populate `performanceSLAs` with targets:

```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": true,
  "performanceSLAs": [
    { "operation": "event-append", "metric": "p99_ms", "threshold": 10 }
  ]
}
```

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

The planner MUST auto-determine `propertyTests`, `benchmarks`, `testLayer`, and `characterizationRequired` for each task — never leave them for the implementer to decide. Resolve in this fixed order, so the result is deterministic with no implementer guesswork:

1. **Tier default** — start from the row for the task's `riskTier` in the **Tier → Default `testingStrategy`** table above. This sets `propertyTests`, `testLayer`, and `characterizationRequired` deterministically.
2. **Category override (upward only)** — if the task matches a category in the tables above (data transformations, state machines, serialization, …), raise the relevant field (e.g. `propertyTests: true`, `benchmarks: true`). A category match never relaxes the tier floor.
3. **Explicit plan value** — an explicit field in the plan always wins over both.

`benchmarks` follows the same shape: `false` by default, raised to `true` only by a benchmark-category match. Analyze each task's description and file paths to match against the categories.

## Reference

See [Autonomous Code Verification design](../../../docs/designs/2026-02-15-autonomous-code-verification.md#when-to-require-property-based-tests) for the full rationale and category taxonomy.
