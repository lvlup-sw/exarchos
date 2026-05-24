---
title: Exarchos Architectural Invariants
description: >
  Machine-readable catalog of architectural invariants (INV-*) and axiom
  dimensions (DIM-*) consumed by /ideate, the design-invariants skill,
  and the vocabulary-lint scanner. Source of truth for the invariant
  vocabulary in the Exarchos repo.
schema-version: 2
invariants:
  - id: INV-1
    dimension: event-sourcing-integrity
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - event-store
      - projections
      - reducers
      - workflow-state-projection
    summary: >
      The append-only event log is the source of truth. Every read-model is a
      left-fold over events; state mutations are events, not in-place updates.
      Reducers must be pure, deterministic, and structurally share state.
      Stores that hold derived state across calls must be projections over
      events, never in-memory side databases.
    axiom_overlap: DIM-1
    citations:
      - "Fowler, *Event Sourcing* (2005): https://martinfowler.com/eaaDev/EventSourcing.html"
      - "Greg Young, *CQRS Documents* (2010): https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf"
      - "Vaughn Vernon, *Implementing Domain-Driven Design* (Addison-Wesley 2013) — chapter on Event Sourcing"
    references:
      - .claude/skills/design-invariants/references/INV-1-event-sourcing.md
      - .claude/skills/design-invariants/SKILL.md
      - docs/architecture/projections.md

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

  - id: INV-2
    dimension: facade-equivalence
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - cli-adapter
      - mcp-adapter
      - dispatch-core
      - parity-tests
    summary: >
      CLI and MCP are both facades over a single functional dispatch core. For
      any verb, the same DispatchContext + arguments must produce the same
      ToolResult. Adapters carry zero behavior — only presentation. Post-#1266,
      every action also registers a Zod outputSchema so parity is schema-checked
      in addition to byte-checked.
    references:
      - .claude/skills/design-invariants/references/INV-2-facade-equivalence.md
      - .claude/skills/design-invariants/SKILL.md
      - docs/designs/2026-05-07-milestone-16-mcp-alignment.md

  - id: INV-3
    dimension: basileus-forward
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - capabilities-resolver
      - runtime-yaml
      - mcp-transport
      - remote-mcp-adapter
    summary: >
      No design decision presumes MCP is local-only. Workflow and Ontology
      channels have independent client lifecycles, handshake-authoritative
      capability resolution, and .exarchos.yml-only configuration. Workspace
      discovery prefers the MCP roots capability over cwd heuristics
      (post-#1269). The remote-MCP surface throws-not-degrades when called
      (#1081).
    references:
      - .claude/skills/design-invariants/references/INV-3-basileus-forward.md
      - .claude/skills/design-invariants/SKILL.md
      - servers/exarchos-mcp/src/capabilities/resolver.ts
      - servers/exarchos-mcp/src/adapters/remote-mcp.ts

  - id: INV-4
    dimension: platform-agnosticity
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - skills-src
      - runtimes
      - skills-renderer
      - commands
    summary: >
      Skills, rules, and workflows must not couple to any single harness. Six
      runtimes are first-class (Claude Code, Codex, Copilot, Cursor, OpenCode,
      generic). Runtime-specific text is tokenized via {{TOKEN}} placeholders or
      guarded via <!-- requires:* --> blocks. Source-of-truth edits go to
      skills-src/; skills/<runtime>/** is generated.
      INV-4 owns the *platform* axis (6 runtimes); INV-6 owns the orthogonal
      *workload* axis (workflow types). The two are complementary substrate
      properties — substrate guarantees hold across both axes.
    references:
      - .claude/skills/design-invariants/references/INV-4-platform-agnosticity.md
      - .claude/skills/design-invariants/SKILL.md
      - skills-src/SKILL_AUTHORING.md

  - id: INV-5a
    dimension: input-ergonomics
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - mcp-registry
      - tool-schemas
      - cli-flags
    summary: >
      Tool inputs are constrained at the schema level (enum, regex, format), not
      via prose hints. Every tool description states when NOT to use the tool
      with a pointer to the alternative. Visible tool count stays under 15.
      Static reference content is exposed as MCP Resources, not tools.
    references:
      - .claude/skills/design-invariants/references/INV-5a-input-ergonomics.md
      - .claude/skills/design-invariants/SKILL.md
      - servers/exarchos-mcp/src/registry.ts
      - servers/exarchos-mcp/src/adapters/schema-to-flags.ts

  - id: INV-5b
    dimension: output-contract
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - format.ts
      - tool-results
      - registered-output-schemas
      - error-envelopes
    summary: >
      Every successful ToolResult carries a fixed carrier shape — next_actions,
      _meta, _perf fields. Errors carry validTargets, expectedShape,
      suggestedFix. Post-#1266, the carrier is structuredContent with a
      registered outputSchema per action; long-running ops use Tasks (SEP-1686)
      not NDJSON. The affordance-as-perceived semantics of next_actions live
      in INV-12.
    axiom_overlap: DIM-3
    references:
      - .claude/skills/design-invariants/references/INV-5b-output-contract.md
      - .claude/skills/design-invariants/SKILL.md
      - servers/exarchos-mcp/src/format.ts
      - servers/exarchos-mcp/src/next-actions-computer.ts
      - servers/exarchos-mcp/src/mcp/tasks-methods.ts

  - id: INV-5c
    dimension: aspire-verbs
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - cli-commands
      - composite-tools
      - process-lifecycle
    summary: >
      Exarchos CLI design borrows deliberately from Aspire — queryable,
      dry-run-capable, JSON-explicit control-plane verbs. Agents query state;
      they don't drive scripts. ps / describe / wait / export are observation
      verbs; mutating verbs default to --dry-run.
    references:
      - .claude/skills/design-invariants/references/INV-5c-aspire-verbs.md
      - .claude/skills/design-invariants/SKILL.md
      - servers/exarchos-mcp/src/describe/handler.ts
      - servers/exarchos-mcp/src/adapters/cli.ts

  - id: INV-5d
    dimension: action-discriminator
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - mcp-registry
      - composite-tools
      - tool-annotations
    summary: >
      Exarchos exposes 4 visible composite tools, each with an action
      discriminator (exarchos_workflow, exarchos_event, exarchos_orchestrate,
      exarchos_view). The visible tool count stays under 15; per-action
      annotations (destructiveHint / readOnlyHint / idempotentHint /
      openWorldHint) live on CompositeAction post-#1268.
    references:
      - .claude/skills/design-invariants/references/INV-5d-action-discriminator.md
      - .claude/skills/design-invariants/SKILL.md
      - servers/exarchos-mcp/src/registry.ts
      - servers/exarchos-mcp/src/adapters/mcp.ts

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
    citations:
      - "AWP runtime-agnostic protocol: https://github.com/veegee82/agent-workflow-protocol/blob/main/docs/runtime.md"
      - "Harn typed orchestration boundary: https://harnlang.com/workflow-runtime.html"
      - "Novita framework-agnostic runtime: https://blogs.novita.ai/novita-agent-runtime-agentcore-compatible/"
    references:
      - .claude/skills/design-invariants/references/INV-6-workflow-agnosticism.md
      - scripts/lint-inv6.mjs
      - docs/architecture/runtime.md#§1

  - id: DIM-1
    dimension: topology
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - module-boundaries
      - dependency-direction
      - state-ownership
    summary: >
      Topology dimension (axiom-owned, see /axiom:critique). Adapter-local
      mutable caches, lazy fallback singletons, and side databases are
      topology smells that overlap with INV-1 / INV-2; design-invariants
      cross-links rather than duplicating the axiom:backend-quality check.
    references:
      - .claude/skills/design-invariants/SKILL.md
      - servers/exarchos-mcp/src/review/registry.ts
      - docs/rca/2026-04-27-v29-rc1-orchestrate-cluster.md

  - id: DIM-2
    dimension: observability
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - logging
      - telemetry
      - error-paths
    summary: >
      Observability dimension (axiom-owned, see /axiom:harden). Silent catches,
      missing log context, and degradation paths that swallow signals. Overlaps
      INV-1 when a reducer apply catches and continues instead of triggering
      the reducer-throw degradation path.
    references:
      - .claude/skills/design-invariants/SKILL.md
      - servers/exarchos-mcp/src/agents/generate-agents.ts
      - servers/exarchos-mcp/src/agents/generate-agents.test.ts

  - id: DIM-3
    dimension: contracts
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - schemas
      - event-types
      - tool-output
    summary: >
      Contracts dimension from axiom — schema-runtime drift, type-assertion
      safety, breaking field renames without versioning. Overlaps INV-1 when an
      event field is removed but still read, and INV-5b when output shape
      changes without an envelope version bump.
    references:
      - .claude/skills/design-invariants/SKILL.md
      - servers/exarchos-mcp/src/topology/phase-contract.ts
      - servers/exarchos-mcp/src/registry.ts

  - id: DIM-4
    dimension: test-fidelity
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - test-suites
      - mocks
      - fixtures
    summary: >
      Test fidelity principle — see /axiom:verify for the canonical check.
      Cross-references INV-2 (facade equivalence) when mock-vs-real
      divergence hides parity bugs.
    references:
      - .claude/skills/design-invariants/SKILL.md
      - servers/exarchos-mcp/src/__tests__/parity-harness.ts

  - id: DIM-5
    dimension: hygiene
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - dead-paths
      - unused-exports
      - legacy-flags
    summary: >
      Hygiene (axiom-canonical name; axiom-owned) — dead code, unused exports,
      legacy feature flags that no longer gate behavior. Cleanup work that
      intersects INV-2 (legacy adapter paths) or INV-5d (legacy top-level
      tools that should collapse into composite actions).
    references:
      - .claude/skills/design-invariants/SKILL.md
      - docs/contexts/2026-05-07-insights-friction-discovery.md

  - id: DIM-6
    dimension: solid-coupling
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - module-design
      - inheritance
      - composition
    summary: >
      SOLID / coupling dimension from axiom — generic dependency direction,
      single-responsibility violations, inheritance vs composition mismatches.
      Axiom-owned; design-invariants defers here for generic SOLID findings.
    references:
      - .claude/skills/design-invariants/SKILL.md
      - docs/designs/2026-05-18-preview-4-invariant-audit-pair.md

  - id: DIM-7
    dimension: resilience
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - error-paths
      - retry-logic
      - degradation
    summary: >
      Resilience principle — see /axiom:harden for the canonical check.
      Cross-references INV-1 when a fallback creates a degraded EventStore,
      and INV-2 when it hides parity divergence.
    references:
      - .claude/skills/design-invariants/SKILL.md
      - servers/exarchos-mcp/src/agents/generate-agents.ts

  - id: DIM-8
    dimension: prose-quality
    axis: authoring
    cost-of-load: archivable
    applies-to:
      - documentation
      - skill-bodies
      - command-text
    summary: >
      Prose Quality (axiom-owned, see /axiom:humanize) — telltale AI-generated
      prose patterns. Catalog entry preserved for vocabulary-lint
      cross-references only; not loaded at Phase 0.
    references:
      - .claude/skills/design-invariants/SKILL.md
      - docs/contexts/2026-05-07-insights-friction-discovery.md

  - id: basileus-boundary
    dimension: cross-product-coordination
    axis: substrate
    cost-of-load: archivable
    applies-to:
      - basileus-exarchos-coordination
      - ontology-mcp-server
      - cross-tier-mediation
    summary: >
      Boundary discipline between Exarchos and Basileus. AgentHost ↔ Sandbox
      calls must route through ControlPlane (Basileus INV-1). Cross-product
      coordination uses the Ontology MCP Server (intent_register) rather than
      bespoke RPC. Strategos.Contracts via TypeSpec governs schema.
    references:
      - .claude/skills/design-invariants/SKILL.md
      - docs/research/2026-05-14-semantic-merge-queue-audit.md
      - servers/exarchos-mcp/src/sync
---

# Exarchos Architectural Invariants

Machine-readable catalog of the architectural invariants that govern Exarchos design and review. The YAML frontmatter above is the **source of truth** for tooling — the `/ideate` command, the `design-invariants` skill, and the `vocabulary-lint` scanner all consume the same shape.

This file pairs with the prose reference content under [`.claude/skills/design-invariants/references/`](../../.claude/skills/design-invariants/references/). The frontmatter `summary` field is the short version; the linked reference files carry the full prose, severity guides, worked examples, and external grounding.

## Schema

Each entry in `invariants:` carries:

| Field | Type | Required? | Purpose |
|---|---|---|---|
| `id` | string | yes | Stable identifier — `INV-1`..`INV-15`, sub-disciplines like `INV-5a`/`INV-5b`/`INV-5c`/`INV-5d`, axiom dimensions `DIM-1`..`DIM-8`, plus cross-product entries (`basileus-boundary`). |
| `dimension` | string | yes | Short human-readable category name. |
| `axis` | enum | yes (v2) | One of `substrate` \| `authoring`. Substrate invariants govern runtime behavior; authoring invariants govern artifact content. Loader scope filter (`/ideate` Phase 0) honors this split. |
| `cost-of-load` | enum | yes | One of `always-load` \| `reference-only` \| `archivable`. Drives the `/ideate` Phase 0 split: only `axis: substrate ∧ cost-of-load: always-load` entries are surfaced by default (the `scope: 'core'` set); `reference-only` entries are loaded on-demand; `archivable` entries are kept for vocabulary-lint cross-references but never surfaced. |
| `applies-to` | string[] | yes | Surface areas (modules, file globs, capability domains) where the invariant is load-bearing. |
| `summary` | string | yes | One-to-two-sentence statement of the invariant. |
| `axiom_overlap` | string | no (v2) | DIM-N identifier (matches `/^DIM-\d+$/`) where the substrate-invariant has a clean axiom-dimension analogue. Consumed by `/axiom:design` pairing-discovery to interleave project invariants under each axiom dimension. |
| `citations` | string[] | no (v2) | External research grounding — recommended ≥3 entries for substrate-axis invariants. Each entry is a free-form citation string (typically `Author, *Title* (Year): URL`). DIM-* axiom-pointer entries are exempt. |
| `references` | string[] | yes | Pointers to internal source files where the invariant is detailed in prose. |

The catalog gates behind the `.exarchos.yml: invariants.devCatalog: enabled` flag (default disabled, no auto-detection). When disabled, the loader returns `[]` regardless of scope. See [`docs/guides/exarchos-yml-invariants.md`](../guides/exarchos-yml-invariants.md) for the consumer-facing reference.

## Vocabulary

The vocabulary-lint scanner (`servers/exarchos-mcp/src/architecture/vocabulary-lint.ts`, exposed via `npm run lint:invariants`) walks `docs/`, `skills-src/`, and `commands/` for tokens matching `/\b(INV-\d+[a-d]?|DIM-\d+)\b/` and cross-checks against the IDs declared here. Unknown references surface as findings; the vocabulary lint is enforcing (exits non-zero on findings).

## Consumers

- `/exarchos:ideate` — surfaces relevant invariants as Constraints during Phase 0 (before Phase 1), before the clarifying questions.
- `design-invariants` skill — audits design proposals against INV-1..INV-15 (substrate runtime invariants) + the DIM-1..DIM-8 axiom-dimension cross-links.
- `vocabulary-lint` — flags references to invariant IDs not registered here.
- Future: `#1275` MCP Resources — expose this catalog as `resources/exarchos-invariants` once Resources land.

## See also

- [`docs/architecture/projections.md`](projections.md) — projection layer specifics.
- [`docs/architecture/runtime.md`](runtime.md) — runtime / capability resolution.
- [`.claude/skills/design-invariants/SKILL.md`](../../.claude/skills/design-invariants/SKILL.md) — operational skill that consumes this catalog.
