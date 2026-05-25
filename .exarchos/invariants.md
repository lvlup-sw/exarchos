---
title: Exarchos Architectural Invariants
description: >
  Machine-readable catalog of architectural invariants (INV-*) consumed by
  /ideate, the check_invariant_conformance gate, and the vocabulary-lint
  scanner. Source of truth for the invariant vocabulary in the Exarchos repo.
schema-version: 3
invariants:
  - id: INV-1
    dimension: event-sourcing-integrity
    integrity-class: substrate
    phase-affinity: [review]
    severity:
      default: blocking
      by-workflow:
        oneshot: advisory
    enforcement:
      mode: audit
      audit-prompt: >
        Does any read-model hold state across calls that is not a left-fold
        over the event log? Flag in-place mutations, adapter-local mutable
        caches, and side databases that bypass the append-only store.
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
    citations:
      - "Fowler, *Event Sourcing* (2005): https://martinfowler.com/eaaDev/EventSourcing.html"
      - "Greg Young, *CQRS Documents* (2010): https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf"
      - "Vaughn Vernon, *Implementing Domain-Driven Design* (Addison-Wesley 2013) — chapter on Event Sourcing"
    references:
      - docs/architecture/invariants/references/INV-1-event-sourcing.md
      - servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts
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
    citations:
      - "Mohan et al., *ARIES* (ACM TODS 1992): https://dl.acm.org/doi/10.1145/128765.128770"
      - "Bernstein & Goodman, *Concurrency Control in Distributed Database Systems* (ACM Computing Surveys 1981): https://dl.acm.org/doi/10.1145/356842.356846"
      - "SQLite WAL documentation: https://sqlite.org/wal.html"
    references:
      - servers/exarchos-mcp/src/event-store/atomic-appender.ts
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
    citations:
      - "Wolverine idempotency PR #1858: https://github.com/JasperFx/wolverine/pull/1858"
      - "Akka persistence at-least-once delivery: https://doc.akka.io/docs/akka/snapshot/typed/persistence.html"
      - "Greg Young, *Versioning in an Event Sourced System* (Leanpub): https://leanpub.com/esversioning"
    references:
      - servers/exarchos-mcp/src/event-store/atomic-appender.ts
      - docs/architecture/runtime.md#§4

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
    citations:
      - "Harel, *Statecharts: A Visual Formalism for Complex Systems* (Science of Computer Programming 1987): https://www.sciencedirect.com/science/article/pii/0167642387900359"
      - "Greg Young, *Versioning in an Event Sourced System* — Process Manager Versioning chapter (Leanpub)"
      - "Wolverine [AggregateHandler] workflow (Miller 2023): https://jeremydmiller.com/2023/12/06/building-a-critter-stack-application-wolverines-aggregate-handler-workflow-ftw/"
    references:
      - servers/exarchos-mcp/src/topology/phase-contract.ts
      - servers/exarchos-mcp/src/workflow/hsm-definitions.ts
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
    citations:
      - "Conductor durable execution: https://conductor-oss.github.io/conductor/devguide/concepts/conductor.html"
      - "AWP runtime liveness: https://github.com/veegee82/agent-workflow-protocol/blob/main/docs/runtime.md"
      - "Microsoft Scheduler-Agent-Supervisor (negative reference — what this protocol replaces): https://learn.microsoft.com/en-us/azure/architecture/patterns/scheduler-agent-supervisor"
    references:
      - servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts
      - docs/architecture/runtime.md#§6

  - id: INV-11
    dimension: posture-declared-capabilities
    integrity-class: substrate
    phase-affinity: [review]
    enforcement:
      mode: audit
      audit-prompt: >
        Is each agent's authority bounded by construction rather than by
        convention? A read-only agent must be unable to mutate the working
        tree; a task-isolated agent must be unable to write outside its
        worktree. Flag a posture asserted in prose but not enforced at the
        capability boundary.
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
    integrity-class: substrate
    phase-affinity: [review]
    enforcement:
      mode: audit
      audit-prompt: >
        Does every non-idempotent external side effect emit a *.requested
        intent before and a *.executed result after, so a crash between them
        is recoverable by an idempotent precheck? Flag single-event external
        mutators.
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
    citations:
      - "Akka Effect.thenRun (Persistence docs): https://doc.akka.io/api/akka-core/current/akka/persistence/typed/scaladsl/Effect$.html"
      - "Wolverine [AggregateHandler] (Miller 2023): https://jeremydmiller.com/2023/12/06/building-a-critter-stack-application-wolverines-aggregate-handler-workflow-ftw/"
      - "Greg Young, *Why Event Sourced Systems Fail*: https://www.youtube.com/watch?v=FKFu78ZEIi8"
    references:
      - servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts
      - servers/exarchos-mcp/src/event-store/atomic-appender.ts
      - docs/architecture/runtime.md#§4-process-manager-handlers

  - id: INV-14
    dimension: native-primitive-first-recovery
    integrity-class: substrate
    phase-affinity: [review]
    enforcement:
      mode: audit
      audit-prompt: >
        On reversal, does the handler prefer the operation's own recovery
        primitive, then a refuse-to-discard substrate undo, and never a
        destructive overwrite? Flag any reset-hard-style path or a recovery
        that can silently lose work.
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
    citations:
      - "Microsoft Azure Architecture Center — Scheduler Agent Supervisor pattern (negative reference): https://learn.microsoft.com/en-us/azure/architecture/patterns/scheduler-agent-supervisor"
      - "Microsoft Azure Architecture Center — Saga design pattern (negative reference): https://learn.microsoft.com/en-us/azure/architecture/patterns/saga"
      - "Clemens Vasters, *Cloud Architecture: The Scheduler-Agent-Supervisor Pattern* (2010): https://learn.microsoft.com/en-us/archive/blogs/clemensv/cloud-architecture-the-scheduler-agent-supervisor-pattern"
    references:
      - docs/architecture/runtime.md#§1
      - docs/architecture/runtime.md#§8

  - id: INV-2
    dimension: facade-equivalence
    integrity-class: substrate
    phase-affinity: [review]
    severity:
      default: advisory
    enforcement:
      # mode:audit, not check: a grep for "behavior in an adapter file" is a
      # low-precision proxy that cannot prove parity and would false-positive
      # on legitimate adapter code. Parity is proven by the parity-harness
      # tests; the reviewer judges adapter discipline.
      mode: audit
      audit-prompt: >
        Do the CLI and MCP adapters carry only presentation, with all behavior
        in the shared dispatch core? Flag logic added to adapters/cli.ts or
        adapters/mcp.ts beyond formatting, and any verb lacking a parity or
        registered outputSchema guarantee.
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
    citations:
      - "Alistair Cockburn, *Hexagonal Architecture (Ports & Adapters)* (2005): https://alistair.cockburn.us/hexagonal-architecture/"
      - "Martin Fowler, *PresentationDomainDataLayering* (2015): https://martinfowler.com/bliki/PresentationDomainDataLayering.html"
      - "Anthropic, *Model Context Protocol — Tools* (2024): https://modelcontextprotocol.io/specification/2025-06-18/server/tools"
    references:
      - docs/architecture/invariants/references/INV-2-facade-equivalence.md
      - servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts
      - docs/designs/2026-05-07-milestone-16-mcp-alignment.md

  - id: INV-3
    dimension: basileus-forward
    integrity-class: substrate
    phase-affinity: [review]
    enforcement:
      mode: audit
      audit-prompt: >
        Does any decision presume the MCP transport is co-located with the
        workflow process? Capability resolution must stay
        handshake-authoritative and configuration .exarchos.yml-only, so the
        same code path serves a remote channel without change.
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
    citations:
      - "Jim Waldo et al., *A Note on Distributed Computing* (Sun Microsystems 1994): https://web.archive.org/web/2020/https://scholar.harvard.edu/files/waldo/files/waldo-94.pdf"
      - "Anthropic, *Model Context Protocol — Transports* (2025): https://modelcontextprotocol.io/specification/2025-06-18/basic/transports"
      - "Martin Fowler, *Patterns of Enterprise Application Architecture* — Remote Facade (Addison-Wesley 2002): https://martinfowler.com/eaaCatalog/remoteFacade.html"
    references:
      - docs/architecture/invariants/references/INV-3-basileus-forward.md
      - servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts
      - servers/exarchos-mcp/src/capabilities/resolver.ts
      - servers/exarchos-mcp/src/adapters/remote-mcp.ts

  - id: INV-4
    dimension: platform-agnosticity
    integrity-class: substrate
    phase-affinity: [review]
    workflow-affinity: [feature, debug, refactor, oneshot]
    severity:
      default: blocking
      by-workflow:
        oneshot: advisory
    enforcement:
      # Diff-precise mode:check (issue #1466). Generated runtime variants under
      # skills/<runtime>/** are build output of `npm run build:skills`; a diff
      # touching any of them is a direct edit to generated output (source of
      # truth is skills-src/). The `scope` combinator narrows the fileGlob to
      # the generated tree; the grep fires on the hunk header so any touched
      # generated file is flagged. skills-src/** is excluded by the glob.
      mode: check
      check:
        scope:
          fileGlob: "skills/**"
        node:
          kind: grep
          pattern: "@@"
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
    citations:
      - "Andrew Hunt & David Thomas, *The Pragmatic Programmer* — DRY / Single Source of Truth (Addison-Wesley 1999): https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/"
      - "Anthropic, *Agent Skills* (2025): https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills/overview"
      - "Anthropic, *Model Context Protocol — Architecture* (2025): https://modelcontextprotocol.io/specification/2025-06-18/architecture"
    references:
      - docs/architecture/invariants/references/INV-4-platform-agnosticity.md
      - servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts
      - skills-src/SKILL_AUTHORING.md

  - id: INV-5a
    dimension: input-ergonomics
    integrity-class: substrate
    phase-affinity: [review]
    enforcement:
      # mode:audit, not check: the visible-tool-count is a whole-repo
      # structural fact (a count over registry.ts), not a diff property the
      # combinator evaluator can see. Judgment stays with the reviewer.
      mode: audit
      audit-prompt: >
        Are tool inputs constrained at the schema level (enum, regex, format)
        rather than by prose hints, does every tool state when NOT to use it,
        and does the visible tool count stay under 15?
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
    citations:
      - "Anthropic, *Model Context Protocol — Tools* (2025): https://modelcontextprotocol.io/specification/2025-06-18/server/tools"
      - "Anthropic, *Writing effective tools for agents* (2025): https://www.anthropic.com/engineering/writing-tools-for-agents"
      - "JSON Schema, *Validation* (draft 2020-12): https://json-schema.org/draft/2020-12/json-schema-validation"
    references:
      - docs/architecture/invariants/references/INV-5a-input-ergonomics.md
      - servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts
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
    citations:
      - "Anthropic, *Model Context Protocol — Tools (structured content & output schema)* (2025): https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content"
      - "David L. Parnas, *On the Criteria To Be Used in Decomposing Systems into Modules* (CACM 1972): https://dl.acm.org/doi/10.1145/361598.361623"
      - "JSON Schema, *Validation* (draft 2020-12): https://json-schema.org/draft/2020-12/json-schema-validation"
    references:
      - docs/architecture/invariants/references/INV-5b-output-contract.md
      - servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts
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
    citations:
      - "Microsoft, *.NET Aspire overview* (2024): https://learn.microsoft.com/en-us/dotnet/aspire/get-started/aspire-overview"
      - "Kubernetes, *kubectl --dry-run server-side apply* (2024): https://kubernetes.io/docs/reference/using-api/server-side-apply/"
      - "Adam Wiggins, *The Twelve-Factor App — Admin processes* (2017): https://12factor.net/admin-processes"
    references:
      - docs/architecture/invariants/references/INV-5c-aspire-verbs.md
      - servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts
      - servers/exarchos-mcp/src/describe/handler.ts
      - servers/exarchos-mcp/src/adapters/cli.ts

  - id: INV-5d
    dimension: action-discriminator
    integrity-class: substrate
    phase-affinity: [review]
    enforcement:
      # mode:audit, not check: the composite-tool count is a whole-repo
      # structural fact, not a diff property. Judgment stays with the reviewer.
      mode: audit
      audit-prompt: >
        Do the visible composite tools stay at four with action
        discriminators, and do per-action annotations (destructive / readOnly
        / idempotent / openWorld) ride on each action? Flag any new top-level
        tool that should be an action.
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
      - docs/architecture/invariants/references/INV-5d-action-discriminator.md
      - servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts
      - servers/exarchos-mcp/src/registry.ts
      - servers/exarchos-mcp/src/adapters/mcp.ts

  - id: INV-6
    dimension: workload-agnosticism
    integrity-class: substrate
    phase-affinity: [review]
    enforcement:
      # mode:audit, not check: scripts/lint-inv6.mjs is a deliberately-advisory
      # literal scan with a frontmatter-declaration escape hatch a diff-grep
      # cannot replicate (legitimate prose in skills-src references workflow
      # types). The judgment stays with the reviewer; the script remains the
      # out-of-band advisory lint.
      mode: audit
      audit-prompt: >
        Does any skill body encode workflow-typed branching or assume one
        workflow type without declaring metadata.workflow-type? Substrate
        guarantees must hold for every workflow type; workflow-specifics
        belong in topology and playbooks.
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
      - docs/architecture/invariants/references/INV-6-workflow-agnosticism.md
      - scripts/lint-inv6.mjs
      - docs/architecture/runtime.md#§1

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
      - servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts
      - docs/research/2026-05-14-semantic-merge-queue-audit.md
      - servers/exarchos-mcp/src/sync
