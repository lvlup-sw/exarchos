# Convergence Dimensions — Detailed Criteria

## Dimension 1: Specification Fidelity & TDD Compliance

Every requirement in the design doc must trace to implementation code and a test that exercises it. Implementation without specification is scope creep; specification without implementation is incomplete work.

**Provenance chain:** If the pipeline maintained provenance metadata (requirement IDs in design -> task mappings in plan -> provenance events from delegation), query the provenance view first for a deterministic coverage check before constructing the traceability matrix manually.

### Qualitative Evals

| Criterion | Rubric | Severity |
|-----------|--------|----------|
| Requirement coverage | Build a `Requirement -> File:Line -> Test` traceability matrix. Every row must have all three columns populated. Missing test = HIGH. Missing impl = HIGH. | HIGH |
| Spec deviation | Diff implementation against design doc. Additions not in spec = scope creep (MEDIUM). Omissions from spec = incomplete (HIGH). | MEDIUM/HIGH |
| Edge case coverage | For each public function: happy path, error path, boundary values, null/empty inputs. Missing error path = MEDIUM. Missing boundary = LOW. | MEDIUM/LOW |
| Property-based tests | Behavioral properties (idempotency, commutativity, invariants) should have PBT alongside example tests. Missing PBT for stateful operations = MEDIUM. | MEDIUM |

---

## Dimension 2: Architectural Pattern Compliance

Each pattern the feature touches must be faithful to its canonical definition. Deviations must be justified and documented.

### Event Sourcing (Microsoft Learn canonical)

| Invariant | Eval Method | Severity |
|-----------|-------------|----------|
| Append-only store | Grep for `update`, `delete`, `splice` on event JSONL files. Any mutation = HIGH. | HIGH |
| Events are self-describing | Each event: `type`, `timestamp`, `correlationId`, `causationId`, `agentId`, `source`, `payload`. Missing metadata = MEDIUM. | MEDIUM |
| State derivable from events | Every `.state.json` or view field reconstructable by replaying events from seq 0. Underivable state = HIGH. | HIGH |
| Compensating events | Undo via compensating events, not mutation. Direct mutation for undo = HIGH. | HIGH |
| Event versioning | Schema changes use versioned types or multi-version handlers. Breaking change without version = HIGH. | HIGH |
| Idempotency | Event handlers safe to re-execute. Missing idempotency guard = MEDIUM. | MEDIUM |
| Snapshot strategy | If stream exceeds 1,000 events, verify snapshot/compaction. Missing strategy = MEDIUM. | MEDIUM |

### CQRS (Microsoft Learn canonical)

| Invariant | Eval Method | Severity |
|-----------|-------------|----------|
| Read paths hit views | No direct event iteration + inline aggregation in read paths. Raw event scan = HIGH. | HIGH |
| Write paths through commands | State mutations via command -> event -> materializer. Direct state writes = HIGH. | HIGH |
| Views are rebuildable | Rebuild/rematerialize and compare. Divergence = HIGH. | HIGH |
| Eventual consistency handled | Reads must tolerate stale data. Read-after-write without wait = MEDIUM. | MEDIUM |

### HSM (agentic-workflow-theory)

| Invariant | Eval Method | Severity |
|-----------|-------------|----------|
| Guard functions are pure | No I/O, state mutation, or event emission. Impure guard = HIGH. | HIGH |
| All transitions guarded | Every transition has explicit guard predicate. Unguarded = MEDIUM. | MEDIUM |
| Terminal states reachable | From every non-terminal state, path to COMPLETE/FAILED exists. Unreachable terminal = HIGH. | HIGH |
| Invalid transitions impossible | Transition table rejects invalid transitions. Accepted invalid = HIGH. | HIGH |

### Saga (optimize.md)

| Invariant | Eval Method | Severity |
|-----------|-------------|----------|
| Compensation is idempotent | Each compensating action safe to re-execute. Non-idempotent = HIGH. | HIGH |
| Checkpoint cleanup | Saga checkpoints removed after success. Orphaned = LOW. | LOW |

### Adversarial Gate Integration (adversarial-convergence-theory)

| Invariant | Eval Method | Severity |
|-----------|-------------|----------|
| Gate results emit `gate.executed` events | Every gate check emits event with `gateName`, `layer`, `passed`, `details`. Console-only = MEDIUM. | MEDIUM |
| Gate logic via orchestrate actions | Gate checks run through `exarchos_orchestrate`. Direct script invocation with manual event emission = MEDIUM. | MEDIUM |
| Provenance chain maintained | DR-N identifiers -> `Implements: DR-N` -> `task.provenance` events -> provenance view. Broken chain at review->synthesize = HIGH. | MEDIUM/HIGH |
| Advisory gates don't block | Gates at auto-chain boundaries are advisory-only. Blocking gate at auto-chain = HIGH. | HIGH |
| Readiness views for complex gates | Multi-event gates use CQRS readiness projections. One-shot gates may use direct orchestrate. | MEDIUM |

**Canonical gate integration pattern:**
```
Skill -> exarchos_orchestrate({ action: "<gate>", featureId, ... })
  -> Handler runs check logic
  -> Handler emits gate.executed event
  -> Handler returns { passed, findings, advisory }
  -> Skill presents findings and gates on result
```

Skills NEVER: parse script stderr, manually construct event payloads, or call `exarchos_event` directly for gate results.

### Platform Agnosticity (platform-agnosticity-spike)

