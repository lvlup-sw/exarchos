# Principles for AI-driven software development

**Status:** Research synthesis, 2026-07-21

## Thesis

AI changes where engineering effort is spent. It can produce code quickly, but it does not remove the work needed to define boundaries, compose systems, verify behavior, control risk, and learn from failures. In practice, the bottleneck moves from writing code to designing an environment in which correct work is easier to produce and incorrect work is difficult to promote.

The strongest general rule is:

> Do not rely on an agent to remember an obligation that the system can enforce, derive, observe, or verify.

This conclusion is grounded in 1,079 pull requests and 644 issues from Exarchos, plus current empirical research, engineering guidance, and software assurance standards. The recurring failures were rarely syntax errors. They were missing invocation edges, drift between repeated contracts, weak evidence, gates that did not run, concurrency gaps, stale state, unbounded context, and review findings that were never converted into prevention.

## What caused problems

### Components existed without a working production path

[PR #1424](https://github.com/lvlup-sw/exarchos/pull/1424) added an elicitation adapter and extensive local tests. [Issue #1436](https://github.com/lvlup-sw/exarchos/issues/1436) recorded the missing end-to-end path. [Issue #1451](https://github.com/lvlup-sw/exarchos/issues/1451) then proved the feature never fired because a real runtime value was rejected by an incorrect narrowing condition.

The defect was not "missing code." Every visible piece existed. The system lacked proof that a real call could cross the composition root, transport, persistence layer, and retry path.

### Prose and runtime contracts drifted

[Issue #1370](https://github.com/lvlup-sw/exarchos/issues/1370) found 31 phase-transition defects across 18 commands. Several commands instructed agents to perform an operation the runtime rejected. [Issue #1696](https://github.com/lvlup-sw/exarchos/issues/1696) records the same guarantee being repeated across roughly eight locations and requiring four review cycles to repair.

Rules stated in several places become several rules. A prose convention has no compiler.

### Verification controls were present but ineffective

[Issue #1701](https://github.com/lvlup-sw/exarchos/issues/1701) found that required CI jobs could be skipped by path filters while the rollup treated them as passing. [Issue #1721](https://github.com/lvlup-sw/exarchos/issues/1721) describes a static-analysis gate that scanned the wrong checkout and exhausted 4 GB of memory.

A gate is software. It can target the wrong subject, fail open, time out, become too expensive to run, or report infrastructure failure as product failure.

### Architectural labels hid missing operational properties

The event-sourced task-store audit found missing optimistic concurrency control, stale caches, unstable pagination, unbounded hydration, excessive event writes, and silent malformed-event coercion. The system was event sourced, but the label did not guarantee safe concurrency, deterministic replay, bounded cost, or recovery.

See [the task-store audit](docs/research/2026-05-16-event-sourced-task-store-audit.md).

### Review found defects, but prevention lagged

AI and human review repeatedly found dead paths, invalid assumptions, fail-open checks, stale snapshots, and wrong base-branch behavior. The same classes returned until a typed API, generated artifact, lint rule, regression test, or blocking gate made recurrence harder.

Review is a discovery mechanism. It is not a durable control.

### Isolation lacked an explicit lineage contract

[Issue #1301](https://github.com/lvlup-sw/exarchos/issues/1301) showed writes leaking from an isolated worktree into the main checkout. [Issue #1526](https://github.com/lvlup-sw/exarchos/issues/1526) showed the opposite problem: strict isolation prevented sequential tasks from inheriting an accumulated feature branch.

Isolation alone is underspecified. The system must define the exact base revision, ownership boundary, allowed write scope, and merge lineage.

### Context and generated volume obscured obligations

The [tool-surface economy audit](docs/research/2026-07-11-tool-surface-token-economy-audit.md) found individual responses exceeding 150,000 tokens, repeated prompt bodies, unbounded review payloads, and the same facts serialized several times. This was not only a cost problem. Large contexts made it harder to preserve distinctions, locate missing obligations, and review changes accurately.

## Principles

### 1. Enforce invariants at one authoritative boundary

An invariant should be enforced at the narrowest boundary through which every relevant action must pass. Examples include a state-transition function, persistence adapter, merge admission service, schema validator, or deployment controller.

Structural mechanisms:

- make invalid states unrepresentable where practical;
- expose one mutation path for each protected state;
- reject bypasses at the boundary, not through caller discipline;
- generate model-facing affordances from the same state machine;
- keep authorization outside the model.

This principle includes design patterns only when the pattern protects a real invariant. Cosmetic uniformity does not justify a global constraint.

### 2. Generate contracts instead of synchronizing copies

Input and output contracts should be versioned and generated from one intermediate representation whenever possible. The generated surface may include runtime validators, static types, CLI help, tool schemas, fixtures, examples, and compatibility tests.

When generation is not possible:

- assign one source of truth;
- declare which artifacts are derived;
- install a drift check;
- fail loudly when a consumer cannot interpret a new version;
- preserve unknown fields instead of silently coercing them.

Contract generation reduces shape drift. It does not prove semantic correctness, so each important contract still needs at least one behavioral oracle.

### 3. Define completion by the ship path

A feature is complete only when production-shaped evidence proves that the intended entry point reaches the intended outcome.

The minimum evidence should exercise the relevant combination of:

- the real public entry point;
- the composition root and dispatch path;
- transport or process boundaries;
- persistence and replay;
- authorization and negative paths;
- restart or recovery behavior;
- external side effects;
- the generated or packaged artifact that will ship.

Unit tests answer whether a component behaves locally. Ship-path tests answer whether the feature exists as experienced by a caller. Both are necessary, but they prove different claims.

### 4. Treat generated output as untrusted input

Model output is nondeterministic and may be plausible without being valid. Code, commands, SQL, file paths, URLs, configuration, tool arguments, and claims of completion should cross deterministic validation boundaries before they can cause effects.

Use:

- typed schemas and parsers;
- allowlists and capability checks;
- parameterized operations;
- path confinement;
- deny-by-default permissions;
- resource and retry budgets;
- sandboxed execution;
- explicit confirmation for consequential actions.

OWASP's guidance on [improper output handling](https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/) and [excessive agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) treats this as a security boundary, not a prompting problem.

### 5. Separate creation from judgment

The producer of a change should not be the sole authority that the change is correct. Self-review is useful for repair, but it is weak evidence because the producer and evaluator share assumptions and context.

Independent judgment can come from:

- tests written from the external contract;
- a separate evaluator with limited access to the producer's reasoning;
- static and dynamic analysis;
- differential or property-based tests;
- human review for high-impact decisions;
- policy engines that evaluate structured evidence.

Independence is about failure diversity, not merely launching another instance of the same model with the same prompt and context.

### 6. Scale autonomy and assurance with risk

There should be no single autonomy setting for every task. The allowed tools, approval requirements, verification depth, and rollback preparation should depend on consequence and reversibility.

Higher assurance is warranted when a change affects:

- authentication, authorization, secrets, or identity;
- destructive data operations or migrations;
- public APIs and compatibility;
- production infrastructure or deployment;
- supply-chain metadata and signing;
- safety, privacy, financial, or legal obligations;
- broad architectural boundaries.

Low-risk, reversible work can use broader autonomy. High-impact work needs narrower capabilities, independent approval, stronger evidence, and a tested rollback path. This follows the risk-management approach in [NIST AI RMF 1.0](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-ai-rmf-10) and the secure-development controls in [NIST SSDF](https://csrc.nist.gov/pubs/sp/800/218/final).

### 7. Bind evidence to the exact subject checked

An approval, test result, or scan is meaningful only if the system can identify what it evaluated.

Evidence should record:

- source revision and diff;
- artifact or content digest;
- producer and tool version;
- policy or test-suite version;
- execution environment;
- timestamp and expiry;
- relevant inputs and parameters;
- result and failure classification.

Mutable fields such as `approved: true` are not durable proof. Evidence should be append-only or tamper-evident and should be revalidated when the subject or policy changes. SLSA makes the same distinction between producing provenance and [verifying it against explicit expectations](https://slsa.dev/spec/v1.2/verifying-artifacts).

### 8. Design side effects for concurrency and recovery

Agentic systems behave like distributed systems. They retry, overlap, lose context, outlive processes, and encounter partial failure.

Protected side effects should use:

- idempotency keys scoped to the actual operation;
- optimistic concurrency control or equivalent atomic admission;
- durable intent before external effects;
- bounded retries with typed retry classes;
- compensation or reconciliation;
- deterministic replay;
- explicit ownership and leases;
- recovery tests that start from interrupted states.

Event sourcing, queues, or workflow engines help only when these properties are tested.

### 9. Make isolation and lineage explicit

Every delegated task should declare:

- its base commit or branch;
- its allowed filesystem and network scope;
- the state it may read and write;
- whether it may inherit prior task output;
- its merge target and ancestry requirements;
- cleanup and recovery ownership.

Isolation should prevent accidental interference without blocking intentional dependency flow. A new workspace is not enough if its base is wrong, shared state remains writable, or the merge path cannot prove ancestry.

### 10. Bound context, change size, and evidence volume

Context is a constrained interface, not an unlimited transcript.

Use:

- compact defaults with explicit detail expansion;
- pagination and field selection;
- structured state outside the model context;
- progressive disclosure;
- summaries that link to durable evidence;
- small, reviewable changes;
- event and diagnostic volume budgets;
- deduplication at the source.

Anthropic's [context engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) recommends curating the smallest high-signal context needed for the next decision. OpenAI's [harness engineering account](https://openai.com/index/harness-engineering/) similarly treats repository legibility and mechanical feedback as part of the development environment.

### 11. Treat gates as production software

A gate needs its own correctness model, tests, observability, and operating budget.

Every consequential gate should prove:

1. it runs for every protected path;
2. it checks the intended revision, workspace, and artifact;
3. its positive result can be killed by a known bad fixture;
4. command failures propagate;
5. execution is bounded;
6. skipped and unavailable states are visible;
7. evidence is current and subject-bound.

Gate results should be three-state:

- **pass:** evidence supports promotion;
- **fail:** evidence contradicts promotion;
- **indeterminate:** the check did not produce trustworthy evidence.

For consequential actions, both fail and indeterminate block promotion. Indeterminate should report infrastructure remediation rather than masquerading as a product defect. The [phase-gate redesign research](docs/research/2026-07-21-phase-gate-redesign-strategy.md) develops this model in detail.

### 12. Convert repeated findings into ratchets

The first occurrence of a defect may require judgment. A repeated occurrence is evidence that the environment permits the defect class.

After an incident, escaped defect, or repeated review comment:

1. identify the violated invariant;
2. locate the earliest authoritative enforcement point;
3. add a regression fixture that proves the old failure;
4. add the narrowest structural control;
5. verify the control with a kill probe;
6. record an owner and removal condition for any temporary exception.

The target is not more rules. It is fewer recurring decisions.

### 13. Measure outcomes, not generated activity

Lines changed, tasks attempted, tokens consumed, acceptance rate, and benchmark score are activity measures. They can improve while delivered quality declines.

Measure:

- lead time to a verified outcome;
- escaped defect and recurrence rates;
- review and rework time;
- rollback frequency and recovery time;
- change failure rate;
- production-path coverage;
- gate false-positive, false-negative, and indeterminate rates;
- context and evidence volume;
- percentage of high-impact actions with independent approval;
- percentage of shipped artifacts with verified provenance.

The 2025 METR randomized trial found experienced open-source developers took 19 percent longer on the studied tasks when using then-current AI tools, despite expecting large speedups. The study is small and narrow, but it demonstrates that perceived acceleration is not reliable evidence of end-to-end productivity. See [METR's study and limitations](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/).

Benchmark results also need careful interpretation. [SWE-bench Verified](https://www.swebench.com/verified.html) improved task clarity through human validation, but benchmark success still does not prove maintainability, security, deployment fitness, or performance on long-horizon changes.

## Operating model

### Before work starts

- assign a risk tier;
- define the external outcome and prohibited effects;
- select one source of truth for each contract;
- declare the workspace, base revision, capabilities, budgets, and approvals;
- define what evidence will constitute completion.

### While work runs

- keep state outside transient model context;
- constrain tools and side effects;
- make small, reversible changes;
- capture deterministic facts automatically;
- stop or reconcile on ambiguous ownership, stale state, or failed preconditions.

### Before promotion

- run production-path verification;
- obtain independent judgment proportional to risk;
- verify that all gates ran against the intended subject;
- bind evidence to the source and artifact digest;
- reject missing or indeterminate evidence on protected paths.

### After promotion

- preserve provenance and decision records;
- monitor escaped defects, rework, and recovery;
- perform root-cause analysis on failures and near misses;
- convert repeated findings into structural controls;
- remove controls that no longer pay for their complexity.

## Implications for the original seeds

The initial ideas remain valid, with tighter definitions:

1. **Enforce invariants structurally by construction.** Put each invariant at one authoritative boundary. Prefer types, schemas, generated code, policy, and state-machine admission over repeated instructions.
2. **Version and generate API contracts.** Generate both input and output surfaces from one source, publish compatibility rules, and retain a semantic oracle.
3. **Solve incomplete wiring through ship-path verification.** Require evidence that the public entry point crosses the real composition root and produces the intended durable and external effects. Component existence and unit coverage are not completion criteria.

## Research limits

- The repository evidence comes from one project with a concentrated contributor and reviewer population. Its patterns are strong signals, not universal incidence rates.
- Pull-request bodies often contain generated self-reports. Independent review findings, follow-up issues, regression tests, and audits were weighted more heavily.
- The METR randomized trial is causal but small and limited to experienced contributors working in mature repositories with 2025-era tools.
- Most laboratory and vendor guidance is practitioner evidence, not a controlled comparison.
- Coding benchmarks measure constrained task performance. They do not establish production safety or organizational productivity.

## Selected sources

### Repository evidence

- [E2E testing strategy](docs/research/2026-04-19-e2e-testing-strategy.md)
- [Event-sourced task-store audit](docs/research/2026-05-16-event-sourced-task-store-audit.md)
- [Methodology drift audit](docs/research/2026-06-21-methodology-drift-audit.md)
- [Tool-surface token economy audit](docs/research/2026-07-11-tool-surface-token-economy-audit.md)
- [Phase-gate redesign strategy](docs/research/2026-07-21-phase-gate-redesign-strategy.md)
- [PR #1424](https://github.com/lvlup-sw/exarchos/pull/1424), [issue #1436](https://github.com/lvlup-sw/exarchos/issues/1436), and [issue #1451](https://github.com/lvlup-sw/exarchos/issues/1451): present versus working
- [Issue #1370](https://github.com/lvlup-sw/exarchos/issues/1370) and [issue #1696](https://github.com/lvlup-sw/exarchos/issues/1696): prose and contract drift
- [Issue #1701](https://github.com/lvlup-sw/exarchos/issues/1701) and [issue #1721](https://github.com/lvlup-sw/exarchos/issues/1721): unreliable gates
- [Issue #1301](https://github.com/lvlup-sw/exarchos/issues/1301) and [issue #1526](https://github.com/lvlup-sw/exarchos/issues/1526): isolation and lineage

### External evidence and standards

- METR, [Measuring the impact of early-2025 AI on experienced open-source developer productivity](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/), 2025
- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), 2024
- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), 2025
- OpenAI, [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/), 2026
- NIST, [AI Risk Management Framework 1.0](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-ai-rmf-10), 2023
- NIST, [Secure Software Development Framework 1.1](https://csrc.nist.gov/pubs/sp/800/218/final), 2022
- OWASP, [Top 10 for LLM Applications 2025](https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/)
- SLSA, [Specification 1.2](https://slsa.dev/spec/v1.2/), 2025
- SWE-bench, [Verified dataset](https://www.swebench.com/verified.html)