# Implementation Plan: VitePress Documentation Site

**Feature ID:** `vitepress-docs`
**Design:** `docs/designs/2026-03-08-vitepress-docs.md`
**Date:** 2026-03-08

## TDD Adaptation for Documentation

This is a documentation project, not a code project. TDD translates as:

- **RED:** Create stub files expected by VitePress config with placeholder content. Verify `npm run docs:build` succeeds with stubs.
- **GREEN:** Write actual content matching the design spec's content outline. Verify build still passes and content renders correctly.
- **REFACTOR:** Apply `/humanize` skill review, verify controlled vocabulary (Tier 1 terms), check cross-references between pages.

The "test" for each task is: VitePress builds successfully, pages render with correct nav/sidebar, and content matches the design spec's outline for that section.

## Dependency Graph

```
Task 001 (Scaffold) ──────────────────────────────────┐
    │                                                  │
    ├── Task 002 (Learn, 4 pages)                      │
    │     │                                            │
    │     ├── Task 003 (Guide: Getting Started, 3pp)   │
    │     │                                            │
    │     ├── Task 004 (Guide: Workflows, 3pp)         │
    │     │                                            │
    │     └── Task 005 (Guide: Capabilities, 3pp) ─────┤
    │                                                  │
    │     ┌── Task 009 (Examples, 6pp) ────────────────┤
    │     │   (depends on Guide tasks 003-005)          │
    │                                                  │
    ├── Task 006 (Reference: Core, 8pp) ───────────────┤
    │                                                  │
    ├── Task 007 (Reference: MCP Tools, 5pp) ──────────┤
    │                                                  │
    └── Task 008 (Architecture, 6pp) ──────────────────┘
                                                       │
                                             Task 010 (Root Integration)
```

## Parallel Groups

| Group | Tasks | Can Start After |
|-------|-------|-----------------|
| **A** | 001 (Scaffold) | — |
| **B** | 002 (Learn), 006 (Reference Core), 007 (Reference Tools), 008 (Architecture) | Task 001 |
| **C** | 003 (Guide: Getting Started), 004 (Guide: Workflows), 005 (Guide: Capabilities) | Task 002 |
| **D** | 009 (Examples) | Tasks 003, 004, 005 |
| **E** | 010 (Root Integration) | All above |

---

## Task 001: Scaffold

**Phase:** RED → GREEN → REFACTOR
**Files:** 6 files
**Parallelizable:** No (must complete first)

### RED: Create directory structure and config

1. Create `documentation/package.json` with VitePress devDependency
2. Create `documentation/.vitepress/config.ts` with full nav/sidebar config from design
3. Create `documentation/index.md` with hero layout and features grid
4. Copy `exarchos-logo.svg` → `documentation/public/logo.svg`
5. Copy `docs/assets/architecture.svg` → `documentation/public/architecture.svg`
6. Create `.github/workflows/docs.yml` for GitHub Pages deployment

### GREEN: Verify scaffold builds

1. Run `cd documentation && npm install && npm run docs:build`
2. Verify build succeeds (dead links ignored via config)
3. Run `npm run docs:preview` and verify landing page renders with hero, features, nav

### REFACTOR: Polish landing page copy

1. Apply `/humanize` to `index.md` feature descriptions
2. Verify hero text, tagline, and CTAs match design spec
3. Verify logo and architecture SVG render in public/

**Acceptance criteria:**
- `npm run docs:build` exits 0
- Landing page shows hero with "Durable SDLC Workflows for Claude Code"
- Nav shows Learn, Guide, Reference, Architecture, Examples
- Logo renders as favicon and in nav

**Dependencies:** None
**Branch:** `docs/scaffold`

---

## Task 002: Learn Section

**Phase:** RED → GREEN → REFACTOR
**Files:** 4 markdown pages
**Parallelizable:** Yes (after Task 001)

### RED: Create stub pages