The MCP tool layer must be self-contained. Any MCP client (Cursor, Copilot CLI, etc.) must be able to operate workflows correctly using only the tool's own introspection surface — `describe`, playbooks, and error messages. The content layer (skills, commands, rules) provides first-class Claude Code support but must never be **required** for correct mechanical operation.

| Invariant | Eval Method | Severity |
|-----------|-------------|----------|
| Schema discoverability | Every state field accepted by `set` has its shape discoverable via `describe`. Generic `{type: "object"}` for nested schemas (worktrees, tasks, reviews) = MEDIUM. | MEDIUM |
| Playbook self-sufficiency | Each phase's `compactGuidance` includes prerequisite actions, tool ordering, and gate requirements. Agent needing content-layer docs for mechanical steps = HIGH. | HIGH |
| Error actionability | Every error response includes what failed, why, and what to do next. Agent needing trial-and-error to discover requirements (e.g., sequential gate failures) = MEDIUM. | MEDIUM |
| Registration completeness | Every action handled by a composite handler has a corresponding schema in the registry. Handler reachable but schema missing = HIGH. | HIGH |
| Introspection consistency | `slimDescription` action lists, `describe` output, and composite handler cases must be consistent. Missing or phantom actions = MEDIUM. | MEDIUM |

**Boundary rule:** The content layer may _enhance_ the experience (decision frameworks, escalation heuristics, anti-patterns) but the mechanical layer (schemas, phases, guards, events, error messages) must be sufficient for correct operation without it.

---

## Dimension 3: Context Economy & Token Efficiency

Every byte in a tool response, event payload, or skill body consumes finite agent context window.

### Quantitative Evals

| Metric | Threshold | Severity |
|--------|-----------|----------|
| MCP tool response size | >4KB review, >8KB flag | MEDIUM |
| Event payload size | >2KB review, >4KB flag | MEDIUM |
| SKILL.md word count | >1,600 words = HIGH | HIGH |
| Unbounded arrays in views | Unbounded growing array = HIGH | HIGH |
| Inline content in commands | Inlined skill content = MEDIUM | MEDIUM |

### Progressive Disclosure Audit

| Level | Check | Pass Criterion |
|-------|-------|----------------|
| L1: Frontmatter | Description follows `[What] + [When] + [Capabilities]`, under 1,024 chars, includes trigger phrases | All fields present and conformant |
| L2: SKILL.md body | Core instructions only — no templates, checklists, or code blocks that belong in references | Body focused on workflow steps |
| L3: references/ | Templates, guides, and examples linked from body, not eagerly loaded | Content accessible on demand |

### Budget-Aware Design

| Criterion | Severity |
|-----------|----------|
| Tool responses offer `compact` vs `full` detail levels | MEDIUM |
| Reference IDs over embedded objects (no deep nesting >2 levels) | MEDIUM |
| Scarcity signaling for long-running workflows | LOW |

---

## Dimension 4: Operational Resilience

The system must perform correctly under real-world conditions.

### Deterministic Evals

| Check | Pass Criterion | Severity |
|-------|----------------|----------|
| I/O efficiency | Read paths use sequence-based pre-filtering before `JSON.parse` | MEDIUM |
| Cache bounds | Every in-memory cache has `maxSize` or eviction policy | HIGH |
| Concurrency safety | Single-instance assumption enforced (PID lock, mutex) | MEDIUM |
| Sequence initialization | Reads current max from store, not assume 0 | HIGH |
| CAS loop exhaustion | Optimistic retries have max iteration + actionable error | HIGH |
| Zod on hot paths | Schema validation at boundaries only, not internal calls | LOW |
| Error messages | Every `catch` states: what failed, why, what to do next | MEDIUM |

### Event Sourcing Operational Concerns

| Concern | Severity |
|---------|----------|
| Eventual consistency tolerance — UI/API handles stale reads | MEDIUM |
| No circular event logic (unbounded event loop) | HIGH |
| Event ordering via sequence numbers with conflict detection | HIGH |
| View rebuild time <5s or snapshot strategy exists | MEDIUM |

---

## Dimension 5: Workflow Determinism & Variance Reduction

Good feature work constrains the action space — each design decision narrows the probability distribution of agent outputs toward correct behavior.

### Discriminative over Generative

| Criterion | Severity |
|-----------|----------|
| Selection via classification (fixed enum sets, not free-form text) | MEDIUM |
| Structured outputs (typed schemas, not freeform strings) | MEDIUM |

### Deterministic Validation

| Criterion | Severity |
|-----------|----------|
| Validation via scripts with exit codes, not prose instructions | HIGH |
| Explicit quality criteria with concrete termination conditions | HIGH |
| Gate checks at every phase boundary | MEDIUM |
| Graduated gate depth matching boundary requirements | MEDIUM |

### Workflow Pattern Adherence

| Pattern | Key Checks |
|---------|------------|
| Sequential orchestration | Explicit step ordering, dependencies, validation at each stage, rollback |
| Multi-MCP coordination | Phase separation, explicit data passing, validation gates between phases |
| Iterative refinement | Quality criteria, validation scripts, termination conditions, iteration cap |
| Context-aware tool selection | Decision criteria, fallback options, transparency about choices |

### Workflow Integration

| Criterion | Severity |
|-----------|----------|
| Trigger discrimination (>90% precision, >90% recall on test queries) | HIGH (<80% precision) |
| No trigger overlap between simultaneously loaded skills | MEDIUM |
| Session consistency (identical structure across 3 runs) | HIGH |
| Checkpoint fidelity (no degradation after save/reload/resume) | MEDIUM |
| Overhead justification (skill cost justified vs ad-hoc) | LOW |
