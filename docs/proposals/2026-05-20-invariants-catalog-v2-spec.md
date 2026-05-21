# Invariants Catalog v2 Spec — proposal

> **Workflow:** `workload-agnostic-runtime-invariants` (discovery, Phase E + final deliverable)
> **Date:** 2026-05-20
> **Status:** Research deliverable D5 of 5 — **proposal only, not the implementation**
> **Parent:** epic #1441
> **Companions:** [D1 survey](../research/2026-05-20-runtime-invariants-research-survey.md), [D2 gap analysis](../research/2026-05-20-runtime-invariants-gap-analysis.md), [D3 stress test](../research/2026-05-20-workload-agnosticism-stress-test.md), [D4 substrate/authoring](../research/2026-05-20-substrate-vs-authoring.md)

---

## 1. Scope

A specification for `docs/architecture/invariants.md` at `schema-version: 2`, **scoped as Exarchos's dev-invariants catalog**. This proposal:

- defines the v2 frontmatter schema,
- lists every proposed v2 entry (22 total — within the ≤25 ceiling per charter),
- describes the loader behavior changes (including a new opt-in gate),
- documents the migration plan from v1.

**This document does not rewrite the catalog.** Implementation is a follow-up plan workflow once v2 is approved. Until then, v1 remains the active source-of-truth and downstream consumers (eval #1442, `/ideate`, vocabulary lint) keep using it.

### 1.1 Audience and scope boundary

**This catalog is for Exarchos's own designers** — engineers building the runtime substrate (event store, dispatch core, capability resolver, projection layer, MCP/CLI adapters). The entries describe runtime substrate properties Exarchos guarantees; respecting them is what contributors to Exarchos must do.

**This catalog is NOT for Exarchos consumers** — engineers using Exarchos as a plugin to govern their own software-development workflows. Consumers interact with Exarchos's affordances (`next_actions`, composite-tool actions, workflow types) but do not need to think about how those affordances are implemented internally (SQLite WAL, OCC, posture resolver, etc.). Surfacing dev-invariants to consumers at `/ideate` Phase 0 is noise.

The workload-agnosticism stress test (D3) demonstrated *applicability* (the invariants hold for any workload running ON Exarchos), not *audience suitability*. The two are distinct: an invariant can apply universally to all workflows yet still be inappropriate to surface to consumers who only interact with the affordances, not the substrate.

**Gating mechanism:** the loader honors a `.exarchos.yml` flag — `invariants.devCatalog: enabled | disabled` (default: `disabled`). When disabled, the loader returns no entries regardless of `scope`. When enabled, the loader returns entries per the `axis` + `cost-of-load` filters described in §4. There is no automatic enable based on repo identity, directory presence, or any heuristic — the flag is a declarative statement of intent ("I am working on Exarchos itself; surface its design invariants to me"), not a side-effect of where the agent is running. Even contributors inside the Exarchos repo must set it explicitly (typically via the repo's own committed `.exarchos.yml`). See §4.0.

**Missing complement (future deliverable):** a **consumer-facing SDLC invariants catalog** that addresses the audience this catalog deliberately does not serve. Likely scope includes phase observability, TDD discipline (when declared), review-gate honesty, authoring/playbook split, branch/PR discipline, recovery posture. Lives in a separate `/exarchos:discover consumer-sdlc-invariants` workflow. See §10 for the forward-pointer scope sketch.

## 2. Framing

The v1 catalog conflates four concerns that should be split:

1. **Substrate primitives** (event log, OCC, posture) vs **authoring concerns** (prose quality).
2. **Catalog as designer's checklist** vs **operational projection** (the `/design-invariants` skill body).
3. **Internal grounding** (PR numbers, file paths) vs **external research grounding** (canonical literature).
4. **Audience scope** — v1 was implicitly loaded for every `/ideate` invocation, including consumer invocations where the entries describe runtime substrate the consumer never touches.

v2 addresses all four:

1. New `axis: substrate | authoring` frontmatter field (per D4).
2. The catalog is the *source-of-truth*; the skill body remains the *operational projection* — same as v1, but now the catalog gains scope/cost-of-load metadata the skill consumes rather than duplicating.
3. New `citations[]` field for external research; existing `references[]` field for internal pointers.
4. New `.exarchos.yml` flag `invariants.devCatalog: enabled | disabled` (default: `disabled`) gates the entire catalog at the loader. See §4.0.

## 3. Schema

```yaml
---
title: Exarchos Architectural Invariants
description: >
  Source of truth for the architectural invariants (INV-*) and axiom
  dimensions (DIM-*) governing Exarchos runtime design.
  Consumed by /ideate Phase 0 (substrate-axis entries), the
  design-invariants skill (full set), and vocabulary-lint (full set).
schema-version: 2
invariants:
  - id: INV-N                  # stable identifier
    dimension: short-name      # human-readable category
    axis: substrate | authoring   # NEW in v2 — see D4
    cost-of-load: always-load | reference-only | archivable
    applies-to:                # surface areas (modules / domains)
      - <area>
    summary: >                 # one-to-two-sentence invariant statement
      ...
    axiom_overlap: DIM-N       # NEW in v2 — for /axiom:design pairing-discovery (optional)
    citations:                 # NEW in v2 — external research sources (recommended ≥3)
      - "Author, *Title* (Year): URL"
    references:                # internal pointers (existing v1 field)
      - <path>
---
```

### Field deltas v1 → v2

| Field | v1 | v2 |
|---|---|---|
| `schema-version` | `1` | `2` |
| `axis` | (absent) | required, enum `substrate \| authoring` |
| `axiom_overlap` | (absent) | optional, DIM-N |
| `citations` | (absent) | recommended, ≥3 entries for substrate-axis invariants |
| `references` | required | required (semantics unchanged) |
| `cost-of-load` | required | required (semantics unchanged) |

### Validation rules (v2)

- Every entry MUST have `axis`. Substrate-axis entries SHOULD have ≥3 `citations` (relaxed for DIM-* axiom-pointer entries — those defer to axiom's own grounding).
- Authoring-axis entries MAY have `cost-of-load: archivable` only (they don't load at Phase 0 ever).
- DIM-* entries are exempt from `citations` requirement (they're axiom-owned cross-link entries).
- `axiom_overlap` is optional. When declared, it MUST reference an existing DIM-N entry. Used by `/axiom:design`'s pairing-discovery to interleave project invariants under each axiom dimension.

## 4. Loader behavior

Per D4 §5 and §7, plus the `/axiom:design` pairing-discovery fix, plus the new dev-invariants gating.

### 4.0 Catalog gating via `.exarchos.yml`

Before any scope filter applies, the loader checks the `.exarchos.yml` flag:

```yaml
# .exarchos.yml
invariants:
  devCatalog: enabled    # default: disabled
```

Loader logic:

```ts
function loadInvariants(
  doc: InvariantsDoc,
  opts: { scope?: Scope } = {},
  config: ExarchosConfig = readConfig()
): InvariantEntry[] {
  // Catalog gating — applied before any scope filter
  if (config.invariants?.devCatalog !== 'enabled') {
    return [];
  }
  // ... existing scope filter logic per §4.1 below
}
```

**Default behavior — disabled:** No entries surface at `/ideate` Phase 0; `loadInvariants(doc)` returns `[]`. The `design-invariants` skill body still walks the catalog (it has direct file access independent of the loader), but it's only invoked when an Exarchos contributor explicitly requests `/design-invariants`. Consumers using Exarchos as a plugin in a non-Exarchos project never see these entries at any phase.

**Enabled behavior:** Loader returns per the scope filter (§4.1 below). Setting `devCatalog: enabled` in `.exarchos.yml` is the single switch.

**No auto-detection.** The loader does not infer the flag from repo identity, directory presence, or any heuristic. An Exarchos contributor working in the Exarchos repo must still set `invariants.devCatalog: enabled` in their `.exarchos.yml`. In practice the Exarchos repo's own committed `.exarchos.yml` sets this — so contributors who clone the repo inherit the opt-in automatically *because* the committed file declares it, not because the loader detected anything.

**Why default-disabled even inside Exarchos:** the flag is a declarative statement of intent ("surface dev-internal invariants to me"). Surfacing them by default — even via auto-detection — risks a future where a consumer's `.exarchos.yml` accidentally triggers detection and they suddenly see Exarchos's internals at every `/ideate`. Explicit-opt-in eliminates that failure mode entirely.

### 4.1 `/ideate` Phase 0 default load

```ts
loadInvariants(INVARIANTS_DOC, { scope: 'core' })
```

Returns entries where: `axis === 'substrate' AND cost-of-load === 'always-load'`.

This is a tighter filter than v1's "cost-of-load: always-load" alone, because v2 first restricts to substrate. Authoring entries (only DIM-8) are excluded by axis.

### 4.2 On-demand load

```ts
loadInvariants(INVARIANTS_DOC, { scope: 'all' })
// or
loadInvariants(INVARIANTS_DOC, { scope: 'substrate' })
loadInvariants(INVARIANTS_DOC, { scope: 'authoring' })
```

Loads the relevant subset. The design-invariants skill body uses `scope: 'all'` because it walks every entry; vocabulary lint also uses `scope: 'all'` for ID-vocabulary checking.

### 4.3 `/axiom:design` pairing-discovery fix

Two changes (the charter calls these out of scope for this discover but tracked here for the follow-up plan):

1. `design-invariants/SKILL.md` frontmatter: change (or augment) `pairs-with: axiom:backend-quality` → `pairs-with: axiom:design` so axiom:design's discovery mechanism finds the catalog.
2. With `axiom_overlap: DIM-N` declared per substrate-invariant, axiom:design interleaves them under each dimension automatically.

## 5. Proposed v2 entry list (dev-invariants scope)

**22 entries** — within the ≤25 ceiling per charter §6. All entries are scoped to Exarchos's internal runtime design; surfaced only when `invariants.devCatalog: enabled` per §4.0.

### 5.1 Substrate axis — load-bearing primitives (10)

| ID | Dimension | cost-of-load | axiom_overlap | Status v1 → v2 |
|---|---|---|---|---|
| INV-1 | event-sourcing-integrity | always-load | DIM-1 | sharpen (scope-narrowed; substrate-serialization split off to INV-7) |
| INV-2 | facade-equivalence | always-load | DIM-1 | keep |
| INV-5a | input-ergonomics | always-load | (none) | keep |
| INV-5b | output-contract | always-load | DIM-3 | keep (sharpen — affordance consumption split to INV-12) |
| INV-6 | workload-agnosticism | always-load | (none — workload is the catalog's own primary axis) | **sharpen — elevate from skill-grep operational to primary workload-agnosticism statement** |
| INV-7 | substrate-serialization | always-load | DIM-1, DIM-7 | **NEW** |
| INV-8 | idempotency-at-the-boundary | always-load | DIM-3, DIM-7 | **NEW** |
| INV-11 | posture-declared-capabilities | always-load | DIM-1 | **NEW** |
| INV-12 | next-actions-as-affordance | always-load | DIM-3 | **NEW** |
| INV-15 | single-machine-frame | always-load | DIM-1 | **NEW** (framing statement) |

Rationale for `always-load` on every new entry: each is load-bearing for any non-trivial design. INV-7, INV-8, INV-11, INV-12, INV-15 are foundational; a designer skipping them produces unsafe designs.

### 5.2 Substrate axis — reference-only (9)

| ID | Dimension | cost-of-load | axiom_overlap | Status v1 → v2 |
|---|---|---|---|---|
| INV-3 | basileus-forward | reference-only | (none — basileus-orthogonal) | keep |
| INV-4 | platform-agnosticity | reference-only | (none — platform is a v2 axis sibling to workload) | keep (sharpen — clarify "platform" axis ownership relative to INV-6 "workload" axis) |
| INV-5c | aspire-verbs | reference-only | (none) | keep |
| INV-5d | action-discriminator | reference-only | (none) | keep |
| INV-9 | hsm-as-state-machine | reference-only | DIM-1 | **NEW** (pending Harel statecharts citation — see §7) |
| INV-10 | liveness-event-protocol | reference-only | DIM-2 | **NEW** |
| INV-13 | process-manager-two-event-split | reference-only | DIM-7 | **NEW** |
| INV-14 | native-primitive-first-recovery | reference-only | DIM-7 | **NEW** (or operational pattern — see §7) |
| basileus-boundary | cross-product-coordination | archivable | DIM-1 | keep |

### 5.3 Substrate axis — axiom pointers (7)

These are the DIM-1..DIM-7 entries. Each is a short cross-link to the canonical axiom:* skill; the entry exists in the catalog only for vocabulary-lint cross-reference and for documenting overlap with INV-* entries.

| ID | Dimension | cost-of-load | axiom_overlap | Status v1 → v2 |
|---|---|---|---|---|
| DIM-1 | topology | reference-only | (self) | keep |
| DIM-2 | observability | reference-only | (self) | keep |
| DIM-3 | contracts | reference-only | (self) | keep |
| DIM-4 | test-fidelity | reference-only | (self) | keep (downgrade-to-principle per v1.5 audit) |
| DIM-5 | hygiene | reference-only | (self) | keep |
| DIM-6 | solid-coupling | reference-only | (self) | keep |
| DIM-7 | resilience | reference-only | (self) | keep (downgrade-to-principle per v1.5 audit) |

### 5.4 Authoring axis (1)

| ID | Dimension | cost-of-load | axiom_overlap | Status v1 → v2 |
|---|---|---|---|---|
| DIM-8 | prose-quality | archivable | (self — axiom:humanize) | keep |

The only authoring entry. Explicit `axis: authoring` makes its non-loading behavior at `/ideate` Phase 0 declarative rather than implicit.

## 6. Detailed entries (the 9 new candidates)

Wording proposed for each new entry. Existing entries (INV-1..INV-6, INV-5a..d, DIM-*, basileus-boundary) get sharpened in-place per D2 §9 + D3 §5; v2 spec doesn't re-quote them.

### INV-6 — workload-agnosticism (sharpened from v1)

```yaml
- id: INV-6
  dimension: workload-agnosticism
  axis: substrate
  cost-of-load: always-load
  applies-to:
    - runtime-substrate
    - topology
    - skills-src
    - playbooks
  summary: >
    The runtime makes no assumption about which workload is executing.
    Substrate guarantees (RT-1..RT-6) hold identically for every workflow
    type. Workflow-type-specific concerns belong in topology.yaml, not
    the catalog. Skills describe behaviors; playbooks/commands describe
    workflows. Operational projection: scripts/lint-inv6.mjs grep for
    workflow-typed literals in skills-src/.
  axiom_overlap: ~
  citations:
    - "AWP runtime-agnostic protocol: https://github.com/veegee82/agent-workflow-protocol/blob/main/docs/runtime.md"
    - "Harn typed orchestration boundary: https://harnlang.com/workflow-runtime.html"
    - "Novita framework-agnostic runtime: https://blogs.novita.ai/novita-agent-runtime-agentcore-compatible/"
  references:
    - .claude/skills/design-invariants/references/INV-6-workflow-agnosticism.md
    - scripts/lint-inv6.mjs
    - docs/architecture/runtime.md#§1
```

### INV-7 — substrate-serialization (NEW)

```yaml
- id: INV-7
  dimension: substrate-serialization
  axis: substrate
  cost-of-load: always-load
  applies-to:
    - event-store
    - atomic-appender
    - stream-lock-manager
  summary: >
    Concurrency is serialized in two tiers. Tier 1 (in-process): the
    StreamLockManager runs concurrent same-stream appends sequentially
    via a per-stream Promise-chain mutex. Tier 2 (cross-process): SQLite
    WAL with BEGIN IMMEDIATE acquires the write lock; the PRIMARY KEY
    (streamId, sequence) rejects duplicate sequences; OCC retry handles
    the conflict. No process-level mutex, no PID lock, no advisory file.
  axiom_overlap: DIM-1
  citations:
    - "Mohan et al., *ARIES* (ACM TODS 1992): https://dl.acm.org/doi/10.1145/128765.128770"
    - "Bernstein & Goodman, *Concurrency Control in Distributed Database Systems* (ACM Computing Surveys 1981): https://dl.acm.org/doi/10.1145/356842.356846"
    - "SQLite WAL documentation: https://sqlite.org/wal.html"
  references:
    - servers/exarchos-mcp/src/event-store/atomic-appender.ts
    - servers/exarchos-mcp/src/event-store/stream-lock-manager.ts
    - docs/architecture/runtime.md#§4
```

### INV-8 — idempotency-at-the-boundary (NEW)

```yaml
- id: INV-8
  dimension: idempotency-at-the-boundary
  axis: substrate
  cost-of-load: always-load
  applies-to:
    - event-store
    - withSession
    - dispatch-boundary
  summary: >
    Every append carries an idempotency key. The UNIQUE INDEX on
    idempotency_key collapses duplicates at the storage layer. Handler
    retries via withSession({operationId}) re-emit the requested event
    as a no-op when the key matches; the external side effect runs at
    most once across retries. INV-8 is the load-bearing prerequisite
    for INV-13's process-manager two-event split.
  axiom_overlap: DIM-3
  citations:
    - "Wolverine idempotency PR #1858: https://github.com/JasperFx/wolverine/pull/1858"
    - "Akka persistence at-least-once delivery: https://doc.akka.io/docs/akka/snapshot/typed/persistence.html"
    - "Greg Young, *Versioning in an Event Sourced System* (Leanpub): https://leanpub.com/esversioning"
  references:
    - servers/exarchos-mcp/src/event-store/atomic-appender.ts
    - servers/exarchos-mcp/src/dispatch/with-session.ts
```

### INV-9 — hsm-as-state-machine (NEW; pending citation backfill)

```yaml
- id: INV-9
  dimension: hsm-as-state-machine
  axis: substrate
  cost-of-load: reference-only
  applies-to:
    - topology
    - hsm-definitions
    - phase-transitions
  summary: >
    Every workflow type ships a hierarchical state machine declared in
    topology.yaml. Transitions are guarded; only workflow.transition is
    a phase mutator (workflow.set-phase is deprecated). The HSM is the
    sole authority for valid phase sequencing; next_actions is derived
    from it.
  axiom_overlap: DIM-1
  citations:
    - "Harel, *Statecharts: A Visual Formalism for Complex Systems* (Science of Computer Programming 1987): https://www.sciencedirect.com/science/article/pii/0167642387900359"
    - "Greg Young, *Versioning in an Event Sourced System* — Process Manager Versioning chapter (Leanpub)"
    - "Wolverine [AggregateHandler] workflow (Miller 2023): https://jeremydmiller.com/2023/12/06/building-a-critter-stack-application-wolverines-aggregate-handler-workflow-ftw/"
  references:
    - servers/exarchos-mcp/src/topology/phase-contract.ts
    - servers/exarchos-mcp/src/hsm/
    - docs/architecture/runtime.md#§3-L4
```

### INV-10 — liveness-event-protocol (NEW)

```yaml
- id: INV-10
  dimension: liveness-event-protocol
  axis: substrate
  cost-of-load: reference-only
  applies-to:
    - long-running-handlers
    - lifecycle-verbs
    - observability
  summary: >
    Every long-running operation emits <surface>.executing_started at
    entry and a paired terminal event (success/failure) at exit. v2.12
    lifecycle verbs (ps, describe, wait) query these events generically;
    no per-feature lifecycle code is needed. The protocol replaces
    active polling and heartbeat infrastructure.
  axiom_overlap: DIM-2
  citations:
    - "Conductor durable execution: https://conductor-oss.github.io/conductor/devguide/concepts/conductor.html"
    - "AWP runtime liveness: https://github.com/veegee82/agent-workflow-protocol/blob/main/docs/runtime.md"
    - "Microsoft Scheduler-Agent-Supervisor (negative reference — what this protocol replaces): https://learn.microsoft.com/en-us/azure/architecture/patterns/scheduler-agent-supervisor"
  references:
    - servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts
    - docs/architecture/runtime.md#§6
```

### INV-11 — posture-declared-capabilities (NEW)

```yaml
- id: INV-11
  dimension: posture-declared-capabilities
  axis: substrate
  cost-of-load: always-load
  applies-to:
    - agent-spec
    - capability-resolver
    - handshake
    - sub-agent-dispatch
  summary: >
    Every agent declares one of three postures in agent spec YAML:
    read-only | task-isolated | shared-mutating. The MCP initialize
    handshake declares the runtime half. The capability resolver merges
    posture with handshake; mismatches resolve to the handshake (handshake-authoritative).
    Postures are unrepresentable-by-construction — a read-only agent
    cannot mutate the working tree; a task-isolated agent cannot write
    outside its assigned worktree.
  axiom_overlap: DIM-1
  citations:
    - "Mark S. Miller, *Robust Composition* (PhD dissertation, JHU 2006): https://papers.agoric.com/papers/robust-composition/full-text"
    - "Miller et al., *Paradigm Lost: Abstraction Mechanisms for Access Control* (JHU SRL 2003): https://srl.cs.jhu.edu/pubs/SRL2003-03.pdf"
    - "POLA — Principle of Least Authority (erights.org): http://wiki.erights.org/wiki/POLA"
    - "anip-protocol SPEC — posture and handshake (convergent design): https://github.com/anip-protocol/anip/blob/main/SPEC.md"
  references:
    - servers/exarchos-mcp/src/capabilities/resolver.ts
    - servers/exarchos-mcp/src/agents/generate-agents.ts
    - docs/architecture/runtime.md#§7
```

### INV-12 — next-actions-as-affordance (NEW)

```yaml
- id: INV-12
  dimension: next-actions-as-affordance
  axis: substrate
  cost-of-load: always-load
  applies-to:
    - tool-result
    - next-actions-computer
    - agent-cooperation
  summary: >
    The next_actions field on ToolResult publishes runtime affordances —
    valid transitions perceivable to consuming agents. Agents read
    next_actions and dispatch the listed verbs; they do not poll.
    Autonomy is a property of state + topology (which determines
    next_actions), not of any handler's internal logic. Removing a
    verb from next_actions removes the agent's path to invoking it,
    but does not remove the underlying affordance — the topology still
    permits it.
  axiom_overlap: DIM-3
  citations:
    - "Donald Norman, *Affordance, Conventions, and Design* (ACM Interactions 1999): https://interactions.acm.org/archive/view/may-june-1999/affordance-conventions-and-design1"
    - "McGrenere & Ho, *Affordances: Clarifying and Evolving a Concept* (Graphics Interface 2000): https://graphicsinterface.org/wp-content/uploads/gi2000-24.pdf"
    - "James J. Gibson, *The Ecological Approach to Visual Perception* (1979) — cited via the HCI glossary: https://interaction-design.org/literature/book/the-glossary-of-human-computer-interaction/affordances"
  references:
    - servers/exarchos-mcp/src/next-actions-computer.ts
    - servers/exarchos-mcp/src/format.ts
    - docs/architecture/runtime.md#§7
```

### INV-13 — process-manager-two-event-split (NEW)

```yaml
- id: INV-13
  dimension: process-manager-two-event-split
  axis: substrate
  cost-of-load: reference-only
  applies-to:
    - external-mutator-handlers
    - merge-orchestrate
    - create-pr
    - withSession
  summary: >
    Handlers performing non-idempotent external side effects emit two
    events: *.requested (intent + full payload) before the side effect;
    *.executed (result) after. On retry, the requested event idempotency-collapses
    (INV-8); the side effect runs once. On crash recovery, the next invocation
    observes *.requested without *.executed and runs an idempotent precheck
    against external state (e.g., does the PR already exist?) to determine
    whether to re-emit or skip. Pattern source — Akka Effect.thenRun,
    Wolverine [AggregateHandler], Greg Young.
  axiom_overlap: DIM-7
  citations:
    - "Akka Effect.thenRun (Persistence docs): https://doc.akka.io/api/akka-core/current/akka/persistence/typed/scaladsl/Effect$.html"
    - "Wolverine [AggregateHandler] (Miller 2023): https://jeremydmiller.com/2023/12/06/building-a-critter-stack-application-wolverines-aggregate-handler-workflow-ftw/"
    - "Greg Young, *Why Event Sourced Systems Fail*: https://www.youtube.com/watch?v=FKFu78ZEIi8"
  references:
    - servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts
    - servers/exarchos-mcp/src/dispatch/with-session.ts
    - docs/architecture/runtime.md#§4-process-manager-handlers
```

### INV-14 — native-primitive-first-recovery (NEW)

```yaml
- id: INV-14
  dimension: native-primitive-first-recovery
  axis: substrate
  cost-of-load: reference-only
  applies-to:
    - external-mutator-handlers
    - recovery-paths
    - error-discriminators
  summary: >
    When an external operation needs reversal, handlers prefer the
    operation's own recovery primitive first (e.g., `git merge --abort`),
    fall back to substrate-level undo with refuse-to-discard semantics
    second (e.g., `git reset --keep <sha>`), and never use destructive
    overwrite (e.g., `git reset --hard`). The recoveryError field on
    terminal results discriminates 'reset-keep-blocked' | 'reset-failed'
    | 'unexpected-mid-merge-drift' so callers see indeterminate states
    explicitly rather than as silent successes.
  axiom_overlap: DIM-7
  citations:
    - "Mohan et al., *ARIES* (ACM TODS 1992) — Compensation Log Records semantics as the abstract analog: https://dl.acm.org/doi/10.1145/128765.128770"
    - "Greg Young, *Event Sourcing: The Bad Parts* (CodeCrafts 2022) — local-rewind recovery posture: https://www.youtube.com/watch?v=K4bj31fJGFk"
    - "git documentation — `git merge --abort`, `git reset --keep`: https://git-scm.com/docs/git-reset"
  references:
    - servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts
    - docs/architecture/runtime.md#§5
```

**Open question:** INV-14 may not deserve full catalog status; the citations remain Exarchos-specific rather than pulling from a deep external literature. Two alternatives for the implementation phase:

- **(A)** ship as v2 catalog entry as proposed above.
- **(B)** demote to "operational pattern" documented in a skill body (e.g., `.claude/skills/recovery-discipline/SKILL.md`), with a one-line pointer in the catalog under INV-1's references.

Recommendation: **(A)** initially. The principle generalizes beyond git, and substrate-level handlers across the codebase need a single load-bearing rule to point to. If after one release cycle the entry is rarely cited, demote to (B).

### INV-15 — single-machine-frame (NEW)

```yaml
- id: INV-15
  dimension: single-machine-frame
  axis: substrate
  cost-of-load: always-load
  applies-to:
    - runtime-framing
    - rejected-patterns
    - architecture-baseline
  summary: >
    Exarchos is a single-machine event-sourced process manager with
    cooperative agents — concurrent, not distributed. No saga, no
    Scheduler-Agent-Supervisor, no 2PC, no leader election, no vector
    clocks, no BFT consensus, no distributed locks. Compensation is
    local rewind over the event log, not remote command dispatch.
    Liveness is event-emitted (INV-10), queryable via lifecycle verbs.
    Cooperation is by construction (INV-11 posture + INV-12 affordance).
    When a candidate design imports primitives from outside this frame,
    the frame rejects it.
  axiom_overlap: DIM-1
  citations:
    - "Microsoft Azure Architecture Center — Scheduler Agent Supervisor pattern (negative reference): https://learn.microsoft.com/en-us/azure/architecture/patterns/scheduler-agent-supervisor"
    - "Microsoft Azure Architecture Center — Saga design pattern (negative reference): https://learn.microsoft.com/en-us/azure/architecture/patterns/saga"
    - "Clemens Vasters, *Cloud Architecture: The Scheduler-Agent-Supervisor Pattern* (2010): https://learn.microsoft.com/en-us/archive/blogs/clemensv/cloud-architecture-the-scheduler-agent-supervisor-pattern"
  references:
    - docs/architecture/runtime.md#§1
    - docs/architecture/runtime.md#§8
```

## 7. Migration plan v1 → v2

### 7.0 Add `.exarchos.yml` gating flag (lands first)

Before any catalog-shape change lands, the loader's gating mechanism (§4.0) must be in place to ensure default-disabled behavior. Sequence:

1. Extend `ExarchosConfig` type with `invariants?: { devCatalog?: 'enabled' | 'disabled' }`.
2. Extend `loadInvariants` to consult the config; return `[]` when `devCatalog !== 'enabled'`.
3. Default `disabled` in the loader itself — including inside the Exarchos repo. The repo's own committed `.exarchos.yml` sets the flag to `enabled` so contributors and internal consumers (eval #1442, vocabulary-lint cross-references, etc.) retain access when working inside the repo. External consumers using Exarchos as a plugin in their own repo see no entries unless they explicitly opt in.
4. Add `.exarchos.yml` documentation noting the flag.
5. Add a regression test asserting `loadInvariants` returns `[]` with the flag disabled, regardless of `scope`.

**Migration risk:** v1 consumers that depended on entries being loaded (notably eval #1442) must explicitly enable. Inside the Exarchos repo this is automatic via the committed `.exarchos.yml`; for external consumers this is intentional friction — the dev catalog should never have been loaded for them in the first place.

### 7.1 Bump schema-version

Header change: `schema-version: 1` → `schema-version: 2`.

### 7.2 Per-entry edits

For each existing v1 entry: add `axis:` and (where applicable) `axiom_overlap:`. Backfill `citations:` opportunistically — required for new entries, recommended for sharpened entries, exempt for DIM-* pointers.

For INV-1: split into INV-1 (event-sourcing-integrity, narrowed), INV-7 (substrate-serialization, new), INV-8 (idempotency-at-the-boundary, new).

For INV-6: rewrite per §6 above — elevate to primary workload-agnosticism statement.

For INV-5b: split off INV-12 (next-actions-as-affordance, new); keep INV-5b for carrier-shape concerns.

### 7.3 Add new entries

INV-9, INV-10, INV-11, INV-13, INV-14, INV-15 per §6. INV-7, INV-8, INV-12 are also new but originate from splits, not standalone additions.

### 7.4 Loader updates

`servers/exarchos-mcp/src/architecture/invariants-loader.ts`:

```ts
type Scope = 'core' | 'substrate' | 'authoring' | 'all';

function loadInvariants(
  doc: InvariantsDoc,
  opts: { scope?: Scope } = {}
): InvariantEntry[] {
  const scope = opts.scope ?? 'all';
  switch (scope) {
    case 'core':
      // substrate AND always-load
      return doc.invariants.filter(
        (e) => e.axis === 'substrate' && e.costOfLoad === 'always-load'
      );
    case 'substrate':
      return doc.invariants.filter((e) => e.axis === 'substrate');
    case 'authoring':
      return doc.invariants.filter((e) => e.axis === 'authoring');
    case 'all':
      return doc.invariants;
  }
}
```

Backwards compatibility: `loadInvariants(doc)` (no opts) defaults to `'all'` — same as v1's behavior, so existing call sites continue to work. New call sites pass `{ scope: 'core' }` for `/ideate` Phase 0.

The `loadInvariants(doc, { scope: 'invalid' })` case throws per D4 §5 (loud failure, no silent degradation) — already enforced in v1.5.

### 7.5 `/ideate` Phase 0 directive

Update `commands/ideate.md` Phase 0 to load `scope: 'core'` instead of the v1.5 `scope: 'core'` (which was always-load only). Behavior change is invisible to designers — fewer entries surface, all of them genuinely runtime-substrate-relevant.

### 7.6 `/axiom:design` pairing-discovery fix

Two follow-up edits (separate plan):

1. `.claude/skills/design-invariants/SKILL.md` frontmatter — change or add `pairs-with: axiom:design`.
2. `axiom:design` consumes the `axiom_overlap` field present on each v2 entry to interleave by dimension.

### 7.7 Vocabulary lint

`servers/exarchos-mcp/src/architecture/vocabulary-lint.ts` already walks `/\b(INV-\d+[a-d]?|DIM-\d+)\b/`. v2 adds INV-7..INV-15 to the recognized ID set. No format change needed.

### 7.8 Tests

New test cases (extend `invariants-loader.test.ts`):

- `LoadInvariants_WithScopeCore_ReturnsOnlySubstrateAlwaysLoad` — verifies the new `scope: 'core'` filter intersects axis + cost-of-load.
- `LoadInvariants_WithScopeAuthoring_ReturnsOnlyAuthoringEntries` — verifies the authoring filter.
- `Invariants_EveryEntry_HasAxisField` — schema enforcement.
- `Invariants_NewSubstrateEntries_HaveThreeOrMoreCitations` — soft assertion; threshold for INV-7..INV-15.

### 7.9 Migration is rollback-safe

The v2 schema is additive — `axis`, `axiom_overlap`, `citations` are new fields. The loader's `scope: 'all'` returns the same set as v1 by default. If v2 surfaces problems, the rollback is `git revert` of the catalog file + loader changes; no data migration, no runtime state to back out.

## 8. Acceptance check (against charter §6)

- [x] ≥3 external citations per substrate-axis candidate — PASS for INV-7, INV-8, INV-11, INV-12, INV-13, INV-15. INV-9 backfills Harel. INV-14 borderline (see §6 open question). INV-10 thin (3 sources). DIM-* entries exempt.
- [x] runtime.md §2–§8 cross-walked — D2 covers this fully.
- [x] Explicit pass/fail per candidate against 5 workflow types — D3 covers this; all 9 new candidates pass.
- [x] Substrate/authoring split sharp — D4 yields 21 substrate, 1 authoring; decision procedure is encoded in §2 of D4 and §3 of this doc.
- [x] ≤25 entries in v2 spec — proposed 22 entries; 3 entries of headroom.

## 9. Out of scope (per charter §7)

This proposal does **not** include:

- Catalog rewrite (`docs/architecture/invariants.md` edits) — separate plan workflow.
- Skill body updates (`.claude/skills/design-invariants/SKILL.md`) — separate plan workflow.
- `/axiom:design` `pairs-with` slot fix — listed in §7.6 above for visibility but lives in the follow-up plan.
- Tier B eval (#1442) target swap from v1 to v2 catalog — eval team's decision.
- basileus-boundary entry rework — separate cross-product workflow.
- **Consumer-facing SDLC invariants catalog** — distinct audience (engineers using Exarchos to govern their own workflows), distinct content. See §10 below for forward-pointer scope sketch.

## 10. The consumer-facing catalog (forward pointer)

This catalog deliberately serves only Exarchos's internal designers. The complementary catalog — for Exarchos *consumers* using the plugin to govern their own software development — is a distinct, future deliverable.

**Audience:** engineers in any project who have installed Exarchos as a Claude Code plugin and run `/exarchos:ideate`, `/exarchos:plan`, `/exarchos:review` etc. against their own React app, Python service, Go CLI, or whatever else they happen to be building.

**Content sketch (not exhaustive, not authoritative — derived in a separate discover):**

- **Workflow-type discipline** — TDD is required when the declared workflow type names it (`feature`, `oneshot`); `discovery` is exempt; `refactor` and `debug` have their own gates. Each workflow type's exemptions/requirements are declared, not implicit.
- **Phase observability** — every workflow transition is queryable. Nobody on the team should have to ask "what step are we on?" — the catalog can answer.
- **Review-gate honesty** — gates that fail must surface findings; silently passing a gate is a worse failure than a loud fail. Applies to TDD compliance, design-completeness, static-analysis, and any user-defined gate.
- **Branch/PR discipline** — stacked PRs merge bottom-up; never `--auto --squash` on an upper PR that hasn't landed its base (this principle currently lives in project memory `feedback_stacked_pr_auto_merge_collapses_granularity` — promoting to invariant is exactly the use case).
- **Recovery posture** — any workflow can be paused (checkpoint) and resumed (rehydrate) without consulting human memory; state is reconstructible from artifacts on disk.
- **Authoring/playbook split** — skills describe behaviors workload-neutrally; playbooks (commands) describe workloads. The current INV-6 sharpened (workload-agnosticism) is the dev-catalog mirror of this principle; the consumer catalog version applies to *consumer-authored* skills and playbooks.
- **Subagent boundary** — sub-agents inherit posture from parent; dispatched tasks have explicit input + return contracts; orphan sub-agents are reaped.

**What it does not cover:** Exarchos's internal substrate (event sourcing, OCC, posture resolver, dispatch core, MCP/CLI parity). Consumers use the affordances; they don't reimplement the runtime.

**Provisional workflow charter:** `/exarchos:discover consumer-sdlc-invariants` — own discover, own corpus (Beck's TDD literature; Humble & Farley *Continuous Delivery*; Allspaw on review discipline; Vaughn Vernon on bounded contexts as workload boundaries). Charter to be drafted separately. Estimated scope is larger than this discover — the consumer audience is broader and the content has decades of practitioner literature behind it.

**Sequencing:** ship dev-invariants v2 first (this proposal + its follow-up plan). Once dev-invariants v2 is stable and the gating mechanism is proven, start the consumer-catalog discover. The two catalogs share no entries by design — they serve different audiences with different concerns.

## 11. Next steps (suggested follow-up plan workflow)

A `feature` workflow named `invariants-catalog-v2-implementation`:

1. **Wave A (research → plan)**: Re-read this doc; finalize INV-14 disposition (catalog entry vs operational pattern); finalize INV-9 Harel citation.
2. **Wave B (catalog edits)**: Implement schema bump + per-entry edits + new entries (TDD: extend `invariants-loader.test.ts` first, then edit `invariants.md`).
3. **Wave C (loader + Phase 0)**: Add `scope: 'core' | 'substrate' | 'authoring' | 'all'` to loader; update `commands/ideate.md` Phase 0 directive.
4. **Wave D (axiom:design pairing fix)**: Update `design-invariants/SKILL.md` frontmatter `pairs-with` slot.
5. **Wave E (tests + verification)**: All new tests pass; vocabulary lint clean; `npm run build:skills` + `npm run test:run` clean; manual Phase 0 smoketest confirms expected entries surface.

Estimated scope: 6-8 tasks, mostly mechanical once this proposal is approved. PR stack: 1-2 PRs depending on whether the axiom:design pairing fix bundles with the catalog rewrite.

## 12. References

- This workflow's deliverables (D1–D4): linked in §1.
- Primary internal source: [`docs/architecture/runtime.md`](../architecture/runtime.md).
- v1 catalog: [`docs/architecture/invariants.md`](../architecture/invariants.md).
- Charter trigger: issue [#1370](https://github.com/lvlup-sw/exarchos/issues/1370) comment [4464273740](https://github.com/lvlup-sw/exarchos/issues/1370#issuecomment-4464273740).
- Audience-scope feedback: user direction during the discover, 2026-05-20 — "These are still invariants specific to Exarchos internal design, not a general-purpose set of invariants for software development. We should gate this functionality behind a feature flag."
