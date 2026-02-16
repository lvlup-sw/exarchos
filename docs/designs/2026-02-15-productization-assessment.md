# Assessment: Exarchos Productization Readiness

An architectural assessment of how the current Exarchos design supports two goals: (1) shipping a production-quality open-source tool for local agent governance, and (2) productizing the distributed agent platform as an optional SaaS integration.

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [The Aspire Model Applied to Exarchos](#2-the-aspire-model-applied-to-exarchos)
3. [Current Architecture Assessment](#3-current-architecture-assessment)
4. [Gap Analysis](#4-gap-analysis)
5. [The Differentiator Triad](#5-the-differentiator-triad)
6. [Developer Team Ergonomics](#6-developer-team-ergonomics)
7. [Productization Roadmap](#7-productization-roadmap)
8. [Risk Assessment](#8-risk-assessment)

---

## 1. Product Vision

### Two-Tier Product

| Tier | Product | Model | Value Proposition |
|---|---|---|---|
| **Local** | Exarchos OSS | Open source (MIT/Apache) | Production-quality agent governance for any AI coding assistant. Opinionated SDLC workflows with extension points. Works fully offline. |
| **Cloud** | Exarchos Cloud (via Basileus) | Optional SaaS | Remote compute (Agentic Coder containers), team-wide analytics (CodeQualityView aggregation), and the verification flywheel. Amplifies the local tool without replacing it. |

The local tool must be compelling on its own — the SaaS tier amplifies but never gates local functionality. This follows the Aspire principle: the local development experience is complete. Cloud deployment is an optional next step that uses the same primitives.

### Core Differentiator

The market for AI coding tools (Devin, Cursor, Windsurf, Cline, Aider) is converging on code generation. Most tools optimize for a single dimension: *"give it a prompt, get code back."* The differentiator is not better code generation — it's what happens around code generation:

| Dimension | What Competitors Do | What Exarchos Does |
|---|---|---|
| **Analytics** | Token usage dashboards | Event-sourced workflow telemetry, CodeQualityView, verification flywheel with attribution analysis |
| **Execution** | Single-agent code generation | Multi-agent orchestration with team coordination, parallel worktrees, progressive stacking, tiered model selection |
| **Verification** | "Run tests" as a step | Layered quality gates, property-based testing infrastructure, benchmark regression detection, auto-remediation with bounded escalation |

No competitor combines all three into a single coherent system. Devin has execution (autonomous coding) but weak analytics and verification. Cursor has good code generation but no workflow orchestration. The triad — analytics, execution, verification — is the product.

---

## 2. The Aspire Model Applied to Exarchos

.NET Aspire's design philosophy provides the right model for Exarchos productization. Aspire makes distributed systems feel local by providing opinionated defaults with a code-first approach and rich extension points. The same principles apply to making autonomous agent workflows feel manageable.

### Aspire Principle → Exarchos Application

**1. Opinionated Defaults**

Aspire ships with sensible defaults for health checks, telemetry, resilience, and service discovery. You get a working system immediately. Customization is available but not required.

*Exarchos equivalent:* Ship three polished workflows (feature, debug, refactor) with TDD enforcement, progressive stacking, and layered quality gates as the default experience. These are the "starter templates" — they work out of the box for TypeScript and .NET projects. Users who want different workflows can extend without forking.

| Aspire | Exarchos |
|---|---|
| Default health checks | Default quality gates (build, test, lint) |
| Default telemetry (OpenTelemetry) | Default event sourcing (workflow telemetry) |
| Default resilience (Polly) | Default circuit breaker (3 fix cycles) |
| Default service discovery | Default task routing (local/remote scoring) |

**2. Code-First Configuration**

Aspire defines application topology in C# code, not YAML. This gives type safety, IDE support, and version control.

*Exarchos equivalent:* Workflow definitions should be code, not prose. Currently, the HSM definitions are TypeScript code (`hsm-definitions.ts`), but the skill logic is markdown prose that agents interpret. The gap: skills are not programmatically composable. A code-first approach would mean workflow steps are defined as typed functions, with markdown serving as documentation — not as the execution specification.

This doesn't mean abandoning markdown skills. It means the skills reference typed workflow primitives:

```typescript
// Aspire-style: typed workflow definition
const featureWorkflow = defineWorkflow('feature', {
  phases: ['ideate', 'plan', 'plan-review', 'delegate', 'review', 'synthesize'],
  guards: {
    'plan-review → delegate': [requirePlanApproval, requireDesignCoverage],
    'delegate → review': [requireAllTasksComplete],
  },
  defaults: {
    tddEnforcement: true,
    stackingStrategy: 'progressive',
    qualityGates: ['build', 'test', 'lint', 'security'],
  },
});
```

Skills remain markdown for the agent to follow, but the workflow engine validates transitions, guards, and gates programmatically. The markdown becomes guidance for the agent; the code becomes the contract.

**3. Extension Points (Integration Model)**

Aspire's integration gallery lets you add Redis, Postgres, RabbitMQ, etc. as typed components. Each integration is a package that plugs into the orchestration model.

*Exarchos equivalent:* An integration model for:

| Extension Type | What It Provides | Example |
|---|---|---|
| **Workflow Pack** | Custom HSM definition + skills + guards | `@exarchos/workflow-pack-frontend` (React-specific workflow with component testing) |
| **Quality Gate** | Custom gate implementation + CI config | `@exarchos/gate-mutation-testing` (Stryker integration) |
| **View Projection** | Custom CQRS view from events | `@exarchos/view-cost-tracking` (token cost analytics) |
| **Task Router** | Custom routing strategy | `@exarchos/router-gpu` (route GPU-heavy tasks to cloud) |
| **AI Client Adapter** | Bridge to non-Claude AI | `@exarchos/adapter-openai` (OpenAI Codex support) |

The key insight from Aspire: integrations should be **packages**, not configuration. You `npm install @exarchos/gate-mutation-testing` and it registers itself. No manual wiring.

**4. Local-First, Cloud-Optional**

Aspire's AppHost runs your entire distributed system locally. Cloud deployment is a separate concern that uses the same topology definition.

*Exarchos equivalent:* The local MCP server runs the complete workflow engine. The SaaS tier is activated by setting `mode: "dual"` — events start syncing, remote compute becomes available, team-wide views materialize. The workflow definitions, skills, guards, and gates are identical in both modes. The only difference is where tasks execute and where views are aggregated.

**5. Dashboard as First-Class Citizen**

Aspire ships a developer dashboard showing traces, logs, metrics, and resource states. It's not an afterthought — it's part of the core experience.

*Exarchos equivalent:* The CQRS views (PipelineView, CodeQualityView, TeamStatusView) are the data layer. What's missing is the presentation layer. For a production tool, this means:

- **CLI dashboard** — `exarchos status` renders a terminal UI showing active workflows, task progress, quality metrics, and team composition. This is the local equivalent of Aspire's dashboard.
- **Web dashboard** — SaaS tier materializes views into a web UI for team-wide observability. Shows the same data as the CLI but across all team members' workflows.

---

## 3. Current Architecture Assessment

### What's Production-Ready

| Component | State | Assessment |
|---|---|---|
| **Workflow HSM** | Implemented | 3 workflow types, 26 guards, CAS versioning, saga compensation. Solid foundation. |
| **Event Store** | Implemented | JSONL with optimistic concurrency, idempotency keys, `.seq` files for O(1) init. Production-viable for single-developer use. |
| **CQRS Views** | Implemented | 6 view types, LRU-bounded materializer, snapshot persistence, lazy pagination. Well-architected. |
| **Team Coordinator** | Implemented | Full lifecycle (spawn/message/broadcast/shutdown). Role definitions, composition strategy. |
| **Task Management** | Implemented | Claim/complete/fail with optimistic concurrency. |
| **CLI Hooks** | Implemented | SessionStart (auto-resume), PreCompact (checkpoint), guard, task-gate, teammate-gate, subagent-context. |
| **Validation Scripts** | Implemented | 39 scripts with consistent patterns, 26 integration tests. |
| **Telemetry** | Implemented | Tool-level benchmarks with baselines, percentile calculations. |
| **Test Coverage** | Strong | 62 test files, co-located, Vitest. |

### What Needs Work for Production Quality

| Component | Gap | Severity |
|---|---|---|
| **Error handling** | MCP server errors surface as tool result failures, not structured diagnostics. No error taxonomy. | Medium |
| **Observability** | No structured logging. No OpenTelemetry integration. Events are observability data but not in a standard format. | High for production |
| **Configuration validation** | No schema validation for `bridge-config.json` or installer settings. Silent failures on misconfiguration. | Medium |
| **Upgrade path** | State file migration support exists but no versioned migration system. Breaking changes to event schemas have no automated migration. | High for public release |
| **Documentation** | CLAUDE.md is thorough for contributors. No user-facing documentation (getting started, tutorials, API reference). | Critical for public release |
| **CLI experience** | Entry points are `node dist/cli.js <command>`. No `npx exarchos` or global install. No `--help` for discovery. | High for ergonomics |
| **Extension points** | None. Custom workflows, gates, views, and routes all require forking the server. | Critical for Aspire model |
| **AI client abstraction** | Content layer (skills, rules, spawn prompts) assumes Claude Code. No abstraction for other AI clients. | High for public adoption |

---

## 4. Gap Analysis

### Gap 1: No Extension Architecture

**Current state:** The MCP server is a monolith. Adding a custom workflow, gate, view, or event type requires modifying source code in `plugins/exarchos/servers/exarchos-mcp/src/`.

**Required state (Aspire model):** Plugin-based extension where packages register capabilities at startup.

**Design direction:**

```typescript
// Extension registration API
interface ExarchosExtension {
  name: string;
  version: string;

  // Optional: contribute workflow definitions
  workflows?: WorkflowDefinition[];

  // Optional: contribute quality gates
  gates?: GateDefinition[];

  // Optional: contribute view projections
  views?: ViewProjectionRegistration[];

  // Optional: contribute event types
  events?: EventTypeRegistration[];

  // Optional: contribute task routing strategies
  routers?: TaskRouterRegistration[];
}

// Package entry point
export default function register(): ExarchosExtension {
  return {
    name: '@exarchos/gate-mutation-testing',
    version: '1.0.0',
    gates: [{
      name: 'mutation-testing',
      layer: 2,
      execute: async (context) => { /* Stryker integration */ },
    }],
  };
}
```

**Effort:** This is the single largest architectural change required. The HSM registry, event schema registry, view materializer, and tool registry all need to become extensible. Estimated: dedicated design + implementation phase.

### Gap 2: AI Client Abstraction

**Current state:** Skills reference Claude Code-specific concepts throughout:
- `Task` tool for subagent dispatch
- Agent teams API for teammate lifecycle
- `SessionStart` / `PreCompact` hooks
- Worktree management tied to Claude Code session model
- Spawn prompts assume Claude's instruction format

**Required state:** A capability interface that maps to different AI clients.

**Design direction:**

```typescript
interface AgentCapabilities {
  // Core: every client must support these
  executeTask(task: TaskDefinition): Promise<TaskResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  runCommand(command: string): Promise<CommandResult>;

  // Extended: clients may support these
  spawnTeammate?(config: TeammateConfig): Promise<TeammateHandle>;
  createWorktree?(config: WorktreeConfig): Promise<string>;
  checkpointContext?(): Promise<void>;
}
```

Skills would reference capabilities, not implementation details. The Claude Code adapter would implement `spawnTeammate` using agent teams; a Cursor adapter might implement `executeTask` differently.

**Effort:** Medium. The MCP server is already client-agnostic (it speaks MCP). The gap is in the content layer (skills, rules, spawn prompts). This requires rewriting skills to reference abstract capabilities rather than Claude Code specifics.

**Trade-off:** Abstraction vs. power. Claude Code's specific features (agent teams, context compaction, hooks) enable capabilities that a generic abstraction might not. The recommendation is to abstract the common path but allow Claude Code-specific optimizations as "enhanced mode" — similar to how Aspire has basic and enhanced integration modes.

### Gap 3: User-Facing Documentation and CLI

**Current state:** CLAUDE.md documents the codebase for contributors. No documentation exists for users who want to install and use Exarchos.

**Required state:**
- Getting started guide (install, first workflow, configuration)
- Workflow reference (feature, debug, refactor — what each phase does)
- Extension guide (create custom workflows, gates, views)
- CLI reference (`exarchos init`, `exarchos status`, `exarchos eval`)
- Architecture overview (for users who want to understand the internals)

**Design direction:** Follow Aspire's documentation structure:
1. Quickstart (5 minutes to first workflow)
2. Fundamentals (concepts, architecture, terminology)
3. Integrations (extension gallery)
4. Deployment (SaaS tier setup)

**Effort:** Medium-high. Documentation is ongoing, not a one-time task. The CLI needs to be designed first (Gap 4), then documented.

### Gap 4: CLI as Product Surface

**Current state:** The CLI entry point is `node dist/cli.js <command>`, invoked by hooks. It's a hook implementation, not a user-facing tool.

**Required state:** A proper CLI that serves as the primary interaction surface for users who want to interact with Exarchos outside of the MCP flow.

```bash
# Installation
npm install -g @exarchos/cli

# Initialize in a project
exarchos init

# View active workflows
exarchos status

# View quality metrics
exarchos quality

# Run eval suite
exarchos eval --layer regression

# View pipeline (all workflows)
exarchos pipeline

# Extension management
exarchos add @exarchos/gate-mutation-testing
```

**Effort:** Medium. The MCP server already has the data layer. The CLI is a presentation layer that queries the same CQRS views. The `cli.ts` hook entry point can be extended or replaced with a proper CLI framework (e.g., `commander`, `oclif`).

### Gap 5: Multi-Tenant Event Schema

**Current state:** Events have no tenant or organization context. The `WorkflowEvent` base interface includes `streamId`, `agentId`, and `source` but no organizational hierarchy.

**Required state:** Events carry optional organizational context for SaaS aggregation.

**Design direction:**

```typescript
interface WorkflowEvent {
  // ... existing fields
  // Optional: populated when SaaS tier is active
  tenantId?: string;
  organizationId?: string;
  teamId?: string;
}
```

**Effort:** Low. Add optional fields now. They're ignored in local mode and populated by the SaaS tier during event ingestion. No behavioral changes required.

**Timing:** Do this early — it's cheap now and expensive to retrofit once events are in production.

---

## 5. The Differentiator Triad

The unique competitive position is the integration of three dimensions that competitors address in isolation:

### Analytics: Know What's Happening

| Capability | Local (OSS) | Cloud (SaaS) |
|---|---|---|
| Event-sourced workflow telemetry | Per-developer event stream | Team-wide event aggregation |
| CQRS materialized views | PipelineView, WorkflowStatusView, TeamStatusView | + Cross-developer PipelineView |
| CodeQualityView | Per-developer quality trends | Org-wide quality dashboards, model comparison |
| Tool performance telemetry | Per-session latency/token tracking | Historical trends, optimization recommendations |
| Verification flywheel | Limited signal (single developer) | Statistically significant signal (multi-tenant) |

**Why this matters:** Devin gives you a log. Cursor gives you inline suggestions. Neither gives you a structured, queryable record of what happened, why it happened, and what the quality outcomes were. Event sourcing with CQRS views provides this — and it compounds over time.

**Production readiness:** The analytics layer is the strongest part of the current architecture. Event store, views, and telemetry are implemented and tested. The CodeQualityView (from the verification design) extends this naturally.

### Execution: Do the Work

| Capability | Local (OSS) | Cloud (SaaS) |
|---|---|---|
| Multi-agent orchestration | Claude Code teammates in worktrees | + Agentic Coder containers |
| Parallel task execution | Concurrent worktrees per feature | + Remote containers for overflow |
| Progressive stacking | Graphite stack management | Same, with remote task results |
| Task routing | Local-only (all tasks run locally) | Score-based local/remote routing |
| Tiered model selection | Opus/Sonnet/Haiku per role | Same, with cost optimization |
| Cross-session coordination | N/A (single developer) | Basileus-mediated dependency resolution |

**Why this matters:** Single-agent tools hit a ceiling. Complex features need multiple agents working in parallel with coordination. The team coordinator + worktree isolation + progressive stacking model enables this at the local tier. The cloud tier removes the ceiling entirely with elastic compute.

**Production readiness:** Team coordinator, task management, and role system are implemented. Worktree management is battle-tested through existing workflows. Progressive stacking design exists. The local execution layer is close to production-ready. Remote execution (Phases 4-5) is unimplemented.

### Verification: Prove It Works

| Capability | Local (OSS) | Cloud (SaaS) |
|---|---|---|
| TDD enforcement | Per-task Red-Green-Refactor cycle | Same |
| Property-based testing | Agent guidance + validation script | + Framework-level PBT generation |
| Quality gates (agent-side) | Secret scan, build, test, observability | Same |
| Quality gates (CI-side) | N/A (user's own CI) | Full gate suite with auto-remediation |
| Benchmark regression | Local baselines, `check-benchmark-regression.sh` | Historical baselines, team-wide thresholds |
| Mutation testing | N/A (requires CI) | Stryker integration in per-stack gates |
| Auto-remediation | N/A | 3-attempt bounded fix cycle with Exarchos escalation |
| Eval framework | Local eval harness (LLM-graded skill quality) | Multi-tenant flywheel with statistical significance |

**Why this matters:** Code generation without verification is a liability. Devin generates code and runs tests — but has no property-based testing, no benchmark regression detection, no mutation testing, no auto-remediation pipeline, and no feedback loop. The verification layer is what makes autonomous code generation trustworthy enough for production use.

**Production readiness:** TDD enforcement exists via skills and hooks. Quality gates are designed but CI-side gates are infrastructure (not repo code). The autonomous code verification plan (16 tasks) adds property-based testing, benchmark regression, and CodeQualityView. After that plan executes, the local verification layer is strong. The cloud verification layer (auto-remediation, mutation testing, eval flywheel) depends on Basileus.

### The Triad as Moat

Each dimension reinforces the others:

```
Analytics ←──→ Execution
    ↑               ↑
    │               │
    └───→ Verification ←──┘
```

- **Analytics + Execution:** Event-sourced telemetry from parallel agent execution produces the data for CodeQualityView and the verification flywheel. Without multi-agent execution, the analytics are thin.
- **Execution + Verification:** Verification gates validate execution output. Without verification, autonomous execution is unreliable. Without execution, verification has nothing to verify.
- **Analytics + Verification:** The flywheel connects analytics (quality trends) to verification (what to check). Without analytics, verification is static. Without verification, analytics measure the wrong things.

A competitor would need to replicate all three dimensions and their interactions. Building one (Devin: execution) or two (hypothetical: execution + verification) leaves gaps that compound over time.

---

## 6. Developer Team Ergonomics

For a dev team adopting Exarchos, ergonomics determine whether the tool gets used daily or abandoned after a week. The Aspire model is instructive: it optimized for "remove friction from the development loop" above all else.

### Current Ergonomics Assessment

| Aspect | Current State | Ergonomic Score |
|---|---|---|
| **Installation** | `npm install` + `npm run build` + installer creates symlinks | 6/10 — works but not discoverable |
| **First run** | Type `/ideate` in Claude Code | 7/10 — simple if you know it exists |
| **Configuration** | Edit `~/.claude.json` and `bridge-config.json` | 4/10 — manual JSON editing, no validation |
| **Status visibility** | `exarchos_view pipeline` via MCP tool | 5/10 — requires knowing the tool API |
| **Error recovery** | SessionStart hook auto-resumes, `/resume` command | 7/10 — good but silent |
| **Team onboarding** | Read CLAUDE.md, install, configure MCP | 3/10 — no guided setup |
| **Extension** | Fork the repo, modify TypeScript | 2/10 — hostile to customization |
| **Debugging workflows** | Read `.state.json` and `.events.jsonl` files | 4/10 — raw file inspection |

### Target Ergonomics (Aspire-Level)

**1. Zero-Config Start**

```bash
npx @exarchos/create my-project
# Detects project type (TypeScript, .NET, Python)
# Installs appropriate workflow pack
# Configures MCP server
# Creates initial quality gate baselines
# Ready in 30 seconds
```

The `create` command is the Aspire equivalent of `dotnet new aspire-starter`. It scaffolds everything needed with sensible defaults. The developer can start using `/ideate` immediately.

**2. Interactive Dashboard**

```bash
exarchos status
```

Renders a terminal UI (like `k9s` or `lazygit`) showing:
- Active workflows with phase indicators
- Task progress bars
- Quality metrics (last gate results, benchmark status)
- Team composition (active teammates, their tasks)
- Recent events (live-updating)

This is the Aspire dashboard equivalent. It gives the developer a single place to understand what's happening across all their workflows.

**3. Configuration as Code**

```typescript
// exarchos.config.ts
import { defineConfig } from '@exarchos/core';
import { mutationTesting } from '@exarchos/gate-mutation-testing';
import { frontendWorkflow } from '@exarchos/workflow-pack-frontend';

export default defineConfig({
  // Opinionated defaults — override only what you need
  workflows: {
    feature: {
      // Default feature workflow with one override
      tddEnforcement: true,
      qualityGates: ['build', 'test', 'lint', mutationTesting({ threshold: 80 })],
    },
    // Add a custom workflow from a package
    'ui-component': frontendWorkflow({
      testRunner: 'vitest',
      storybook: true,
    }),
  },

  // Team settings
  team: {
    maxTeammates: 3,
    defaultModel: 'claude-sonnet-4-5-20250929',
  },

  // Cloud tier (optional)
  cloud: {
    enabled: false, // Toggle to true when ready
    apiUrl: 'https://api.exarchos.dev',
  },
});
```

Typed configuration with IDE support, following the Aspire principle that configuration should be code. `exarchos.config.ts` replaces `bridge-config.json` and provides validation, autocompletion, and documentation in the editor.

**4. Guided Setup for Teams**

```bash
exarchos init --team
# Walks through:
# 1. Project type detection
# 2. Workflow selection (which workflows does your team use?)
# 3. Quality gate configuration (what CI tools do you have?)
# 4. Team settings (max concurrency, model preferences)
# 5. Cloud tier opt-in (connect to Exarchos Cloud?)
# 6. Generates exarchos.config.ts
# 7. Adds .exarchos/ to .gitignore
# 8. Creates team-shared configuration
```

**5. Workflow Debugging**

```bash
# Replay a workflow's event stream
exarchos replay feature/user-auth

# Show the decision trace for a specific phase transition
exarchos trace feature/user-auth delegate→review

# Compare two workflow runs
exarchos diff feature/user-auth@v1 feature/user-auth@v2
```

Event sourcing makes workflow debugging trivial — every decision is recorded. The CLI surfaces this as replay, trace, and diff commands.

**6. Extension Discovery**

```bash
# Browse available extensions
exarchos extensions search "mutation testing"

# Install an extension
exarchos add @exarchos/gate-mutation-testing

# List installed extensions
exarchos extensions list
```

Following Aspire's integration gallery model. Extensions are npm packages that self-register.

---

## 7. Productization Roadmap

### Phase 0: Foundation Hardening (Current → Production Quality)

**Goal:** Make the local tool production-ready without architectural changes.

| Work Item | Priority | Effort |
|---|---|---|
| Complete autonomous code verification plan (16 tasks) | High | Medium |
| Structured error taxonomy for MCP tool failures | High | Low |
| State file versioned migration system | High | Medium |
| Configuration schema validation (Zod for bridge-config) | Medium | Low |
| Structured logging (pino or similar) | Medium | Low |
| Multi-tenant event schema fields (optional tenantId, orgId) | Low | Low |
| Bug fixes and edge case handling from real usage | Ongoing | Ongoing |

**Exit criteria:** All existing tests pass. Event store handles 10K+ events per stream without degradation. State migration handles schema changes. Error messages are actionable.

### Phase 1: CLI and Documentation

**Goal:** A proper user-facing CLI and documentation suite.

| Work Item | Priority | Effort |
|---|---|---|
| CLI framework (oclif or commander) with `exarchos` binary | Critical | Medium |
| `exarchos init` — project scaffolding | Critical | Medium |
| `exarchos status` — terminal dashboard | High | Medium |
| `exarchos quality` — quality metrics display | Medium | Low |
| Getting started documentation | Critical | Medium |
| Workflow reference documentation | High | Medium |
| Architecture documentation (for extension authors) | Medium | Medium |

**Exit criteria:** A new user can `npx @exarchos/create`, run `/ideate`, and see a complete workflow with quality metrics — in under 10 minutes.

### Phase 2: Extension Architecture

**Goal:** Plugin-based extensibility following the Aspire integration model.

| Work Item | Priority | Effort |
|---|---|---|
| `ExarchosExtension` interface design | Critical | High (design) |
| Extensible HSM registry (custom workflows) | Critical | High |
| Extensible event schema registry | High | Medium |
| Extensible view projection registry | High | Medium |
| Extensible gate registry | High | Medium |
| `exarchos.config.ts` configuration system | High | High |
| Extension package discovery and loading | Medium | Medium |
| First-party extension packages (2-3 examples) | Medium | Medium |
| Extension authoring guide | Medium | Medium |

**Exit criteria:** A third-party developer can create an npm package that adds a custom workflow, gate, or view to Exarchos without forking the server.

### Phase 3: AI Client Abstraction

**Goal:** Exarchos works with AI clients beyond Claude Code.

| Work Item | Priority | Effort |
|---|---|---|
| `AgentCapabilities` interface design | High | Medium |
| Claude Code adapter (extract current behavior) | High | Medium |
| Skill rewrite: abstract capabilities, not Claude specifics | High | High |
| Adapter for one additional client (Cursor, Cline, or Aider) | Medium | High |
| "Enhanced mode" flag for Claude-specific features | Medium | Low |

**Exit criteria:** Exarchos runs with at least two different AI clients. Claude Code retains full feature access. Non-Claude clients support the core workflow (ideate → plan → delegate → review → synthesize) even if some features (agent teams, context hooks) are unavailable.

### Phase 4: SaaS Tier

**Goal:** Basileus integration as optional cloud backend.

| Work Item | Priority | Effort |
|---|---|---|
| Basileus HTTP client in Exarchos | High | Medium |
| Outbox delivery implementation | High | Medium |
| Event schema mapping (local → Marten) | High | Medium |
| Remote event polling (inbound sync) | High | Medium |
| Task Router with score-based routing | Medium | Medium |
| Agentic Coder container dispatch | Medium | High |
| Conflict resolution | Medium | Medium |
| Cross-session coordination | Low | High |
| Web dashboard (SaaS-only) | Medium | High |
| Billing/metering infrastructure | Medium | High |

**Exit criteria:** A developer can toggle `cloud.enabled: true`, connect to a running Basileus instance, and see their local events projected to the cloud dashboard with remote task execution available.

### Phase 5: Flywheel and Team Features

**Goal:** Multi-tenant analytics, verification flywheel, and team coordination.

| Work Item | Priority | Effort |
|---|---|---|
| CodeQualityView aggregation across tenants | High | Medium |
| Verification flywheel (eval framework ↔ code quality) | High | High |
| Team-wide benchmark baselines | Medium | Medium |
| Cross-developer workflow coordination | Medium | High |
| Model comparison analytics | Medium | Medium |
| Automated prompt refinement from flywheel signal | Low | High |

**Exit criteria:** A team of 3+ developers using Exarchos Cloud sees aggregated quality metrics, model comparison data, and gets actionable recommendations from the flywheel.

---

## 8. Risk Assessment

### Technical Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Extension architecture complexity** — plugin systems are hard to get right. Over-abstract and it's unusable; under-abstract and it's inflexible. | High | Study Aspire's integration model closely. Start with 2-3 first-party extensions to validate the API before publishing it. |
| **AI client abstraction leakiness** — Claude Code-specific features (agent teams, hooks) may not map to other clients. | High | Define "core" vs. "enhanced" capability tiers. Core works everywhere; enhanced is Claude Code-only. Don't abstract what can't be meaningfully abstracted. |
| **Event schema evolution** — public users will have production event streams. Schema changes must be backward-compatible. | High | Implement versioned migration system before public release. All events carry `schemaVersion`. New fields are always optional. |
| **Performance at scale** — JSONL event store is simple but doesn't scale to millions of events. | Medium | Fine for local use (thousands of events per workflow). For SaaS, events flow to Marten (PostgreSQL-backed) which handles scale. The local store only needs to handle one developer's data. |

### Product Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Scope creep** — trying to ship OSS + SaaS + extensions simultaneously. | Critical | Phase the roadmap strictly. Ship production-quality local tool first (Phases 0-2). SaaS is Phase 4+. |
| **"Too opinionated" rejection** — developers resist prescribed workflows. | High | The Aspire defense: opinionated defaults are a feature, not a bug. But extension points are mandatory — users must be able to swap any default. |
| **Claude Code dependency** — if Anthropic changes Claude Code's API (agent teams, hooks), Exarchos breaks. | Medium | AI client abstraction (Phase 3) reduces this risk. Maintain a Claude Code-specific adapter that isolates API surface changes. |
| **Adoption inertia** — developers already use Cursor/Devin/etc. Switching costs are real. | Medium | Don't require switching. Exarchos can wrap existing tools via the AI client adapter model. The value proposition isn't "replace your coding tool" — it's "add governance to your coding tool." |

### Strategic Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Competitor replication** — Devin or Cursor adds workflow orchestration. | Medium | The triad (analytics + execution + verification) is hard to replicate as a coherent system. Single-dimension improvements don't close the gap. Time-to-market with the full triad is the moat. |
| **Model capability leapfrog** — Claude 5 or GPT-5 is so good that governance overhead isn't worth it. | Low | Better models make autonomous execution more valuable, not less. Better code generation increases the need for verification (more code generated = more code to verify). The governance layer becomes more important as agent capability increases. |
| **Open source sustainability** — maintaining an OSS tool with extension ecosystem requires ongoing investment. | Medium | SaaS revenue funds OSS maintenance. The Aspire model: Microsoft funds Aspire OSS to drive Azure adoption. Exarchos OSS drives Exarchos Cloud adoption. |

---

## Related Documents

| Document | Relationship |
|---|---|
| [Distributed SDLC Pipeline](../adrs/distributed-sdlc-pipeline.md) | Core architecture this assessment evaluates |
| [Autonomous Code Verification](2026-02-15-autonomous-code-verification.md) | Verification layer design (analytics + verification dimensions) |
| [SDLC Eval Framework](2026-02-13-sdlc-eval-framework.md) | Eval flywheel design (analytics dimension) |
| [SDLC Benchmarks](2026-02-12-sdlc-benchmarks.md) | Telemetry benchmarks (analytics dimension) |
