**Role:** You are the Principal Architect for the **Exarchos Distributed SDLC System**. You have total mastery of the "Distributed SDLC Pipeline" design (`docs/adrs/distributed-sdlc-pipeline.md`) and Anthropic's official skill-building best practices.

**Context:** This audit covers two layers:

1. **MCP Server** (`plugins/exarchos/servers/exarchos-mcp/src/`) — A TypeScript MCP server with 5 composite tools spanning workflow HSM, event store, CQRS views, task coordination, stack, and sync modules. Local store is append-only JSONL (`{streamId}.events.jsonl`) with in-memory materialized views and JSON snapshots. Remote store (Marten/PostgreSQL) is scaffolded via an outbox (`sync/outbox.ts`) but not yet wired. Note: inter-agent messaging is handled by Claude Code's native Agent Teams, not by Exarchos.

2. **Content Layer** (`commands/`, `skills/`, `rules/`) — Markdown-based skills with YAML frontmatter, slash commands, and behavioral rules that Claude loads via progressive disclosure. These install to `~/.claude/` via symlinks and govern agent behavior across all SDLC workflows.

**Your Task:** Audit the codebase and identify optimization opportunities across these five categories. For each finding, state what's wrong, where it is, and what the fix should be.

---

### 1. Pattern Alignment (MCP Server)

Validate that our implementations are faithful to the canonical definitions of these patterns. Cross-reference against authoritative sources — particularly Microsoft Learn's [CQRS Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs), [Saga Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga), and [Event Sourcing](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing).

**CQRS — Read/write separation:**
- Are all read paths hitting materialized views (`views/materializer.ts`), or do any tool handlers query raw events and aggregate inline? Check `stack/tools.ts` and `workflow/query.ts` specifically. (Note: task claims now use CQRS materializer — verify no regressions.)
- Does the materializer's projection model match canonical CQRS — event stream as write model, views as read model, views rebuilt from events on demand?

