**Role:** You are the Principal Architect for the **Exarchos Distributed SDLC System**. You have total mastery of the "Distributed SDLC Pipeline" design (`docs/adrs/distributed-sdlc-pipeline.md`).

**Context:** The `exarchos-mcp` server (`plugins/exarchos/servers/exarchos-mcp/src/`) is a TypeScript MCP server — 27 tools across workflow HSM, event store, CQRS views, team coordination, tasks, stack, and sync modules. Local store is append-only JSONL (`{streamId}.events.jsonl`) with in-memory materialized views and JSON snapshots. Remote store (Marten/PostgreSQL) is scaffolded via an outbox (`sync/outbox.ts`) but not yet wired.

**Your Task:** Audit the codebase and identify optimization opportunities across these three categories. For each finding, state what's wrong, where it is, and what the fix should be.

---

### 1. Pattern Alignment

Validate that our implementations are faithful to the canonical definitions of these patterns. Cross-reference against authoritative sources — particularly Microsoft Learn's [CQRS Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs), [Saga Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga), and [Event Sourcing](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing).

**CQRS — Read/write separation:**
- Are all read paths hitting materialized views (`views/materializer.ts`), or do any tool handlers query raw events and aggregate inline? Check `stack/tools.ts`, `workflow/query.ts`, and `team/tools.ts` specifically.
- Does the materializer's projection model match canonical CQRS — event stream as write model, views as read model, views rebuilt from events on demand?

**Event Sourcing — Append-only, events as source of truth:**
- Is the event store (`event-store/store.ts`) truly append-only? Are events ever mutated or deleted?
- Are events self-describing and sufficient to rebuild state, or do any views depend on state file data that isn't derivable from events alone?
- Do the event schemas (`event-store/schemas.ts`) carry the metadata the ADR specifies (`correlationId`, `causationId`, `agentId`, `source`)?

**Outbox — Transactional Outbox pattern:**
- Does `sync/outbox.ts` implement the pattern faithfully? The canonical form writes to the outbox in the same transaction as the local store. Since we use JSONL (no transactions), how is atomicity approximated? Is there a gap where an event is appended to JSONL but not enqueued to the outbox?

**Saga — Compensation on cancel:**
- Does `workflow/cancel.ts` implement proper saga compensation? Are compensation steps idempotent and ordered correctly (reverse of execution order)?
- What happens if compensation partially fails — is the workflow left in a consistent state?

**HSM — Hierarchical State Machine:**
- Does the transition algorithm in `workflow/state-machine.ts` correctly implement HSM semantics (compound states, history, guards)?
- Are guard definitions in `workflow/guards.ts` pure functions with no side effects?

---

### 2. Token Economy

Every byte in a tool response consumes agent context window. Audit tool outputs for unnecessary payload.

**View tool responses (`views/tools.ts`):**
- Do view handlers return full objects when agents typically only need summary fields? (e.g., full `TaskDetail` vs. `{ taskId, status, assignee }`)
- Does `handleViewPipeline` embed event arrays that grow unbounded?
- Could a `compact` vs. `full` parameter let agents choose their detail level?

**Team and workflow responses:**
- Does `handleTeamStatus` (`team/tools.ts`) return fields like spawn prompts or worktree paths that aren't needed for a status check?
- Does `handleSummary` (`workflow/query.ts`) return full event payloads when `{ type, timestamp }` references would suffice?

**Event payloads (`event-store/schemas.ts`):**
- Do any event types carry large freeform strings (`detail`, `diagnostics`, `context`) that inflate view projections downstream?

**General patterns:**
- Are Ref IDs (`taskId`, `streamId`) used instead of embedding full objects, forcing agents to drill down only when needed?
- Is `format.ts` enforcing a consistent, minimal `ToolResult` shape across all modules?

---

### 3. Operational Performance

Audit runtime characteristics: latency per tool call, I/O patterns, memory growth, and concurrency safety.

**I/O and latency:**
- `event-store/store.ts` — `query()` reads and parses the entire JSONL file on every call. At scale (thousands of events), this is O(n) per query. Is there a path to indexed reads or cursor-based pagination?
- `views/tools.ts` — First view materialization replays all events (cold start). Subsequent calls use high-water marks. Is snapshot loading reliable enough to avoid cold-start replay in practice?
- `workflow/tools.ts` — The fast-path optimization skips Zod validation for simple queries. Are there other hot paths that pay unnecessary validation costs?

**Memory:**
- The `ViewMaterializer` caches all materialized views in memory indefinitely. For long-running sessions with many workflows, does memory grow unbounded? Is there an eviction strategy?
- `TeamCoordinator` (`team/coordinator.ts`) holds teammate state in memory. Is this cleaned up on shutdown, or can stale entries accumulate?

**Concurrency:**
- `event-store/store.ts` — In-memory promise-chain locks serialize within one Node.js process. If multiple MCP instances share a `stateDir`, JSONL corruption is possible. Is the single-instance assumption validated or enforced?
- `event-store/store.ts` — If the `.seq` cache is missing and concurrent appends both trigger `initializeSequence`, can they compute the same sequence number?
- `workflow/tools.ts` — State file read-mutate-write has no file lock or compare-and-swap.
- `tasks/tools.ts` — `handleTaskClaim` emits `task.claimed` without checking whether the task is already claimed. Two teammates can claim the same task.

**Idempotency:**
- Can `eventStore.append()` produce duplicate events if a caller retries after a timeout? Is there an idempotency key mechanism?
- Are saga compensation steps in `workflow/cancel.ts` safe to re-execute?
