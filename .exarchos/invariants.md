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
    phase-affinity: [ review ]
    severity:
      default: blocking
      by-workflow:
        oneshot: advisory
    enforcement:
      mode: audit
      audit-prompt: >
        Does any read-model hold state across calls that is not a left-fold over
        the event log? Flag in-place mutations, adapter-local mutable caches,
        and side databases that bypass the append-only store.
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
      Reducers must be pure, deterministic, and structurally share state. Stores
      that hold derived state across calls must be projections over events,
      never in-memory side databases.
    citations:
      - "Fowler, *Event Sourcing* (2005):
        https://martinfowler.com/eaaDev/EventSourcing.html"
      - "Greg Young, *CQRS Documents* (2010):
        https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf"
      - "Vaughn Vernon, *Implementing Domain-Driven Design* (Addison-Wesley
        2013) — chapter on Event Sourcing"
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
      Concurrency is serialized in two tiers. This is a CLOSED claim, not a
      target (DR-19 / EFF-001, closed 2026-08-04). Tier 1 (in-process): the
      StreamLockManager runs concurrent same-stream appends sequentially via a
      per-stream Promise-chain mutex. Tier 2 (cross-process): SQLite WAL with
      BEGIN IMMEDIATE acquires the write lock up-front, and a per-stream version
      gate assigns-and-checks the sequence atomically INSIDE that transaction
      (the convergent event-store primitive — Marten mt_streams, SQLStreamStore,
      EventStoreDB). The PRIMARY KEY (streamId, sequence) is an integrity
      backstop, not the conflict detector. Plain appends serialize
      transparently; only a genuine OCC mismatch (a stale expectedSequence)
      surfaces a conflict, carrying expected/actual directly. No process-level
      mutex, no PID lock, no advisory file. WITNESS: three genuine OS child
      processes drive the production SqliteBackend through the production driver
      against one SQLite file, held in the write-lock queue simultaneously and
      asserting an interleaving witness (a run that did not actually contend
      fails), plus a startup version-gate repair arm. Weakening BEGIN IMMEDIATE
      to a deferred BEGIN, disabling the startup repair, or replacing the driver
      with a no-op each turn the corresponding test RED — the fixture cannot
      pass vacuously. Cross-process linearization is therefore asserted
      categorically: a change that cannot keep that fixture green is a
      violation, not a caveat.
    citations:
      - "Mohan et al., *ARIES* (ACM TODS 1992):
        https://dl.acm.org/doi/10.1145/128765.128770"
      - "Bernstein & Goodman, *Concurrency Control in Distributed Database
        Systems* (ACM Computing Surveys 1981):
        https://dl.acm.org/doi/10.1145/356842.356846"
      - "SQLite WAL documentation: https://sqlite.org/wal.html"
    references:
      - servers/exarchos-mcp/src/event-store/atomic-appender.ts
      - servers/exarchos-mcp/src/storage/sqlite-backend.ts
      - servers/exarchos-mcp/test/process/multi-process-append.test.ts
      - docs/architecture/runtime.md#§4

  - id: INV-8
    dimension: idempotency-at-the-boundary
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - event-store
      - withSession
      - dispatch-boundary
    enforcement:
      # LEFT mode:audit (task 027 / DR-15) — a DETERMINISTIC idempotency check is
      # out of reach for the diff-grep DSL, so this stays a reviewer judgment
      # rather than shipping a flaky one. Idempotency-at-the-boundary is a
      # cross-line, semantic property ("this append carries an idempotency key" /
      # "this withSession supplies an operationId") whose subject spans a
      # multi-line options object. The evaluator greps line-oriented over a diff
      # (no multi-line / `s`-flag regex, no dataflow), so any grep either flags
      # every `withSession(` (false-positives) or demands the key on one physical
      # line (misses the multi-line form). A flaky check is worse than an honest
      # advisory one. The mechanical backstops that DO hold are the
      # UNIQUE(idempotency_key) storage index and the withSession retry tests.
      mode: audit
      audit-prompt: >
        Does every append carry an idempotency key, and does every external side
        effect run at most once across retries? A handler retried via
        withSession({operationId}) must re-emit the requested event as a no-op
        when the key matches. Flag an append with no idempotency key, a
        withSession retry path missing operationId, or an external mutation that
        can run twice on retry.
    summary: >
      Every append carries an idempotency key. The UNIQUE INDEX on
      idempotency_key collapses duplicates at the storage layer. Handler retries
      via withSession({operationId}) re-emit the requested event as a no-op when
      the key matches; the external side effect runs at most once across
      retries. INV-8 is the load-bearing prerequisite for INV-13's
      process-manager two-event split.
    citations:
      - "Wolverine idempotency PR #1858:
        https://github.com/JasperFx/wolverine/pull/1858"
      - "Akka persistence at-least-once delivery:
        https://doc.akka.io/docs/akka/snapshot/typed/persistence.html"
      - "Greg Young, *Versioning in an Event Sourced System* (Leanpub):
        https://leanpub.com/esversioning"
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
      topology.yaml. Transitions are guarded; only workflow.transition is a
      phase mutator (workflow.set-phase is deprecated). The HSM is the sole
      authority for valid phase sequencing; next_actions is derived from it.
    citations:
      - "Harel, *Statecharts: A Visual Formalism for Complex Systems* (Science
        of Computer Programming 1987):
        https://www.sciencedirect.com/science/article/pii/0167642387900359"
      - "Greg Young, *Versioning in an Event Sourced System* — Process Manager
        Versioning chapter (Leanpub)"
      - "Wolverine [AggregateHandler] workflow (Miller 2023):
        https://jeremydmiller.com/2023/12/06/building-a-critter-stack-applicati\
        on-wolverines-aggregate-handler-workflow-ftw/"
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
      Every long-running operation emits <surface>.executing_started at entry
      and a paired terminal event (success/failure) at exit. v2.12 lifecycle
      verbs (ps, describe, wait) query these events generically; no per-feature
      lifecycle code is needed. The protocol replaces active polling and
      heartbeat infrastructure.
    citations:
      - "Conductor durable execution:
        https://conductor-oss.github.io/conductor/devguide/concepts/conductor.h\
        tml"
      - "AWP runtime liveness:
        https://github.com/veegee82/agent-workflow-protocol/blob/main/docs/runt\
        ime.md"
      - "Microsoft Scheduler-Agent-Supervisor (negative reference — what this
        protocol replaces):
        https://learn.microsoft.com/en-us/azure/architecture/patterns/scheduler\
        -agent-supervisor"
    references:
      - servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts
      - docs/architecture/runtime.md#§6

  - id: INV-11
    dimension: posture-declared-capabilities
    integrity-class: substrate
    phase-affinity: [ review ]
    enforcement:
      mode: audit
      audit-prompt: >
        Is each agent's authority bounded by the chokepoint that owns the
        resource, rather than by convention? STATE authority is enforced in the
        dispatch/MCP handler — a read-only agent must be unable to invoke a
        mutating action. PROCESS LIFECYCLE and top-level worktree placement are
        enforced by the spawn-bounded launcher. SPATIAL write confinement is NOT
        launcher-owned: it is a per-harness capability that must be reported as
        prevention | detection | advisory | unavailable, and must never be
        inferred from the launcher's cwd or worktree ownership. Flag a posture
        asserted in prose but not enforced at a capability boundary, and flag
        any claim that a task-isolated agent CANNOT write outside its worktree
        where the harness's declared spatial posture is advisory or unavailable.
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - agent-spec
      - capability-resolver
      - handshake
      - sub-agent-dispatch
      - launcher
    summary: >
      Every agent declares one of three postures in agent spec YAML: read-only |
      task-isolated | shared-mutating. The MCP initialize handshake declares the
      runtime half. The capability resolver merges posture with handshake;
      mismatches resolve to the handshake (handshake-authoritative). What a
      posture makes unrepresentable-by-construction is bounded by the chokepoint
      that owns the resource: STATE authority in the dispatch/MCP handler (a
      read-only agent cannot invoke a mutating action), PROCESS LIFECYCLE and
      top-level worktree placement in the spawn-bounded launcher. SPATIAL write
      confinement is deliberately EXCLUDED from the by-construction claim: no
      component in the single-machine frame owns the kernel write path, and
      harness-created nested worktrees sit outside the launcher's reach, so
      filesystem confinement is a DECLARED per-harness capability carrying a
      posture of prevention | detection | advisory | unavailable — never
      inferred from launcher cwd/worktree ownership. Lifecycle ownership and
      spatial isolation are separate audit dimensions; absorbing spatial
      confinement into this invariant requires the space-moat fork (an upstream
      Bash-covering hook standard or a kernel sandbox), and asserting it before
      that lands is an overclaim, not an invariant.
    citations:
      - "Mark S. Miller, *Robust Composition* (PhD dissertation, JHU 2006):
        https://papers.agoric.com/papers/robust-composition/full-text"
      - "Miller et al., *Paradigm Lost: Abstraction Mechanisms for Access
        Control* (JHU SRL 2003): https://srl.cs.jhu.edu/pubs/SRL2003-03.pdf"
      - "POLA — Principle of Least Authority (erights.org):
        http://wiki.erights.org/wiki/POLA"
      - "anip-protocol SPEC — posture and handshake (convergent design):
        https://github.com/anip-protocol/anip/blob/main/SPEC.md"
    references:
      - servers/exarchos-mcp/src/capabilities/resolver.ts
      - servers/exarchos-mcp/src/agents/generate-agents.ts
      - servers/exarchos-mcp/src/launcher/create-worktree.ts
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
      The next_actions field on ToolResult publishes runtime affordances — valid
      transitions perceivable to consuming agents. Agents read next_actions and
      dispatch the listed verbs; they do not poll. Autonomy is a property of
      state + topology (which determines next_actions), not of any handler's
      internal logic. Removing a verb from next_actions removes the agent's path
      to invoking it, but does not remove the underlying affordance — the
      topology still permits it.
    citations:
      - "Donald Norman, *Affordance, Conventions, and Design* (ACM Interactions
        1999):
        https://interactions.acm.org/archive/view/may-june-1999/affordance-conv\
        entions-and-design1"
      - "McGrenere & Ho, *Affordances: Clarifying and Evolving a Concept*
        (Graphics Interface 2000):
        https://graphicsinterface.org/wp-content/uploads/gi2000-24.pdf"
      - "James J. Gibson, *The Ecological Approach to Visual Perception* (1979)
        — cited via the HCI glossary:
        https://interaction-design.org/literature/book/the-glossary-of-human-co\
        mputer-interaction/affordances"
    references:
      - servers/exarchos-mcp/src/next-actions-computer.ts
      - servers/exarchos-mcp/src/format.ts
      - docs/architecture/runtime.md#§7

  - id: INV-13
    dimension: process-manager-two-event-split
    integrity-class: substrate
    phase-affinity: [ review ]
    enforcement:
      # Raised audit→check (task 027 / DR-15). Deterministic proxy for the
      # two-event split: within the external-mutator handler tree, a diff that
      # ADDS a mutator `*.executed` result event must also add the paired
      # `*.requested` intent. Encoded as any-of[ no-added-executed OR
      # added-requested ] — it fires only when an added `(merge|onboard).executed`
      # emission appears with no added matching `.requested`. Added-line-anchored
      # (`\n\+`) so a REMOVAL never false-fires; scoped to the orchestrate handler
      # tree so unrelated `.executed` events (gate/diagnostic) are out of range.
      # The `(merge|onboard)` alternation names the known two-event mutator
      # families — extend it when a new external-mutator family is introduced.
      # Severity stays advisory (NO `severity` block): the proxy cannot see a
      # `.requested` already resident in the tree (diff-only visibility), so a
      # refactor touching only the executed emission is a known false-positive —
      # this is an honest advisory finding (MEDIUM, non-gating), never a blocking
      # one.
      mode: check
      check:
        scope:
          fileGlob: "servers/exarchos-mcp/src/orchestrate/**"
        node:
          any-of:
            - kind: grep
              pattern: "\\n\\+[^\\n]*'(merge|onboard)\\.executed'"
            - not:
                kind: grep
                pattern: "\\n\\+[^\\n]*'(merge|onboard)\\.requested'"
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - external-mutator-handlers
      - merge-orchestrate
      - create-pr
      - withSession
    summary: >
      Handlers performing non-idempotent external side effects emit two events:
      *.requested (intent + full payload) before the side effect; *.executed
      (result) after. On retry, the requested event idempotency-collapses
      (INV-8); the side effect runs once. On crash recovery, the next invocation
      observes *.requested without *.executed and runs an idempotent precheck
      against external state (e.g., does the PR already exist?) to determine
      whether to re-emit or skip. Pattern source — Akka Effect.thenRun,
      Wolverine [AggregateHandler], Greg Young.
    citations:
      - "Akka Effect.thenRun (Persistence docs):
        https://doc.akka.io/api/akka-core/current/akka/persistence/typed/scalad\
        sl/Effect$.html"
      - "Wolverine [AggregateHandler] (Miller 2023):
        https://jeremydmiller.com/2023/12/06/building-a-critter-stack-applicati\
        on-wolverines-aggregate-handler-workflow-ftw/"
      - "Greg Young, *Why Event Sourced Systems Fail*:
        https://www.youtube.com/watch?v=FKFu78ZEIi8"
    references:
      - servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts
      - servers/exarchos-mcp/src/event-store/atomic-appender.ts
      - docs/architecture/runtime.md#§4-process-manager-handlers

  - id: INV-14
    dimension: native-primitive-first-recovery
    integrity-class: substrate
    phase-affinity: [ review ]
    severity:
      default: blocking
      by-workflow:
        oneshot: advisory
    enforcement:
      # Raised audit→check (task 027 / DR-15). Destructive-overwrite backstop:
      # the INV-14 recovery ladder is `git merge --abort` → `git reset --keep`,
      # NEVER `git reset --hard`. Fires when a diff ADDS the destructive git-args
      # invocation `['reset', '--hard', …]` under the server source tree. It
      # matches the array-invocation signature (`'reset', '--hard'`), NOT the
      # prose form `reset --hard` that appears in comments/docstrings/discriminator
      # strings — so a "never reset --hard" note cannot trip it (near-zero
      # false-positive). Added-line-anchored (`\n\+`) so removing the destructive
      # call never false-fires. Blocking severity: the anti-pattern is precise and
      # the violation (silent work loss) is severe.
      mode: check
      check:
        kind: grep
        pattern: "\\n\\+[^\\n]*'reset', *'--hard'"
        fileGlob: "servers/exarchos-mcp/src/**"
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - external-mutator-handlers
      - recovery-paths
      - error-discriminators
    summary: >
      When an external operation needs reversal, handlers prefer the operation's
      own recovery primitive first (e.g., `git merge --abort`), fall back to
      substrate-level undo with refuse-to-discard semantics second (e.g., `git
      reset --keep <sha>`), and never use destructive overwrite (e.g., `git
      reset --hard`). The recoveryError field on terminal results discriminates
      'reset-keep-blocked' | 'reset-failed' | 'unexpected-mid-merge-drift' so
      callers see indeterminate states explicitly rather than as silent
      successes.
    citations:
      - "Mohan et al., *ARIES* (ACM TODS 1992) — Compensation Log Records
        semantics as the abstract analog:
        https://dl.acm.org/doi/10.1145/128765.128770"
      - "Greg Young, *Event Sourcing: The Bad Parts* (CodeCrafts 2022) —
        local-rewind recovery posture:
        https://www.youtube.com/watch?v=K4bj31fJGFk"
      - "git documentation — `git merge --abort`, `git reset --keep`:
        https://git-scm.com/docs/git-reset"
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
      Scheduler-Agent-Supervisor, no 2PC, no leader election, no vector clocks,
      no BFT consensus, no distributed locks. Compensation is local rewind over
      the event log, not remote command dispatch. Liveness is event-emitted
      (INV-10), queryable via lifecycle verbs. Cooperation is by construction
      (INV-11 posture + INV-12 affordance). When a candidate design imports
      primitives from outside this frame, the frame rejects it.
    citations:
      - "Microsoft Azure Architecture Center — Scheduler Agent Supervisor
        pattern (negative reference):
        https://learn.microsoft.com/en-us/azure/architecture/patterns/scheduler\
        -agent-supervisor"
      - "Microsoft Azure Architecture Center — Saga design pattern (negative
        reference):
        https://learn.microsoft.com/en-us/azure/architecture/patterns/saga"
      - "Clemens Vasters, *Cloud Architecture: The Scheduler-Agent-Supervisor
        Pattern* (2010):
        https://learn.microsoft.com/en-us/archive/blogs/clemensv/cloud-architec\
        ture-the-scheduler-agent-supervisor-pattern"
    references:
      - docs/architecture/runtime.md#§1
      - docs/architecture/runtime.md#§8

  - id: INV-2
    dimension: contract-client-equivalence
    integrity-class: substrate
    phase-affinity: [ review ]
    severity:
      default: advisory
    enforcement:
      # mode:audit, not check: "is this module a GENERATED client of the
      # compiled contract?" is a whole-tree structural question, not a
      # line-oriented diff property, and a grep for "behavior in an adapter
      # file" would false-positive on legitimate presentation code. The
      # MECHANICAL backstops are the dispatch-seam containment census and the
      # DR-25 deviation ledger in `contract/cli/cli-contract-seam.ts` — every
      # non-projection module importing the runtime `dispatch` value must carry
      # a governed, unexpired ledger row, and a row covering nothing fails as
      # STALE_DEVIATION. The parity harnesses are a WITNESS, never the proof.
      mode: audit
      audit-prompt: >
        Does this change reach the shared contract handler through the compiled
        contract, or does it hand-assemble a call to the runtime `dispatch`
        value? Any module outside CONTRACT_PROJECTIONS that imports `dispatch`
        must be covered by a governed, unexpired row in CLI_CONTRACT_DEVIATIONS
        carrying an owner, a rationale, a retirement condition and an expiry.
        Flag a new direct-dispatch path with no ledger row, behavior added to
        adapters/cli.ts or adapters/mcp.ts beyond presentation, and any verb
        lacking a registered outputSchema. Do NOT accept a passing parity
        fixture as evidence that two hand-written surfaces are equal by
        construction.
    axis: substrate
    cost-of-load: always-load
    applies-to:
      - contract-compiler
      - cli-client
      - mcp-adapter
      - dispatch-core
      - deviation-ledger
    summary: >
      The MCP wire projection of the compiled contract is the invocation
      surface; the CLI is a CLIENT of that same contract, equal to the wire BY
      CONSTRUCTION rather than by hand-coordination — not a peer facade kept in
      step by fixtures. Behavior lives in the shared dispatch core; a client
      carries presentation only (argv parsing, exit codes, stdio framing, error
      rendering, carrier translation). Byte- and schema-equivalence across
      carriers (the parity harnesses plus each action's registered Zod
      outputSchema) is the WITNESS of that construction, never the invariant
      itself: a suite of green parity fixtures does not make two hand-written
      surfaces equal. The shipped `adapters/cli.ts` meets this framing for
      dispatch ADDRESSING: every api-action call site addresses its action by
      contract ActionId through the generated client
      (`contract/cli/generated-client.ts`, a contract projection) which verifies
      the id against the compiled surface before dispatching, so an action the
      contract does not compile cannot be addressed and the adapter imports no
      runtime `dispatch` value; the Commander tree it keeps is hand-authored
      presentation. The DR-25 deviation that previously covered the adapter's
      hand-assembled direct dispatch path (`cli-direct-dispatch`) is RETIRED and
      CLI_CONTRACT_DEVIATIONS is empty; the census machinery stays armed, so any
      future direct route to the dispatch core must be a contract projection or
      record a new governed, owned, expiring deviation — an acknowledged,
      expiring debt AGAINST this invariant, never a weakening OF it.
    citations:
      - "Alistair Cockburn, *Hexagonal Architecture (Ports & Adapters)* (2005):
        https://alistair.cockburn.us/hexagonal-architecture/"
      - "Martin Fowler, *PresentationDomainDataLayering* (2015):
        https://martinfowler.com/bliki/PresentationDomainDataLayering.html"
      - "Anthropic, *Model Context Protocol — Tools* (2024):
        https://modelcontextprotocol.io/specification/2025-06-18/server/tools"
    references:
      - docs/architecture/invariants/references/INV-2-facade-equivalence.md
      - servers/exarchos-mcp/src/contract/cli/cli-contract-seam.ts
      - servers/exarchos-mcp/src/contract/cli/generated-client.ts
      - servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts
      - docs/designs/archive/2026-05-07-milestone-16-mcp-alignment.md

  - id: INV-3
    dimension: basileus-forward
    integrity-class: substrate
    phase-affinity: [ review ]
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
      - "Jim Waldo et al., *A Note on Distributed Computing* (Sun Microsystems
        1994):
        https://web.archive.org/web/2020/https://scholar.harvard.edu/files/wald\
        o/files/waldo-94.pdf"
      - "Anthropic, *Model Context Protocol — Transports* (2025):
        https://modelcontextprotocol.io/specification/2025-06-18/basic/transpor\
        ts"
      - "Martin Fowler, *Patterns of Enterprise Application Architecture* —
        Remote Facade (Addison-Wesley 2002):
        https://martinfowler.com/eaaCatalog/remoteFacade.html"
    references:
      - docs/architecture/invariants/references/INV-3-basileus-forward.md
      - servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts
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
      Authored content is emitted ONCE as a standard-conformant artifact
      wherever a standard converged — Agent Skills (SKILL.md), AGENTS.md, and
      MCP — and each harness reads it natively; the only residual per-harness
      variance is the tool prefix, carried by a bare logical name the agent
      resolves from its own tool list. Per-runtime fan-out is TECHNICAL DEBT,
      not the target architecture: a thin shim survives only where NO standard
      exists, and every residual shim carries an owner, the capability reason it
      exists, and a retirement condition. Conformance plus shim minimization —
      not render-parity across N runtime variants — is the metric, because a
      byte-perfect per-harness render proves the artifacts match, not that the
      guarantee holds. Source-of-truth edits go to skills-src/; everything under
      skills/** is generated build output and is never edited directly.
      Runtime-specific text is tokenized via {{TOKEN}} placeholders or guarded
      via <!-- requires:* --> blocks. INV-4 owns the *harness* axis; INV-6 owns
      the orthogonal *workload* axis (workflow types) and INV-16 the orthogonal
      *OS* axis — substrate guarantees hold across all three.
    references:
      - docs/architecture/invariants/references/INV-4-platform-agnosticity.md
      - servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts
      - skills-src/SKILL_AUTHORING.md
    citations:
      - "Andrew Hunt & David Thomas, *The Pragmatic Programmer* — DRY / Single
        Source of Truth (Addison-Wesley 1999):
        https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniver\
        sary-edition/"
      - "Anthropic, *Agent Skills* (2025):
        https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills/overvi\
        ew"
      - "Anthropic, *Model Context Protocol — Architecture* (2025):
        https://modelcontextprotocol.io/specification/2025-06-18/architecture"
    phase-affinity:
      - review
    workflow-affinity:
      - feature
      - debug
      - refactor
      - oneshot
    enforcement:
      # mode:audit, not check (task 086): the prior diff-precise check
      # (issue #1466) fired a grep on the hunk header of ANY diff touching
      # skills/**, so it could not distinguish a REGENERATED tree — which
      # CLAUDE.md mandates committing alongside a skills-src/ change — from a
      # HAND edit skills-src/ does not reproduce. That made it a blocking
      # invariant a conforming commit could not satisfy (73 files on one
      # branch alone), training reviewers to ignore it. Whether a skills/**
      # diff is generated output is a whole-tree render-equivalence question
      # the diff-grep DSL cannot see (no exec leaf kind, diff-only visibility)
      # — the same reasoning that keeps INV-2 and INV-6 in audit mode.
      # `npm run skills:guard` (dist/skills-guard.js) already answers it
      # precisely: it re-renders skills-src/ via `npm run build:skills` and
      # diffs the result against the committed tree, so it distinguishes the
      # two cases the grep leaf could not. That render-equivalence probe is
      # the mechanical backstop this audit defers to.
      mode: audit
      audit-prompt: "Does this diff touch any file under skills/**? A touched
        generated file is ONLY a violation when it diverges from a fresh render
        of skills-src/ -- the render-equivalence probe npm run skills:guard
        (dist/skills-guard.js) answers this precisely: it re-renders skills-src/
        via npm run build:skills and diffs the result against the committed
        skills/** tree. A REGENERATED tree (skills:guard passes) is conformant
        and CLAUDE.md-mandated -- committing skills/** alongside its skills-src/
        source is the convention, not a violation. Flag a skills/** diff only
        when skills:guard fails for it (or was not run before commit), never
        merely because skills/** was touched."
    severity:
      default: blocking
      by-workflow:
        oneshot: advisory
    integrity-class: substrate

  - id: INV-5a
    dimension: input-ergonomics
    integrity-class: substrate
    phase-affinity: [ review ]
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
      - "Anthropic, *Model Context Protocol — Tools* (2025):
        https://modelcontextprotocol.io/specification/2025-06-18/server/tools"
      - "Anthropic, *Writing effective tools for agents* (2025):
        https://www.anthropic.com/engineering/writing-tools-for-agents"
      - "JSON Schema, *Validation* (draft 2020-12):
        https://json-schema.org/draft/2020-12/json-schema-validation"
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
      not NDJSON. The affordance-as-perceived semantics of next_actions live in
      INV-12.
    citations:
      - "Anthropic, *Model Context Protocol — Tools (structured content & output
        schema)* (2025):
        https://modelcontextprotocol.io/specification/2025-06-18/server/tools#s\
        tructured-content"
      - "David L. Parnas, *On the Criteria To Be Used in Decomposing Systems
        into Modules* (CACM 1972): https://dl.acm.org/doi/10.1145/361598.361623"
      - "JSON Schema, *Validation* (draft 2020-12):
        https://json-schema.org/draft/2020-12/json-schema-validation"
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
      - "Microsoft, *.NET Aspire overview* (2024):
        https://learn.microsoft.com/en-us/dotnet/aspire/get-started/aspire-over\
        view"
      - "Kubernetes, *kubectl --dry-run server-side apply* (2024):
        https://kubernetes.io/docs/reference/using-api/server-side-apply/"
      - "Adam Wiggins, *The Twelve-Factor App — Admin processes* (2017):
        https://12factor.net/admin-processes"
    references:
      - docs/architecture/invariants/references/INV-5c-aspire-verbs.md
      - servers/exarchos-mcp/src/orchestrate/check-invariant-conformance.ts
      - servers/exarchos-mcp/src/describe/handler.ts
      - servers/exarchos-mcp/src/adapters/cli.ts

  - id: INV-5d
    dimension: action-discriminator
    integrity-class: substrate
    phase-affinity: [ review ]
    enforcement:
      # mode:audit, not check: the composite-tool count is a whole-repo
      # structural fact, not a diff property. Judgment stays with the reviewer.
      mode: audit
      audit-prompt: >
        Do the visible composite tools stay at four with action discriminators,
        and do per-action annotations (destructive / readOnly / idempotent /
        openWorld) ride on each action? Flag any new top-level tool that should
        be an action.
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
    phase-affinity: [ review ]
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
        guarantees must hold for every workflow type; workflow-specifics belong
        in topology and playbooks.
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
      type. Workflow-type-specific concerns belong in topology.yaml, not the
      catalog. Skills describe behaviors; playbooks/commands describe workflows.
      Operational projection: scripts/lint-inv6.mjs grep for workflow-typed
      literals in skills-src/.
    citations:
      - "AWP runtime-agnostic protocol:
        https://github.com/veegee82/agent-workflow-protocol/blob/main/docs/runt\
        ime.md"
      - "Harn typed orchestration boundary:
        https://harnlang.com/workflow-runtime.html"
      - "Novita framework-agnostic runtime:
        https://blogs.novita.ai/novita-agent-runtime-agentcore-compatible/"
    references:
      - docs/architecture/invariants/references/INV-6-workflow-agnosticism.md
      - scripts/lint-inv6.mjs
      - docs/architecture/runtime.md#§1

  - id: INV-16
    dimension: os-portability
    integrity-class: substrate
    phase-affinity: [ review ]
    workflow-affinity: [ feature, debug, refactor, oneshot ]
    severity:
      default: blocking
      by-workflow:
        oneshot: advisory
    enforcement:
      # Raised audit→check (task 027 / DR-15). OS portability is broad, but its
      # single highest-signal, zero-legitimate-use anti-pattern IS diff-precise:
      # `new URL(import.meta.url).pathname` yields `/D:/…` on Windows and doubles
      # to `D:\D:\…` under path.resolve — the correct form is
      # fileURLToPath(import.meta.url). This check fires when a diff ADDS that
      # construct under the server source tree; added-line-anchored (`\n\+`) so a
      # REMOVAL (a fix) never false-fires. The broader portability surface
      # (path.join, SQLite-handle release before rm, .cmd-shim spawns) stays
      # covered by the blocking windows-latest CI job and
      # scripts/check-windows-portability.mjs — this check is the diff-precise,
      # front-of-pipeline slice of that backstop. Blocking severity (unchanged).
      mode: check
      check:
        kind: grep
        pattern: "\\n\\+[^\\n]*new +URL *\\( *import\\.meta\\.url *\\) *\\.pathname"
        fileGlob: "servers/exarchos-mcp/src/**"
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - event-store
      - test-harness
      - path-resolution
      - process-spawn
    summary: >
      The MCP server runs on Windows as well as POSIX. Paths that are stored or
      compared are POSIX-normalized (Node fs accepts '/' on Windows); paths are
      built with path.join, never separator string-concat; SQLite handles are
      released (close() / rmrf) before a temp dir is removed (NTFS forbids
      unlinking an open file, unlike POSIX); package-manager spawns resolve
      their .cmd shim via resolveExecutable; module-relative paths use
      fileURLToPath. INV-16 owns the *OS* axis; INV-4 owns the orthogonal
      *harness* axis (standards-conformance plus thin shims) — both are
      platform-agnosticity substrate properties.
    citations:
      - "Node.js, *Path* (OS-specific separators; fs accepts '/' on Windows):
        https://nodejs.org/api/path.html"
      - "Node.js, *child_process.execFile* (spawns without a shell; .cmd shims
        on Windows):
        https://nodejs.org/api/child_process.html#child_processexecfilefile-arg\
        s-options-callback"
      - "Node.js, *fs.rm* (maxRetries/retryDelay for EBUSY/EPERM on Windows):
        https://nodejs.org/api/fs.html#fspromisesrmpath-options"
    references:
      - servers/exarchos-mcp/src/utils/paths.ts
      - servers/exarchos-mcp/src/utils/process.ts
      - servers/exarchos-mcp/src/test-helpers/temp-dir.ts
      - scripts/check-windows-portability.mjs
      - .github/workflows/ci.yml

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
  - id: INV-17
    dimension: response-economy
    axis: substrate
    cost-of-load: reference-only
    applies-to:
      - registry
      - dispatch-core
      - response-envelope
      - action-schemas
    summary: "Every action declares a response-economy budget (a declared value wins
      over a registry-wide default), enforced once at the shared dispatch-core
      measurement seam; unbounded output requires an explicit schema-typed
      escape hatch (detail/limit/fields); budgets are test-enforced by a
      registry-enumeration snapshot. The budget and escape-hatch are properties
      of the canonical response contract — declared in the registry descriptor,
      enforced in the shared core, rendered through a presentation seam — never
      special-cased in one facade. This is downstream of the GOVERNING INV-2
      (the CLI is a client of the compiled contract, equivalence by construction
      — re-approved under DR-26, superseding the #1608 pending note) and of the
      facade-codegen direction (system-design 05): the registered outputSchema
      must be total over every emittable shape (baseline + capped + degraded),
      the precondition that makes facade equivalence hold by construction.
      INV-17 is the response-economy specialization of that output-contract
      totality obligation."
    references:
      - servers/exarchos-mcp/src/registry.ts
      - servers/exarchos-mcp/src/core/dispatch.ts
      - servers/exarchos-mcp/src/core/dispatch.economy-seam.ts
      - servers/exarchos-mcp/src/core/economy.ts
      - docs/specs/2026-07-12-tool-token-economy-remediation.md
    citations:
      - "Anthropic, *Writing effective tools for AI agents / tool-use best
        practices* (2024):
        https://docs.anthropic.com/en/docs/build-with-claude/tool-use"
      - "Model Context Protocol, *Server Tools — Structured Content &
        outputSchema* (2025-06-18):
        https://modelcontextprotocol.io/specification/2025-06-18/server/tools"
      - "GitHub, *github-mcp-server — minimal, purpose-built tool responses*
        (2024): https://github.com/github/github-mcp-server"
    phase-affinity:
      - review
    workflow-affinity:
      - feature
      - debug
      - refactor
      - oneshot
    enforcement:
      mode: audit
      audit-prompt: >-
        Does every action declare (or inherit) a response-economy budget, with
        unbounded output gated behind an explicit schema-typed escape hatch
        (detail/limit/fields)? The mechanical backstops are the
        registry-enumeration budget snapshot test (pins every action's effective
        budget; an invalid budget fails the test) and the dispatch-core economy
        guard (caps only data, stamps _meta.truncated, fails open with
        _meta.economyDegraded), plus the economy-seam no-bypass gate
        (dispatch.economy-seam.test.ts — asserts, by source structure, that
        every result-producing branch of dispatch() and the withTelemetry seam
        route the raw handler payload through enforceResponseEconomy, so a new
        execution mode cannot silently ship an un-capped branch; this is the
        Axis-2 / enforcement-application backstop the coverage-axis snapshot
        tests do not provide). Flag any new action shipping unbounded output
        without a declared budget or a schema-typed escape hatch, and any
        capped/summary response shape absent from the action's registered
        outputSchema.


        **Vacuity is a violation, not a pass.** INV-17 names `outputSchema`
        totality as the precondition that makes facade equivalence hold by
        construction. A schema total *because it constrains nothing* is total
        over wrong shapes as well as right ones, so "schema-checked" degrades to
        a tautology. Treat a vacuous declaration at the same severity as a
        missing one.


        **Decide vacuity by reading the declaration, not its name.** Vacuous iff
        `data` is unconstrained, regardless of binding name or wrapper depth:
        (a) literal `EnvelopeSchema(z.unknown())`; (b) a *named* binding whose
        definition is that literal — `WorkflowUpdateOutputSchema` **is**
        `EnvelopeSchema(z.unknown())`; (c) a wrapper/intersection constraining
        only `_meta`/`_perf`/deprecation while `data` stays `z.unknown()` —
        `WorkflowTransitionOutputSchema`; (d) any `vacuityWaiver(...)` entry,
        which records vacuity *tolerated*, never *satisfied*.


        **Operable test: name one wrong response shape this schema rejects.** If
        you cannot, it is vacuous. A name, a wrapper, or a constrained `_meta`
        is presence; only a constrained `data` is substance. (An earlier
        revision of DR-4 classified two declarations as typed *because they had
        names*; measurement showed both vacuous.)


        Report each vacuous declaration by action + file:line. The live baseline
        is enumerated by
        `servers/exarchos-mcp/src/architecture/output-schema-census.ts` — read
        it rather than quoting a count — and pinned shrink-only by the allowlist
        in `servers/exarchos-mcp/src/output-schema-vacuity-allowlist.ts`, whose
        key set is frozen in
        `servers/exarchos-mcp/src/output-schema-seed-pin.ts`. A diff adding a
        vacuous declaration, or moving an allowlist entry sideways rather than
        off, is a violation.
    severity:
      default: advisory
    integrity-class: substrate
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
