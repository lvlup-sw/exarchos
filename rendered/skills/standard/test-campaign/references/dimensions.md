# Test dimensions

| Dimension | Select when | Evidence required |
|---|---|---|
| Examples and partitions | Behavior changes at a class or limit | Valid and invalid classes, below/at/above boundaries, expected outcome or rejection |
| Coverage and conditions | A branch or predicate effect may be missed | Instrumented reach and independent guard effects for MC/DC, with infeasible combinations stated |
| Properties and invariants | A relation must hold across inputs or states | Accepted predicate, bounded domain and observation boundary |
| Stateful/model-based | Correctness depends on operation order | Independent transition model, bindings, reset, command history |
| Metamorphic | A transformation gives a useful relation | Reviewed preconditions, nonidentity transformation, paired observations, relation and negative control |
| Differential | Independent reference and target share a domain | Shared defined behavior and justified output projection |
| Fuzzing/configurations | Malformed inputs or option interactions matter | Structured domain, semantic checks and declared interaction strength |
| Concurrency/lifecycle | Overlap or lifecycle ordering can change results | Controlled overlap and native stress. For linearizability, use a sequential spec and history checker |
| Durability/recovery | Effects or acknowledgments can be lost across restart | Supported real provider, process or fault control, fault reach, persisted identity and work accounting |
| Load/resources/liveness | Saturation or outage can prevent progress | Load model, resource bounds, recovery deadline and admission/fairness assumptions |
| Mutation/negative controls | A passing suite may miss relevant faults | Assertion kills, separate build errors and timeouts, classified survivors and exclusions |
| Reduction/replay | A failure needs a reproducible fixture | Concrete input/history and preserved failure signature. Record schedule controls separately from input seeds |
| Static/solver checks | A finite model or source rule can resolve a claim | Encoding, bounds and overflow semantics. An unknown result stays unresolved |

For a release risk assessment, map critical outcomes through admission, queue, execution, retry, dispatch, checkpoint, restart, and shutdown as applicable. Repeat supported checks on the exact release candidate. Keep missing providers, untested configurations, and uncontrolled schedules visible in the assessment.

## Choose complementary checks

- Pair input partitions and properties with native branch/condition coverage. Reaching a line does not establish the oracle's correctness or MC/DC.
- Pair metamorphic tests with an independent reference or fixed expected examples where possible. A relation can hold for two wrong outputs; state its preconditions and what it cannot detect.
- Pair stateful sequential models with controlled overlap when ordering matters. A sequential model comparison does not check concurrent histories unless a native checker establishes a legal serialization under the accepted consistency contract.
- Pair recovery checks with occurrence identities and acknowledgment boundaries. Inject faults before and after the actual provider effect, record attempted and reached cuts, restart a separate process, and account for accepted work. Do not infer exactly-once external effects from scheduler recovery.
- Pair load/resource bounds with post-outage progress. Declare arrival rate, queue capacity, duration, memory/latency thresholds, cancellation behavior, and recovery deadline before running. Finite progress observations do not prove unbounded liveness.
- Pair each important oracle with a plausible negative control. Separate assertion kills from malformed mutants, compiler failures, timeouts, and unreached faults; explain equivalent or unsupported survivors. A mutation score without that denominator is not adequacy evidence.
- Treat inferred invariants as hypotheses until reviewed against the contract. For solver checks, state finite bounds, abstraction, and arithmetic semantics; distinguish satisfiable counterexamples, unsatisfiable bounded queries, and unknown results.

Use the repository's existing tools first: native coverage for reach, property/fuzz tools for supported domains, a native concurrency checker for controlled schedules, and its process harness for recovery. The testgen CLI supplies typed cases, metamorphic/differential bindings, and sequential histories. It does not replace those other tools or run them through a new execution layer.

## Evidence row

Retain these fields in the native report or the existing supported evidence carrier:

| Field | Required content |
|---|---|
| Meaning | Exact operation/property, supported configuration, and accepted contract reference |
| Oracle | Predicate, relation, independent reference/model, or explicit expected outcome |
| Reach | Discovered/executed cases; attempted/reached faults; relevant coverage or schedules |
| Sensitivity | Intended negative control and its assertion result; classified survivors |
| Replay | Concrete input/history, revision, environment, command, and any schedule/process controls |
| Limits | Bounds, rejected/exhausted exploration, exclusions, missing providers, and unresolved assumptions |
| Outcome | Pass, fail, or indeterminate for this scope; separate harness status |

For Bifrost #85, retain separate rows for real-provider process cuts, lifecycle overlap, prolonged dependency outage, sustained overload, and release applicability. An in-memory or synthetic crash image cannot fill the real-provider row. If the repository provides only an extension interface, record the missing supported production adapter and continue the independently runnable dimensions.