---

# Exarchos Architectural Invariants

Machine-readable catalog of the architectural invariants that govern Exarchos design and review. The YAML frontmatter above is the **source of truth** for tooling — the `/ideate` command, the `check_invariant_conformance` gate, and the `vocabulary-lint` scanner all consume the same shape.

This file pairs with the prose reference content under [`invariants/references/`](invariants/references/). The frontmatter `summary` field is the short version; the linked reference files carry the full prose, severity guides, worked examples, and external grounding. (Prior to T-23 these references lived under the now-retired `design-invariants` skill; the skill's audit behavior is now performed by the `check_invariant_conformance` gate.)

## Schema

Each entry in `invariants:` carries:

| Field | Type | Required? | Purpose |
|---|---|---|---|
| `id` | string | yes | Stable identifier — `INV-1`..`INV-15`, sub-disciplines like `INV-5a`/`INV-5b`/`INV-5c`/`INV-5d`, plus cross-product entries (`basileus-boundary`). |
| `dimension` | string | yes | Short human-readable category name. |
| `axis` | enum | yes (v2) | One of `substrate` \| `authoring`. Substrate invariants govern runtime behavior; authoring invariants govern artifact content. Loader scope filter (`/ideate` Phase 0) honors this split. |
| `cost-of-load` | enum | yes | One of `always-load` \| `reference-only` \| `archivable`. Drives the `/ideate` Phase 0 split: only `axis: substrate ∧ cost-of-load: always-load` entries are surfaced by default (the `scope: 'core'` set); `reference-only` entries are loaded on-demand; `archivable` entries are kept for vocabulary-lint cross-references but never surfaced. |
| `applies-to` | string[] | yes | Surface areas (modules, file globs, capability domains) where the invariant is load-bearing. |
| `summary` | string | yes | One-to-two-sentence statement of the invariant. |
| `citations` | string[] | no (v2) | External research grounding — recommended ≥3 entries for substrate-axis invariants. Each entry is a free-form citation string (typically `Author, *Title* (Year): URL`). |
| `references` | string[] | yes | Pointers to internal source files where the invariant is detailed in prose. |

The catalog gates behind the `.exarchos.yml: invariants.devCatalog: enabled` flag (default disabled, no auto-detection). When disabled, the loader returns `[]` regardless of scope. See [`docs/guides/exarchos-yml-invariants.md`](../guides/exarchos-yml-invariants.md) for the consumer-facing reference.

## Vocabulary

The vocabulary-lint scanner (`servers/exarchos-mcp/src/architecture/vocabulary-lint.ts`, exposed via `npm run lint:invariants`) walks the live normative surfaces — `docs/architecture/`, `docs/guides/`, `skills-src/`, and `commands/` — for tokens matching `/\b(INV-\d+[a-d]?|DIM-\d+)\b/` and cross-checks against the IDs declared here. Dated record trees under `docs/` (designs, plans, research, rca, contexts, followups, proposals) are intentionally out of scope so retired vocabulary (e.g. the `DIM-*` dimensions removed in #1477) does not fail the lint forever; the `DIM-\d+` shape is retained in the regex so a stray reference in a live surface still surfaces. Unknown references are findings; the vocabulary lint is enforcing (exits non-zero on findings).

## Consumers

- `/exarchos:ideate` — surfaces relevant invariants as Constraints during Phase 0 (before Phase 1), before the clarifying questions.
- `check_invariant_conformance` gate (`servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts`) — audits design proposals against INV-1..INV-15 (substrate runtime invariants). The audit prompt is catalog-generated (`servers/exarchos-mcp/src/architecture/audit-prompt.ts`). This gate replaced the retired `design-invariants` skill (T-23).
- `vocabulary-lint` — flags references to invariant IDs not registered here.
- Future: `#1275` MCP Resources — expose this catalog as `resources/exarchos-invariants` once Resources land.

## See also

- [`docs/architecture/projections.md`](projections.md) — projection layer specifics.
- [`docs/architecture/runtime.md`](runtime.md) — runtime / capability resolution.
- [`check-invariant-conformance.ts`](../../servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts) — the conformance gate that consumes this catalog (replaced the retired `design-invariants` skill in T-23).