Create these files with `# Title` + one-line placeholder:
1. `documentation/learn/index.md` — Why Exarchos
2. `documentation/learn/core-concepts.md` — Core Concepts
3. `documentation/learn/how-it-works.md` — How It Works
4. `documentation/learn/comparison.md` — Comparison

### GREEN: Write content

**learn/index.md — Why Exarchos**
Content outline from design:
- The problem: context compaction, workflow drift, no audit trail
- What developers already do (plan.md workflows) — adapt from README "You probably already do this"
- What Exarchos adds: persistence, verification, coordination
- Two human checkpoints: design approval and merge approval

Source material:
- README.md "You probably already do this" + "Your plan.md workflow, with teeth" sections
- `docs/market/exarchos/product-marketing-context.md` core pain + differentiation
- Controlled vocabulary: structured workflows, checkpoint/rehydrate, durable workflows

**learn/core-concepts.md — Core Concepts**
Content outline:
- Workflows: feature, debug, refactor — three types with distinct phase chains
- Phases and transitions — how the state machine moves through workflow stages
- Events and state — append-only event log, state derived from events
- Convergence gates — 5 dimensions (D1-D5) with concrete names, not codes
- Artifact references vs. inlining — why docs aren't dumped into context
- Agent roles — implementer, fixer, reviewer

Source material:
- ADR `adversarial-convergence-theory.md` for D1-D5 definitions
- `skills/quality-review/references/convergence-and-verdict.md` for gate execution
- README "What you get" section for agent roles
- Event type registry for event categories

**learn/how-it-works.md — How It Works**
Content outline:
- MCP server as state backend — single binary, stdio transport
- Event-sourced append-only log — why events, not mutable state
- State machine enforcing phase transitions — guards, gates
- Lazy schema registration — <500 tokens at startup
- Field projection for token efficiency — 90% reduction
- Lifecycle hooks for automation — pre-compact, session-start, guard, task-gate

Source material:
- README "Agent-first architecture" section
- ADR `agentic-workflow-theory.md` for formal model (simplified for public)
- Hooks definition from `hooks/hooks.json`
- MCP tool descriptions for the 4 composite tools

**learn/comparison.md — Comparison**
Content outline:
- Comparison table: Exarchos vs. Obra Superpowers vs. Claude Task Master vs. manual workflows
- Honest assessment: strengths and trade-offs
- Complementary tools (Serena, Context7, Microsoft Learn)

Source material:
- `docs/market/exarchos/competitive-analysis.md`
- `docs/market/exarchos/product-marketing-context.md` competitive landscape
- `docs/assets/superpowers-comparison.svg` (consider adapting)

### REFACTOR: Humanize and verify

1. Apply `/humanize` to all 4 pages
2. Check controlled vocabulary — replace any "governance", "enforcement", "lightweight" with Tier 1 terms
3. Verify cross-references between Learn pages are consistent
4. Verify sidebar navigation matches config

**Acceptance criteria:**
- All 4 pages build and render in sidebar
- Content matches design outline for each page
- No marketing hype, no superlatives
- Controlled vocabulary used consistently
- Passes `/humanize` review

**Dependencies:** Task 001
**Branch:** `docs/learn`

---

## Task 003: Guide — Getting Started

**Phase:** RED → GREEN → REFACTOR
**Files:** 3 markdown pages
**Parallelizable:** Yes (after Task 002)

### RED: Create stub pages

1. `documentation/guide/index.md` — Overview
2. `documentation/guide/installation.md` — Installation
3. `documentation/guide/first-workflow.md` — First Workflow

### GREEN: Write content

**guide/index.md — Overview**
- What you can build with Exarchos
- Prerequisites (Claude Code, Node 20+)
- Reading paths: quickstart → workflow deep-dives → capabilities → reference

**guide/installation.md — Installation**
- Marketplace install: `/plugin marketplace add lvlup-sw/exarchos` + `/plugin install exarchos@lvlup-sw`
- Dev companion: `npx @lvlup-sw/exarchos-dev` (optional, adds Serena, Context7, Microsoft Learn)
- Development setup: clone + build (collapsible details)
- Verifying installation: what to check after install