**Event Sourcing — Append-only, events as source of truth:**
- Is the event store (`event-store/store.ts`) truly append-only? Are events ever mutated or deleted? (The idempotency key cache is in-memory with JSONL persistence — verify this doesn't introduce a mutation path.)
- Are events self-describing and sufficient to rebuild state, or do any views depend on state file data (`.state.json`) that isn't derivable from events alone? The event-first architecture in `workflow/tools.ts` appends transition events BEFORE writing state files, with idempotency keys preventing duplicates on CAS retry. Verify: is `reconcileFromEvents()` sufficient to rebuild state from events alone, or do state files still carry data not captured in events?
- Do the event schemas (`event-store/schemas.ts`) carry the metadata the ADR specifies (`correlationId`, `causationId`, `agentId`, `source`)?

**Outbox — Transactional Outbox pattern:**
- Does `sync/outbox.ts` implement the pattern faithfully? The canonical form writes to the outbox in the same transaction as the local store. Since we use JSONL (no transactions), how is atomicity approximated? The outbox drain now propagates `idempotencyKey` — verify this closes the gap where an event could be appended to JSONL but not enqueued to the outbox.

**Saga — Compensation on cancel:**
- `workflow/cancel.ts` implements checkpoint-based compensation with reverse-order execution and idempotent skip logic. Verify: Are all compensation actions truly idempotent in practice (e.g., deleting a worktree that's already gone, archiving an already-archived state file)?
- Does checkpoint file cleanup happen after successful full compensation, or do stale checkpoints accumulate?

**HSM — Hierarchical State Machine:**
- Does the transition algorithm in `workflow/state-machine.ts` correctly implement HSM semantics (compound states, history, guards)?
- Are guard definitions in `workflow/guards.ts` pure functions with no side effects?

---

### 2. Skill & Content Quality (Content Layer)

Validate that all skills, commands, and rules follow Anthropic's official skill-building best practices. Use the three-level progressive disclosure model as the primary structural lens.

**Frontmatter compliance:**
- Does every `SKILL.md` have valid YAML frontmatter with `---` delimiters?
- Does the `name` field use kebab-case, match the folder name, and avoid spaces/capitals/underscores?
- Does the `description` field follow the `[What it does] + [When to use it] + [Key capabilities]` structure?
- Are descriptions under 1,024 characters and free of XML angle brackets (`<`, `>`)?
- Do descriptions include trigger phrases users would actually say?
- Does `metadata` include `author`, `version`, `mcp-server` (where applicable), `category`, and `phase-affinity`?

**Progressive disclosure:**
- **Level 1 (frontmatter):** Is there enough information for Claude to decide when to load the skill without reading the body? Is the description specific enough to avoid overtriggering and detailed enough to avoid undertriggering?
- **Level 2 (SKILL.md body):** Is the body focused on core instructions, or does it embed reference material that should live in `references/`? Is the SKILL.md under 5,000 words?
- **Level 3 (references/):** Are detailed guides, templates, API patterns, and examples offloaded to `references/` and clearly linked from the body? Can Claude navigate to them on demand?

**Instruction quality:**
- Are instructions specific and actionable (command-like: "Run X", "Call Y with Z") rather than vague ("validate the data before proceeding")?
- Are critical instructions placed at the top of the document, using `## Important` or `## Critical` headers?
- Is error handling documented for common failure modes with cause/solution pairs?
- Are examples provided for common scenarios showing trigger, steps, and expected result?
- Are instructions free of ambiguous language? ("Make sure to validate things properly" is bad; "CRITICAL: Before calling X, verify: [checklist]" is good.)

**Command structure:**
- Does each command in `commands/*.md` have valid frontmatter and reference its skill via `@skills/<name>/SKILL.md`?
- Do commands include workflow position diagrams showing where they sit in the phase pipeline?
- Are commands focused on entry-point routing or do they duplicate skill logic inline?

**Use case documentation:**
- Does each skill document its intended use cases in `Trigger / Steps / Result` format — either in the SKILL.md body or a `references/` file?
- Are use cases concrete enough to serve as functional test cases? (e.g., "User says 'help me plan this sprint' -> Fetch project status -> Analyze capacity -> Suggest prioritization -> Create tasks -> Result: Fully planned sprint with tasks created")
- Do skills that serve multiple use cases document each one, or rely on a single generic description?

**Composability:**
- Do any skills assume they are the only loaded skill? (e.g., monopolizing workflow state, conflicting tool usage patterns, overriding global behavior)
- When multiple skills are loaded simultaneously (our default), do any have conflicting instructions for the same trigger conditions?
- Do skills cleanly delegate to other skills where appropriate, or do they duplicate logic that belongs in a different skill?

**Validation scripts:**
- For skills with critical validation steps (gate checks, review criteria, quality thresholds), are those checks implemented as `scripts/` that run programmatically, or expressed only as prose instructions? (Note: skills should reference their validation scripts — either in SKILL.md body or `references/` subdirectories. Verified as of v2 audit.)
- Code is deterministic; language interpretation is not. Identify validation steps that would benefit from a bundled script rather than relying on Claude to interpret prose criteria consistently.

**Rule scoping:**
- Do rules in `rules/*.md` use `paths` frontmatter to scope to specific file patterns where applicable?
- Are rules behavioral constraints (not implementation instructions)?
- Do any rules conflict with each other or with skill instructions?

---

### 3. Token Economy (Both Layers)

Every byte in a tool response or skill body consumes agent context window. Audit both layers for unnecessary payload.

**MCP tool responses (`views/tools.ts`):**
- Do view handlers return full objects when agents typically only need summary fields? (e.g., full `TaskDetail` vs. `{ taskId, status, assignee }`)
- Does `handleViewPipeline` embed event arrays that grow unbounded?
- Could a `compact` vs. `full` parameter let agents choose their detail level?

**Workflow responses:**
- Does `handleSummary` (`workflow/query.ts`) return full event payloads when `{ type, timestamp }` references would suffice?

**Event payloads (`event-store/schemas.ts`):**
- Do any event types carry large freeform strings (`detail`, `diagnostics`, `context`) that inflate view projections downstream?

**MCP general patterns:**
- Are Ref IDs (`taskId`, `streamId`) used instead of embedding full objects, forcing agents to drill down only when needed?
- Is `format.ts` enforcing a consistent, minimal `ToolResult` shape across all modules?

**Skill token budget:**
- Which `SKILL.md` files exceed 5,000 words? These degrade Claude's instruction-following and should be split into body + `references/`. (Note: skills are expected to be under 1,300 words. Verified as of v2 audit.)
- Are any skills loading large inline templates, checklists, or code blocks that could be moved to `references/` for on-demand access?
- Do commands embed full skill content inline instead of referencing via `@skills/` paths?
- Are any `references/` files loaded eagerly (mentioned at the top of SKILL.md as required reading) rather than linked for progressive discovery?

**Rule token cost:**
- Are any rules excessively verbose for the constraint they express?
- Could related rules be consolidated without losing specificity?
- Do any rules repeat guidance already present in `CLAUDE.md` or skills?

---

### 4. Operational Performance (MCP Server)

Audit runtime characteristics: latency per tool call, I/O patterns, memory growth, and concurrency safety.

**Implemented safeguards (confirmed working — audit for regressions):**
- **Pre-parse sequence filtering** — `query()` skips `JSON.parse` for lines below `sinceSequence`. Verify the line-number-equals-sequence invariant holds after compaction or manual edits. Event store now tolerates blank lines.
- **LRU eviction** — `ViewMaterializer` has configurable `maxCacheEntries` (default 100) with Map-order LRU. Verify eviction doesn't discard views that are immediately re-requested in tight loops.
- **CAS versioning + idempotency** — `workflow/tools.ts` uses `_version` with retry loop (max 3) and event-first architecture with idempotency keys preventing duplicates on CAS retry. Verify retry exhaustion produces a clear error, not silent data loss.
- **Optimistic task claims** — `handleTaskClaim` now uses CQRS materializer (not inline event aggregation) with `expectedSequence`. Verify the retry loop handles sequence gaps from concurrent event appends.
- **Idempotency keys** — `append()` deduplicates via in-memory FIFO cache (100 keys), rebuilt from JSONL on restart. Verify cache rebuild performance at scale (thousands of events per stream).
- **Saga compensation** — `cancel.ts` persists `CompensationCheckpoint` on partial failure for resumable re-execution. Checkpoint cleanup after successful completion confirmed working.

**Open concerns:**
- `event-store/store.ts` — In-memory promise-chain locks only protect within a single Node.js process. If multiple MCP instances share a `stateDir`, JSONL corruption is possible. Is the single-instance assumption validated or enforced (e.g., PID lock file)?
- `event-store/store.ts` — The `.seq` cache race condition: if two processes both call `initializeSequence()` concurrently, both may compute the same sequence number. The cache is best-effort, but what's the blast radius of a stale `.seq` value?
- `views/tools.ts` — Cold-start materialization replays all events. At what event count does cold start become a latency problem? Is snapshot loading reliable enough to avoid this in practice?
- Are there hot paths beyond `workflow/tools.ts` fast-path that pay unnecessary Zod validation costs?

---

### 5. Workflow Effectiveness (Content Layer)

Validate that skills produce consistent, efficient outcomes when Claude executes them. Use Anthropic's quantitative and qualitative success criteria as the benchmark.

**Triggering accuracy:**
- For each skill, identify 3-5 phrases that should trigger it and 3-5 that should not. Does the `description` field discriminate correctly?
- Are there skills with overlapping trigger conditions that could cause ambiguous loading? (e.g., `/ideate` vs. `/plan` — when would Claude load the wrong one?)
- Do any skills lack negative triggers where scope clarification would prevent misfires?

**Workflow completeness:**
- Can each skill complete its workflow in X tool calls without user correction? Identify steps where Claude is likely to need redirection.
- Are dependencies between steps explicit? (e.g., "Wait for: payment method verification" before proceeding)
- Are rollback or compensation instructions included for steps that can fail?
- Do multi-MCP workflows (skills that coordinate Exarchos + GitHub + Graphite) have clear phase separation, data passing between phases, and validation before proceeding?

**Pattern adherence:**
- Which Anthropic skill pattern does each skill follow? (Sequential orchestration, Multi-MCP coordination, Iterative refinement, Context-aware tool selection, Domain-specific intelligence)
- Are skills that should use iterative refinement (e.g., `/review`) structured with explicit quality criteria and termination conditions?
- Are skills that coordinate multiple MCPs (e.g., `/synthesize` using Exarchos + Graphite + GitHub) structured with clear phase separation?

**Consistency across sessions:**
- Do skills produce structurally consistent output when run 3-5 times with the same input?
- Are there any skills where the output format varies depending on which MCP responses Claude sees first?
- Do checkpoint/resume flows (`/checkpoint`, `/resume`) preserve enough context to continue without quality degradation?

**Performance baseline:**
- For each primary workflow skill (`/ideate`, `/debug`, `/refactor`), estimate the with-skill vs. without-skill cost:
  - Messages exchanged (back-and-forth requiring user redirection)
  - Failed MCP tool calls (wrong parameters, missing context)
  - Total tokens consumed (skill overhead vs. ad-hoc prompting)
- Identify skills where the overhead of loading the skill (token cost of SKILL.md + references) may exceed the efficiency gains for simple tasks. Should any skills offer a "lite" mode?

**Model laziness mitigation:**
- Do any skills lack explicit encouragement to be thorough? (e.g., "Take your time", "Quality is more important than speed", "Do not skip validation steps")
- Note: Anthropic recommends adding these to user prompts rather than SKILL.md — are any misplaced?
