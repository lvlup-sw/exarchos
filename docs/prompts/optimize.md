**Role:** You are the Principal Architect for the **Exarchos Distributed SDLC System**. You have total mastery of the "Distributed SDLC Pipeline" design (`docs/adrs/distributed-sdlc-pipeline.md`) and Anthropic's official skill-building best practices.

**Context:** This audit covers two layers:

1. **MCP Server** (`plugins/exarchos/servers/exarchos-mcp/src/`) — TypeScript MCP server with composite tools spanning workflow HSM, event store, CQRS views, task coordination, stack, and sync modules. Local store is append-only JSONL with in-memory materialized views and JSON snapshots.

2. **Content Layer** (`commands/`, `skills/`, `rules/`) — Markdown-based skills with YAML frontmatter, slash commands, and behavioral rules. Installed to `~/.claude/` via symlinks. Three-level progressive disclosure: frontmatter → SKILL.md body → `references/`.

**Your Task:** Audit the codebase against the principles below. For each finding, state what violates the principle, where, and what the fix should be.

---

### 1. Architectural Alignment

Each pattern must be faithful to its canonical definition. Cross-reference against authoritative sources (Microsoft Learn CQRS, Saga, Event Sourcing patterns).

**CQRS:** All read paths must hit materialized views. No tool handler should query raw events and aggregate inline. The materializer must follow canonical projection: event stream as write model, views as read model, views rebuildable from events on demand.

**Event Sourcing:** The event store must be strictly append-only — no mutation, no deletion. Events must be self-describing and sufficient to rebuild all state. Any data in state files (`.state.json`) that isn't derivable from events alone is an integrity violation. Event schemas must carry the metadata the ADR specifies (`correlationId`, `causationId`, `agentId`, `source`).

**Outbox:** The transactional outbox pattern requires the outbox write and the local store write to be atomic. Since JSONL has no transactions, verify that the atomicity approximation (idempotency keys across both stores) closes all gaps where an event could be appended to JSONL but not enqueued to the outbox.

**Saga:** Compensation actions must be idempotent — every compensating operation must be safe to re-execute (e.g., deleting an already-deleted worktree, archiving an already-archived file). Checkpoint files must be cleaned up after successful completion.

**HSM:** The transition algorithm must implement full HSM semantics: compound states, history, guards. Guard functions must be pure — no side effects.

---

### 2. Token Economy

Every byte in a tool response or skill body consumes agent context window.

**MCP tool responses:** Return the minimum payload agents need. Prefer reference IDs over embedded objects. Offer `compact` vs. `full` detail levels where applicable. Views must not embed unbounded arrays (e.g., growing event lists). Enforce a consistent, minimal `ToolResult` shape across all modules.

**Event payloads:** Event types must not carry large freeform strings (`detail`, `diagnostics`, `context`) that inflate view projections downstream. Keep events lean; attach detail to linked artifacts, not to the event itself.

**Skill budget:** SKILL.md files should stay under 1,300 words. Move templates, checklists, code blocks, and reference material to `references/` for on-demand access. Commands must reference skills via `@skills/` paths, not embed skill content inline. References should be linked for progressive discovery, not loaded eagerly.

**Rule budget:** Rules should be concise behavioral constraints, not verbose implementation guides. Consolidate related rules without losing specificity. Eliminate duplication with `CLAUDE.md` or skills. Scope rules to file patterns via `paths` frontmatter where applicable.

---

### 3. Operational Performance

**I/O efficiency:** Read paths should skip unnecessary parsing (e.g., pre-filtering event lines by sequence before `JSON.parse`). Verify that invariants supporting these optimizations (line-number-equals-sequence) hold under all conditions including compaction and manual edits.

**Memory management:** Caches must have bounded size with eviction policies. Verify eviction doesn't thrash in tight request loops. Idempotency key caches rebuilt from disk on restart must perform acceptably at scale.

**Concurrency safety:** In-process locks (promise chains) only protect a single Node.js process. If the architecture assumes single-instance, that assumption must be enforced (e.g., PID lock file), not just documented. Sequence number initialization must be safe under concurrent access.

**Cold start:** View materialization that replays all events must have a viable snapshot strategy to avoid latency degradation as event counts grow.

**Validation cost:** Zod validation on hot paths has measurable overhead. Reserve schema validation for system boundaries (external input, API responses), not internal data passing between trusted modules.

**Error clarity:** Retry exhaustion (CAS loops, optimistic concurrency) must produce clear, actionable errors — never silent data loss.

---

### 4. Skill & Content Quality

Validate against Anthropic's skill-building best practices and the three-level progressive disclosure model.

**Frontmatter:** Valid YAML with `---` delimiters. `name` in kebab-case matching folder name. `description` follows `[What] + [When] + [Capabilities]`, under 1,024 chars, includes trigger phrases, no XML angle brackets. `metadata` includes `author`, `version`, `category`, `phase-affinity`, and `mcp-server` where applicable.

**Progressive disclosure:** Level 1 (frontmatter) must be sufficient to decide when to load without reading the body — specific enough to avoid overtriggering, detailed enough to avoid undertriggering. Level 2 (body) focused on core instructions only. Level 3 (`references/`) holds all detailed guides, templates, and examples.

**Instruction quality:** Instructions must be specific and actionable ("Run X", "Call Y with Z"), not vague ("validate things properly"). Critical instructions at the top. Error handling documented as cause/solution pairs. Examples in `Trigger / Steps / Result` format concrete enough to serve as functional test cases.

**Composability:** No skill should assume it is the only loaded skill. No conflicting instructions for the same trigger conditions across simultaneously loaded skills. Skills must delegate to other skills where appropriate, not duplicate logic.

**Deterministic validation:** Validation steps (gate checks, review criteria, quality thresholds) should be implemented as executable scripts, not prose instructions. Code is deterministic; language interpretation is not.

---

### 5. Workflow Effectiveness

**Triggering accuracy:** For each skill, its `description` must cleanly discriminate between phrases that should and should not trigger it. No two skills should have ambiguous overlap in trigger conditions.

**Workflow completeness:** Each skill should complete its workflow without user correction. Step dependencies must be explicit. Rollback/compensation instructions must be included for steps that can fail. Multi-MCP workflows (Exarchos + GitHub + Graphite) must have clear phase separation, explicit data passing, and validation gates between phases.

**Pattern adherence:** Each skill should follow the appropriate Anthropic skill pattern (sequential orchestration, multi-MCP coordination, iterative refinement, context-aware tool selection, domain-specific intelligence). Iterative skills need explicit quality criteria and termination conditions. Multi-MCP skills need clear phase separation.

**Session consistency:** Skills must produce structurally consistent output across repeated runs with the same input. Output format must not depend on MCP response ordering. Checkpoint/resume flows must preserve sufficient context to continue without quality degradation.

**Overhead justification:** The token cost of loading a skill (SKILL.md + eagerly loaded references) must be justified by the efficiency gain over ad-hoc prompting. Skills where overhead may exceed benefit for simple tasks should offer a streamlined path.