Source: README Install section (adapt directly)

**guide/first-workflow.md — First Workflow**
- Walk through `/ideate` on a small feature end-to-end
- Each phase explained as it happens (ideate → plan → delegate → review → synthesize)
- What to expect at each human checkpoint (design approval, merge approval)
- What the agent does between checkpoints (auto-continuation)
- The full cycle: design → plan → implement → review → ship

Source: New content, structured as a tutorial narrative

### REFACTOR: Humanize and verify

1. Apply `/humanize` to all 3 pages
2. Verify installation instructions match current README
3. Check that first-workflow tutorial is followable by a new user

**Acceptance criteria:**
- All 3 pages render in "Getting Started" sidebar group
- Installation instructions are accurate and current
- First workflow tutorial covers the complete feature lifecycle

**Dependencies:** Task 002 (cross-references to Learn concepts)
**Branch:** `docs/guide-getting-started`

---

## Task 004: Guide — Workflows

**Phase:** RED → GREEN → REFACTOR
**Files:** 3 markdown pages
**Parallelizable:** Yes (after Task 002)

### RED: Create stub pages

1. `documentation/guide/feature-workflow.md` — Feature Development
2. `documentation/guide/debug-workflow.md` — Debugging
3. `documentation/guide/refactor-workflow.md` — Refactoring

### GREEN: Write content

**guide/feature-workflow.md — Feature Development**
- Ideation: design exploration, approach selection, design document saved
- Planning: TDD implementation plan, task breakdown, parallelization groups
- Delegation: agent dispatch to worktrees, task claiming, progress tracking
- Review: two-stage verification (spec compliance → code quality)
- Synthesis: PR creation, shepherd to merge, cleanup

Phase chain: `ideate → plan → plan-review → delegate → review → synthesize → completed`

Source: Skills `brainstorming/SKILL.md`, `implementation-planning/SKILL.md`, `delegation/SKILL.md`, `spec-review/SKILL.md`, `quality-review/SKILL.md`, `synthesis/SKILL.md`

**guide/debug-workflow.md — Debugging**
- Triage: identify the issue, classify severity
- Investigation: root cause analysis
- Fix tracks: hotfix (quick) vs. thorough (full RCA + design)
- Validation: verify the fix, run gates

Phase chain: `triage → investigate → [rca → design → debug-implement → debug-validate → debug-review] | [hotfix-implement → hotfix-validate] → synthesize → completed`

Source: Skill `debug/SKILL.md` and references

**guide/refactor-workflow.md — Refactoring**
- Assessment: scope and impact analysis
- Brief: what changes and why
- Tracks: polish (targeted cleanup) vs. overhaul (structural redesign)
- Validation: verify no regressions

Phase chain: `explore → brief → [polish-implement → polish-validate → polish-update-docs] | [overhaul-plan → overhaul-plan-review → overhaul-delegate → overhaul-review → overhaul-update-docs] → synthesize → completed`

Source: Skill `refactor/SKILL.md` and references

### REFACTOR: Humanize and verify

