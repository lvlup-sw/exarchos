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
