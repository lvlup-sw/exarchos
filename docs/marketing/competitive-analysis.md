# Exarchos Competitive Analysis

## Market Context

The Claude Code plugin marketplace has 9,000+ plugins as of early 2026. The SDLC/workflow category is crowded at the **skill layer** (behavioral suggestions, slash commands, task management) but essentially empty at the **durable governance layer** (persistent state, phase-gated transitions, convergence verification).

Key market trends favoring Exarchos's positioning:
- **Durable execution** has won the architecture debate (Temporal, Restate, AWS Lambda Durable Functions)
- **Context persistence** is the #1 unsolved problem in agent tooling (GitHub issues #1345, #7584)
- **MCP** is the emerging standard for agent-tool integration (network effects)
- **Bounded autonomy** with human checkpoints is the production pattern (not full autonomy)

## Competitive Matrix

| Capability | Exarchos | Superpowers | Claude Task Master | Auto-Claude | Raw Claude Code |
|:-----------|:--------:|:-----------:|:-----------------:|:-----------:|:---------------:|
| Durable state (survives compaction) | Yes | No | Partial | No | No |
| Phase-gated SDLC workflow | Yes | Partial | No | Partial | No |
| Multi-dimensional quality gates | Yes (5D) | No | No | No | No |
| Parallel agent teams | Yes | Partial | No | Yes | Yes |
| Event-sourced audit trail | Yes | No | No | No | No |
| Provenance chain (req → code → test) | Yes | No | No | No | No |
| Checkpoint-resume across sessions | Yes | No | No | No | No |
| Enforcement vs. suggestion | Enforced | Suggested | N/A | N/A | N/A |
| Free / open-source | Yes | Yes | Yes | Yes | N/A |

## Per-Competitor Assessment

### Obra Superpowers
**What they do:** 20+ skill files that shape Claude Code behavior. Enforces brainstorm → plan → implement workflow through behavioral prompts. Supports TDD, code review, debugging, subagent dispatch, git worktrees.

**Strengths:**
- Mature ecosystem with active community and content marketing
- Cross-platform (Claude Code, Cursor, Codex, OpenCode)
- Low friction install — just markdown files, no MCP server
- "Writing skills from conversations" is a compelling feature
- Strong brand recognition in the Claude Code community

**Weaknesses:**
- Stateless — no persistence across sessions or context compaction
- Behavioral suggestions, not enforced gates — agents can (and do) ignore them
- No audit trail — no record of what the agent actually did
- No multi-dimensional quality verification
- No provenance chain (requirement → test → code traceability)

**Our differentiation:** Superpowers shapes behavior; Exarchos persists and verifies it. They're complementary layers, not direct replacements.

### Claude Task Master
**What they do:** Task management system for AI-driven development. Tracks tasks, manages dependencies, integrates with Cursor.

**Strengths:**
- Simple mental model (task list)
- Cursor integration
- Lower learning curve

**Weaknesses:**
- Task tracking, not workflow governance — no phase gates, no quality verification
- Partial persistence (file-based, not event-sourced)
- No team coordination
- No SDLC structure beyond task ordering

**Our differentiation:** Task Master tracks what to do; Exarchos structures how to do it and verifies that it was done correctly.

### Auto-Claude
**What they do:** Full SDLC autonomous multi-agent framework with kanban UI. Manages multiple Claude Code agents working on tasks.

**Strengths:**
- Full autonomy — agents work through entire workflows
- Visual kanban interface
- Multi-agent coordination

**Weaknesses:**
- No durable state — context loss kills the workflow
- No quality gates — agents proceed without verification
- No audit trail
- No checkpoint-resume

**Our differentiation:** Auto-Claude optimizes for speed; Exarchos optimizes for verifiable correctness with durability.

### Generic SDLC Skill Bundles
Includes: Fullstack Dev Skills (65 skills), wshobson/agents (112 agents), Slash Command Suite (119+ commands).

**Strengths:**
- Breadth of coverage
- Many specialized capabilities

**Weaknesses:**
- Collections of independent tools, not integrated workflows
- No state management, no phase transitions, no quality gates
- Quantity over coherence

**Our differentiation:** Exarchos is an integrated toolchain, not a skill collection.

## Exarchos Weaknesses (Honest Assessment)

| Weakness | Impact | Status |
|:---------|:-------|:-------|
| **Higher learning curve** | Users must understand phases, checkpoints, and convergence gates to get full value | Mitigated by auto-continuation (only 2 human checkpoints) |
| **Smaller community** | Less content, fewer examples, fewer community contributions than Superpowers | Growing; need content marketing strategy |
| **Claude Code only** | Unlike Superpowers, doesn't work with Cursor, Codex, or other agents | By design — deep integration > shallow portability |
| **MCP server overhead** | Requires a running MCP server process; heavier than pure markdown skills | Tradeoff for durability and convergence gates |
| **Onboarding friction** | New users must install marketplace + plugin + optional companion | Standard for plugin ecosystem; documented in README |

## Competitive Moat

The moat is the intersection of three capabilities no competitor offers together:

1. **Event-sourced durability** — Workflows survive context compaction, session restarts, and machine switches. This requires an MCP server with an append-only event store — it can't be replicated with markdown files.

2. **Convergence gates** — Five independent quality dimensions verified at every phase boundary via deterministic scripts. Not behavioral suggestions; executable verification with event-recorded results.

3. **Provenance chain** — Requirement IDs trace from design document through plan tasks through tests through merged code. Gaps are detectable by deterministic query, not human review.

Each capability individually is achievable. The combination — durable state that feeds convergence gates that verify provenance chains — creates a system where the whole is greater than the parts.

## Anti-Positioning (What Exarchos Is NOT)

| Exarchos is NOT | Why this matters |
|:----------------|:-----------------|
| A Cursor/Windsurf replacement | Exarchos extends Claude Code, not replaces your editor |
| An IDE or editor plugin | It's a workflow layer, not a code editing tool |
| A model wrapper or inference layer | It orchestrates process, not model calls |
| A task tracker (like Linear/Jira) | It's a workflow engine with quality verification, not a project management tool |
| Enterprise-only or "governance theater" | It's built for solo devs who want structure, not compliance officers |

## Positioning Risks & Mitigations

| Risk | Impact | Mitigation |
|:-----|:-------|:-----------|
| "Structure" implies rigidity | Solo devs avoid tools that slow them down | Messaging emphasizes structure enables speed: "auto-continues between human checkpoints" — you approve twice (design, merge), everything else flows |
| "Convergence gates" sounds academic | Users skip past unfamiliar jargon | Always follow with concrete language: "convergence gates — automated quality checks at every phase boundary" |
| Comparison to Superpowers triggers defensiveness | Superpowers community may push back | Position as complementary layer, not replacement: "Superpowers shapes behavior; Exarchos persists and verifies it" |
| "Audit trail" sounds enterprise | Solo devs don't think they need auditing | Reframe as personal utility: "trace what your agent did and why — especially useful when context dies mid-task" |
| Free product implies low quality | Users may assume "you get what you pay for" | Emphasize Apache-2.0, active development cadence, test coverage, and the Basileus platform story |