1. Apply `/humanize` to all 3 pages
2. Verify phase chains match actual HSM transitions
3. Check that each workflow page is self-contained (reader shouldn't need to read another workflow first)

**Acceptance criteria:**
- All 3 pages render in "Workflows" sidebar group
- Each workflow covers all phases with clear descriptions
- Phase chains are accurate to the actual state machine

**Dependencies:** Task 002 (references to core concepts)
**Branch:** `docs/guide-workflows`

---

## Task 005: Guide — Capabilities

**Phase:** RED → GREEN → REFACTOR
**Files:** 3 markdown pages
**Parallelizable:** Yes (after Task 002)

### RED: Create stub pages

1. `documentation/guide/checkpoint-resume.md` — Checkpoint & Resume
2. `documentation/guide/agent-teams.md` — Agent Teams
3. `documentation/guide/review-process.md` — Review Process

### GREEN: Write content

**guide/checkpoint-resume.md — Checkpoint & Resume**
- When context compaction happens and why it matters
- `/checkpoint`: what gets saved (workflow state, artifacts, task progress)
- `/rehydrate`: what gets restored, token cost (~2-3k tokens), how it works
- `/reload`: lighter-weight context recovery (re-inject behavioral guidance)
- `/autocompact`: proactive compaction management (toggle, threshold)
- When to use each command

Source: Skill `workflow-state/SKILL.md`, hooks `PreCompact` definition, README "Checkpoint and resume" section

**guide/agent-teams.md — Agent Teams**
- Three roles: implementer (TDD in worktrees), fixer (resume failed tasks), reviewer (read-only quality checks)
- Worktree isolation: why (parallel work, no conflicts) and how (git worktree create/cleanup)
- Dispatch and coordination via `/delegate`
- Runbook protocol: machine-readable step sequences with gate semantics
- Fixer recovery: how fixers get full context from failed implementer tasks

Source: Agent specs `agents/implementer.md`, `agents/fixer.md`, `agents/reviewer.md`; skill `delegation/SKILL.md`, `git-worktrees/SKILL.md`

**guide/review-process.md — Review Process**
- Stage 1: spec compliance — does it match the design? (provenance chain, TDD compliance)
- Stage 2: code quality — is it well-written? (static analysis, security scan, operational resilience)
- Verification scripts: deterministic checks, exit codes 0/1/2, not vibes
- Convergence gates: the 5 quality dimensions (use full names, not D1-D5)
- What happens on APPROVED / NEEDS_FIXES / BLOCKED

Source: Skills `spec-review/SKILL.md`, `quality-review/SKILL.md`; references `convergence-and-verdict.md`, `gate-execution.md`

### REFACTOR: Humanize and verify

1. Apply `/humanize` to all 3 pages
2. Verify agent role descriptions match actual agent specs
3. Check convergence gate terminology uses full names, not D1-D5 codes

**Acceptance criteria:**
- All 3 pages render in "Key Capabilities" sidebar group
- Checkpoint/resume commands are accurate with correct token estimates
- Agent descriptions match the actual agent spec files
- Review process matches the actual gate execution flow

**Dependencies:** Task 002 (references to core concepts)
**Branch:** `docs/guide-capabilities`

---

## Task 006: Reference — Core

**Phase:** RED → GREEN → REFACTOR
**Files:** 8 markdown pages
**Parallelizable:** Yes (after Task 001)

### RED: Create stub pages

1. `documentation/reference/index.md` — Reference Overview
2. `documentation/reference/commands.md` — Commands
3. `documentation/reference/skills.md` — Skills
4. `documentation/reference/agents.md` — Agents
5. `documentation/reference/scripts.md` — Scripts
6. `documentation/reference/events.md` — Events
7. `documentation/reference/configuration.md` — Configuration
8. `documentation/reference/convergence-gates.md` — Convergence Gates

### GREEN: Write content

**reference/index.md — Overview**
- How to use this reference section
- MCP tool architecture summary (4 composite tools + describe pattern)
- Quick links to each reference page

**reference/commands.md — Commands**
- All 15 slash commands with: syntax, description, when to use
- Grouped by purpose:
  - Workflow start: `/ideate`, `/debug`, `/refactor`
  - Lifecycle: `/plan`, `/delegate`, `/review`, `/synthesize`, `/shepherd`, `/cleanup`, `/tdd`
  - Context management: `/checkpoint`, `/rehydrate`, `/reload`, `/autocompact`
  - Attribution: `/tag`
- Note: As a plugin, commands are namespaced `/exarchos:<command>`

Source: All 15 command files in `commands/`

**reference/skills.md — Skills**
- Skill anatomy: `SKILL.md` with YAML frontmatter + `references/` subdirectory
- Frontmatter schema: `name` (kebab-case), `description` (<=1,024 chars), `metadata`
- MCP server dependency: `metadata.mcp-server: exarchos`
- Table of all 11 production skills with name, description, phase affinity

Source: All skill SKILL.md frontmatter blocks

**reference/agents.md — Agents**
- Agent spec format (Claude Code native `.md` files)
- Per-agent reference:
  - Implementer: TDD in worktrees, red-green-refactor protocol
  - Fixer: diagnose and repair failures, adversarial verification
  - Reviewer: read-only quality analysis, design compliance, test coverage
- How specs are served via `exarchos_orchestrate({ action: "agent_spec" })`

Source: `agents/implementer.md`, `agents/fixer.md`, `agents/reviewer.md`

**reference/scripts.md — Scripts**
- Validation script conventions: `set -euo pipefail`, deterministic
- Exit codes: 0 (pass), 1 (fail), 2 (skip)
- Co-located tests (`.test.sh` alongside each script)
- Script resolution: `EXARCHOS_PLUGIN_ROOT/scripts/` → `~/.claude/scripts/`
- How skills invoke scripts: `exarchos_orchestrate({ action: "run_script" })`

Source: Scripts directory conventions, skill references

**reference/events.md — Events**
- Event store model: append-only JSONL streams per feature
- Event schema: `{ timestamp, type, payload, source }`
- Emission sources: `auto` (MCP server), `model` (agent), `hook` (lifecycle), `planned` (future)
- Event categories with all types listed:
  - Workflow (11), Task (5), Quality (10), Stack (4), Telemetry (3), Benchmark (1), Team (8), Review (3), Remediation (2), Shepherd (4), Session (8), Other (1)

Source: `servers/exarchos-mcp/src/event-store/schemas.ts` event type registry (65 types)

**reference/configuration.md — Configuration**
- Plugin settings (`settings.json`): permissions, model selection
- Lifecycle hooks (8 hooks): PreCompact, SessionStart, PreToolUse, TaskCompleted, TeammateIdle, SubagentStart, SubagentStop, SessionEnd
- Integrations: Serena (semantic code analysis), Context7 (library docs), Microsoft Learn (Azure/.NET docs)
- Plugin manifest: `.claude-plugin/plugin.json` structure

Source: `settings.json`, `hooks/hooks.json`, `.claude-plugin/plugin.json`, README integrations table

**reference/convergence-gates.md — Convergence Gates**
- The 5 dimensions with full names and concrete criteria:
  - Specification Fidelity & TDD Compliance (D1)
  - Architectural Pattern Compliance (D2)
  - Context Economy & Token Efficiency (D3)
  - Operational Resilience (D4)
  - Workflow Determinism & Variance Reduction (D5)
- Gate execution by phase boundary (which gates run where)
- Blocking vs. informational gates
- Verdicts: APPROVED, NEEDS_FIXES, BLOCKED

Source: ADR `adversarial-convergence-theory.md`, skill references `convergence-and-verdict.md`, `gate-execution.md`

### REFACTOR: Humanize and verify

1. Apply `/humanize` to all 8 pages
2. Verify command list matches all 15 commands in `commands/`
3. Verify event types match `schemas.ts` registry
4. Verify hook definitions match `hooks.json`
5. Check controlled vocabulary throughout

**Acceptance criteria:**
- All 8 pages render in Reference sidebar
- Command reference covers all 15 commands accurately
- Event reference lists all 65 event types with correct categories
- Configuration page matches actual settings, hooks, and plugin manifest
- Convergence gates use full dimension names, not just D1-D5 codes

**Dependencies:** Task 001
**Branch:** `docs/reference-core`

---

## Task 007: Reference — MCP Tools

**Phase:** RED → GREEN → REFACTOR
**Files:** 5 markdown pages
**Parallelizable:** Yes (after Task 001)

### RED: Create stub pages

1. `documentation/reference/tools/index.md` — Tools Overview
2. `documentation/reference/tools/workflow.md` — Workflow Tool
3. `documentation/reference/tools/event.md` — Event Tool
4. `documentation/reference/tools/orchestrate.md` — Orchestrate Tool
5. `documentation/reference/tools/view.md` — View Tool

### GREEN: Write content

**reference/tools/index.md — Tools Overview**
- Composite tool pattern: 4 visible tools, each a discriminated union keyed on `action`
- Lazy schema loading via `describe` action — startup cost <500 tokens
- Same `dispatch()` backs MCP transport and CLI
- Agent-first design: structured input over natural language

**reference/tools/workflow.md — exarchos_workflow**
- Actions: init, get, set, cancel, cleanup, reconcile, describe
- Per-action: parameters, return type, auto-emitted events, example usage
- Phase transition semantics: `set` with `phase` auto-emits `workflow.transition`
- Field projection on `get`: how to request specific fields only

Source: MCP tool schema for workflow actions

**reference/tools/event.md — exarchos_event**
- Actions: append, query, batch_append, describe
- Per-action: parameters, return type, example usage
- Stream model: one JSONL file per featureId
- Query filtering: by type, time range, limit

Source: MCP tool schema for event actions

**reference/tools/orchestrate.md — exarchos_orchestrate**
- Most complex tool — group actions by category:
  - Task lifecycle: task_claim, task_complete, task_fail
  - Review & delegation: review_triage, prepare_delegation, prepare_synthesis, assess_stack
  - Quality gates (blocking): check_static_analysis, check_provenance_chain, check_plan_coverage, check_tdd_compliance, check_review_verdict
  - Quality gates (informational): check_security_scan, check_context_economy, check_operational_resilience, check_workflow_determinism, check_design_completeness, check_task_decomposition, check_convergence, check_post_merge
  - Utilities: check_event_emissions, run_script, runbook, agent_spec, describe
- Per-action: parameters, return type, gate metadata (dimension, blocking)

Source: MCP tool schema for orchestrate actions

**reference/tools/view.md — exarchos_view**
- Actions grouped by category:
  - Pipeline & status: pipeline, workflow_status, tasks
  - Stack & positioning: stack_status, stack_place
  - Telemetry & performance: telemetry, team_performance, delegation_timeline
  - Quality & readiness: code_quality, delegation_readiness, synthesis_readiness, shepherd_status, convergence
  - describe
- Per-action: parameters, return type, example usage

Source: MCP tool schema for view actions

### REFACTOR: Humanize and verify

1. Apply `/humanize` to all 5 pages
2. Verify all actions listed match actual MCP tool implementations
3. Verify gate metadata (dimension, blocking) matches source code
4. Check that examples are realistic and accurate

**Acceptance criteria:**
- All 5 pages render in "MCP Tools" sidebar group
- Every action on every tool is documented
- Gate metadata (blocking, dimension) is accurate
- Examples compile conceptually (valid JSON parameters)

**Dependencies:** Task 001
**Branch:** `docs/reference-tools`

---

## Task 008: Architecture Section

**Phase:** RED → GREEN → REFACTOR
**Files:** 6 markdown pages
**Parallelizable:** Yes (after Task 001)

### RED: Create stub pages

1. `documentation/architecture/index.md` — Overview
2. `documentation/architecture/event-sourcing.md` — Event Sourcing
3. `documentation/architecture/state-machine.md` — State Machine
4. `documentation/architecture/token-efficiency.md` — Token Efficiency
5. `documentation/architecture/agent-model.md` — Agent Model
6. `documentation/architecture/design-rationale.md` — Design Rationale

### GREEN: Write content

**architecture/index.md — Overview**
- Architecture diagram (embed SVG from `/architecture.svg`)
- System components: MCP server, event store, state machine, agent specs, lifecycle hooks
- How they connect: Claude Code ↔ MCP server ↔ event store ↔ state files
- Design principles: agent-first, event-sourced, token-efficient

Source: README "Agent-first architecture", `docs/assets/architecture.svg`

**architecture/event-sourcing.md — Event Sourcing**
- Why event sourcing for agent workflows (durability, auditability, reconciliation)
- Append-only log design: JSONL per feature, immutable events
- State reconstruction: `reconcile` rebuilds state from events
- Trade-offs vs. mutable state: storage cost, query complexity, but full history

Source: ADR `agentic-workflow-theory.md` (simplified), event store implementation concepts

**architecture/state-machine.md — State Machine**
- Hierarchical state machine (HSM) model — explain simply, avoid academic framing
- Phase transitions: what triggers them, what guards prevent invalid transitions
- Three workflow types and their phase chains
- How the state machine enforces workflow discipline without blocking the developer

Source: ADR `adversarial-convergence-theory.md` (simplified), workflow phase definitions

**architecture/token-efficiency.md — Token Efficiency**
- Problem: LLM context windows are finite; every wasted token is capacity lost
- Lazy schema registration: tools register with slim descriptions, full schemas load via `describe`
- Field projection: request only the state fields you need (90% reduction)
- Artifact references: design docs and plans referenced by path, never inlined into context
- Diff-based review: code review sends diffs, not full files (97% reduction)
- Quantified claims with concrete numbers

Source: README token efficiency claims, ADR `context-token-budget.md`

**architecture/agent-model.md — Agent Model**
- Typed agents vs. generic prompting — why distinct roles matter
- Worktree isolation: each agent gets a clean git worktree, no shared working directory
- Runbook protocol: machine-readable orchestration sequences (action, schemas, gates)
- Hook system: pre/post tool execution for automated verification
- Task lifecycle: assigned → claimed → progressed → completed/failed
- Failure recovery: fixer agents resume with full context from the failed task

Source: Agent specs, skill `delegation/SKILL.md`, hooks definition

**architecture/design-rationale.md — Design Rationale**
- Reworked from internal ADRs — remove internal context, keep the reasoning
- Key decisions:
  - Why MCP over markdown files (durability, structured I/O, validation)
  - Why event sourcing (audit trail, reconciliation, crash recovery)
  - Why typed agents (scoped tools, focused prompts, failure isolation)
  - Why convergence gates (automated verification > manual review)
  - Why two human checkpoints (design approval + merge approval)
- Trade-offs acknowledged honestly:
  - Higher learning curve than raw Claude Code
  - Claude Code only (deep integration over shallow portability)
  - MCP server overhead (trade-off for durability)

Source: All 8 ADRs consolidated; `product-marketing-context.md` for honest trade-offs

### REFACTOR: Humanize and verify

1. Apply `/humanize` to all 6 pages
2. Verify architecture diagram renders correctly
3. Check that ADR-sourced content has been properly reworked (no internal references, no project-specific jargon)
4. Verify quantified claims match README numbers
5. Ensure academic concepts (CMDP, HSM) are explained in plain language

**Acceptance criteria:**
- All 6 pages render in Architecture sidebar
- Architecture diagram displays on overview page
- No internal-only references (design doc links, internal ADR references)
- Academic concepts explained without leading with jargon
- Trade-offs section is honest and specific

**Dependencies:** Task 001
**Branch:** `docs/architecture`

---

## Task 009: Examples Section

**Phase:** RED → GREEN → REFACTOR
**Files:** 6 markdown pages
**Parallelizable:** Yes (after Tasks 003, 004, 005)

### RED: Create stub pages

1. `documentation/examples/index.md` — Overview
2. `documentation/examples/feature-development.md` — Feature Development
3. `documentation/examples/bug-investigation.md` — Bug Investigation
4. `documentation/examples/code-refactor.md` — Code Refactor
5. `documentation/examples/agent-delegation.md` — Agent Delegation
6. `documentation/examples/session-recovery.md` — Session Recovery

### GREEN: Write content

**examples/index.md — Overview**
- What the examples demonstrate (real workflow scenarios, not toy demos)
- How to follow along (install Exarchos first, then try each scenario)
- Which example to start with based on what you want to learn

**examples/feature-development.md — Feature Development**
- Annotated walkthrough: building a feature from `/ideate` to merged PR
- Show key interactions: design exploration, plan approval, delegation output, review results
- Include representative command/tool invocations and responses
- Highlight the two human checkpoints

**examples/bug-investigation.md — Bug Investigation**
- Annotated walkthrough: triaging and fixing a bug via `/debug`
- Show the hotfix vs. thorough track decision point
- Include triage output, investigation steps, fix validation

**examples/code-refactor.md — Code Refactor**
- Annotated walkthrough: improving code via `/refactor`
- Show the polish vs. overhaul track decision
- Include assessment output, brief, implementation steps

**examples/agent-delegation.md — Agent Delegation**
- Multi-agent scenario: dispatching 3+ tasks to implementer agents
- Show worktree creation, parallel execution, task completion
- Show fixer recovery when a task fails
- Show reviewer agent checking merged results

**examples/session-recovery.md — Session Recovery**
- Checkpoint mid-feature: show `/checkpoint` saving state
- Close session, come back later
- Rehydrate: show `/rehydrate` restoring context (~2-3k tokens)
- Continue workflow from where it left off

Source: New narrative content. Use `docs/assets/demo-rehydrate.gif` as inspiration for session recovery example.

### REFACTOR: Humanize and verify

1. Apply `/humanize` to all 6 pages
2. Verify examples are realistic and followable
3. Check that command syntax matches actual commands
4. Verify cross-references to Guide pages are correct

**Acceptance criteria:**
- All 6 pages render in Examples sidebar
- Each example tells a complete story from start to finish
- Command invocations match actual Exarchos commands
- Examples are realistic enough to follow along with

**Dependencies:** Tasks 003, 004, 005 (Guide pages for cross-references)
**Branch:** `docs/examples`

---

## Task 010: Root Integration

**Phase:** RED → GREEN → REFACTOR
**Files:** 2 existing files modified
**Parallelizable:** No (after all content tasks)

### RED: Verify current state

1. Read current `package.json` scripts
2. Read current README.md docs link
3. Verify full VitePress build succeeds with all content: `cd documentation && npm run docs:build`

### GREEN: Add integration points

1. Add convenience scripts to root `package.json`:
   ```json
   "docs:dev": "cd documentation && npm run docs:dev",
   "docs:build": "cd documentation && npm run docs:build",
   "docs:preview": "cd documentation && npm run docs:preview"
   ```

2. Update README.md docs link from `[Docs](docs/)` to `[Docs](https://lvlup-sw.github.io/exarchos/)`

### REFACTOR: Verify everything works

1. Run `npm run docs:build` from root — verify it succeeds
2. Run `npm run docs:preview` — verify full site renders
3. Check all navigation links work
4. Verify search indexes content correctly

**Acceptance criteria:**
- `npm run docs:build` works from project root
- README links to the GitHub Pages URL
- Full site builds and previews without errors
- Local search works across all sections

**Dependencies:** All content tasks (001-009)
**Branch:** `docs/root-integration`

---

## Summary

| Task | Title | Pages | Dependencies | Parallel Group |
|------|-------|-------|-------------|----------------|
| 001 | Scaffold | 3 + config | None | A |
| 002 | Learn | 4 | 001 | B |
| 003 | Guide: Getting Started | 3 | 002 | C |
| 004 | Guide: Workflows | 3 | 002 | C |
| 005 | Guide: Capabilities | 3 | 002 | C |
| 006 | Reference: Core | 8 | 001 | B |
| 007 | Reference: MCP Tools | 5 | 001 | B |
| 008 | Architecture | 6 | 001 | B |
| 009 | Examples | 6 | 003-005 | D |
| 010 | Root Integration | 2 (edits) | All | E |
| **Total** | | **43 files** | | |

**Critical path:** 001 → 002 → [003, 004, 005] → 009 → 010
**Maximum parallelism:** Group B (4 tasks: Learn, Ref Core, Ref Tools, Architecture) after scaffold
