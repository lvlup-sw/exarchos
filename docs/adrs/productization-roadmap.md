# ADR: Productization Roadmap

## Status

**Proposed** — No implementation started. See the [full assessment](../designs/2026-02-15-productization-assessment.md) for detailed analysis, code examples, and ergonomics scoring.

---

## Context

Exarchos currently operates as a local agent governance tool for a single developer. The architecture — event-sourced workflows, CQRS views, team coordination, layered quality gates — is designed for production use but lacks the packaging, extensibility, and documentation required for public adoption.

Two product goals exist:

1. **Open-source local tool** — Production-quality agent governance that works fully offline
2. **Optional SaaS tier** — Remote compute, team-wide analytics, and the verification flywheel via Basileus

The local tool must be compelling on its own. The SaaS tier amplifies but never gates local functionality.

---

## Product Vision

| Tier | Product | Model | Value Proposition |
|------|---------|-------|-------------------|
| **Local** | Exarchos OSS | Open source | Production-quality agent governance for any AI coding assistant. Opinionated SDLC workflows with extension points. Works fully offline. |
| **Cloud** | Exarchos Cloud | Optional SaaS | Remote compute (Agentic Coder containers), team-wide analytics (CodeQualityView aggregation), and the verification flywheel. Amplifies the local tool without replacing it. |

### Core Differentiator

The market for AI coding tools converges on code generation. The differentiator is what happens *around* code generation:

| Dimension | Competitors | Exarchos |
|-----------|-------------|----------|
| **Analytics** | Token usage dashboards | Event-sourced workflow telemetry, CodeQualityView, verification flywheel with attribution |
| **Execution** | Single-agent code generation | Multi-agent orchestration with team coordination, parallel worktrees, progressive stacking |
| **Verification** | "Run tests" as a step | Layered quality gates, property-based testing, benchmark regression detection, auto-remediation |

No competitor combines all three into a single coherent system. The triad — analytics, execution, verification — is the product.

---

## The Aspire Model

.NET Aspire's design philosophy provides the model for Exarchos productization: opinionated defaults with a code-first approach and rich extension points.

| Aspire Principle | Exarchos Application |
|------------------|---------------------|
| **Opinionated defaults** | Three polished workflows (feature, debug, refactor) with TDD enforcement, progressive stacking, and quality gates as the default experience |
| **Code-first configuration** | Typed `exarchos.config.ts` replacing manual JSON editing; skills reference typed workflow primitives |
| **Extension points** | Plugin packages (`@exarchos/gate-*`, `@exarchos/workflow-pack-*`) that self-register at startup |
| **Local-first, cloud-optional** | Local MCP server runs the complete engine; SaaS activated by `mode: "dual"` — same primitives, different scale |
| **Dashboard as first-class** | CLI dashboard (`exarchos status`) for local; web dashboard for SaaS team-wide observability |

---

## Gap Analysis

| Gap | Current State | Required State | Effort |
|-----|---------------|----------------|--------|
| **No extension architecture** | Monolithic MCP server; custom workflows/gates/views require forking | Plugin-based `ExarchosExtension` interface; packages register capabilities at startup | High — largest architectural change |
| **No AI client abstraction** | Skills reference Claude Code-specific concepts (Task tool, hooks, agent teams) | `AgentCapabilities` interface mapping to different AI clients; core vs. enhanced capability tiers | Medium — MCP server is client-agnostic; gap is in skills |
| **No user-facing documentation** | CLAUDE.md for contributors only | Getting started, workflow reference, extension guide, CLI reference | Medium-high — ongoing |
| **CLI is a hook, not a product** | `node dist/cli.js <command>` invoked by hooks | Proper `exarchos` binary with `init`, `status`, `quality`, `pipeline` commands | Medium — presentation layer over existing CQRS views |
| **No multi-tenant events** | No tenant/organization context in `WorkflowEvent` | Optional `tenantId`, `organizationId`, `teamId` fields for SaaS aggregation | Low — add optional fields now |

---

## The Differentiator Triad

Each dimension reinforces the others:

```text
Analytics ←──→ Execution
    ↑               ↑
    │               │
    └───→ Verification ←──┘
```

- **Analytics + Execution** — Event-sourced telemetry from parallel agent execution produces data for CodeQualityView and the verification flywheel
- **Execution + Verification** — Verification gates validate execution output; without execution, verification has nothing to verify
- **Analytics + Verification** — The flywheel connects quality trends to verification targets; without analytics, verification is static

A competitor would need to replicate all three dimensions and their interactions. Building one or two leaves gaps that compound over time.

---

## Developer Ergonomics

### Current Scores

| Aspect | Score | Notes |
|--------|-------|-------|
| Installation | 6/10 | `npm install` + build + symlinks — works but not discoverable |
| First run | 7/10 | Type `/ideate` in Claude Code — simple if you know it exists |
| Configuration | 4/10 | Manual JSON editing, no validation |
| Status visibility | 5/10 | Requires knowing the MCP tool API |
| Error recovery | 7/10 | SessionStart hook auto-resumes |
| Team onboarding | 3/10 | No guided setup |
| Extension | 2/10 | Fork the repo |
| Debugging workflows | 4/10 | Raw file inspection |

### Targets

- **Zero-config start** — `npx @exarchos/create` detects project type, installs workflow pack, ready in 30 seconds
- **Interactive dashboard** — `exarchos status` renders terminal UI with workflows, tasks, quality metrics, team composition
- **Configuration as code** — Typed `exarchos.config.ts` with IDE support and validation
- **Guided team setup** — `exarchos init --team` walks through workflow selection, gate config, cloud opt-in
- **Workflow debugging** — `exarchos replay`, `exarchos trace`, `exarchos diff` commands leveraging event sourcing

---

## Phased Roadmap

| Phase | Goal | Key Items | Exit Criteria |
|-------|------|-----------|---------------|
| **Phase 0: Foundation Hardening** | Production-ready local tool without architectural changes | Error taxonomy, state migration system, config validation, structured logging, multi-tenant event fields | All tests pass; 10K+ events/stream; actionable error messages |
| **Phase 1: CLI and Documentation** | User-facing CLI and docs | `exarchos` binary (oclif/commander), `init`/`status`/`quality` commands, getting started guide, workflow reference | New user runs `npx @exarchos/create` → `/ideate` → complete workflow in <10 min |
| **Phase 2: Extension Architecture** | Plugin-based extensibility | `ExarchosExtension` interface, extensible HSM/event/view/gate registries, `exarchos.config.ts`, 2-3 first-party extensions | Third-party npm package adds custom workflow/gate/view without forking |
| **Phase 3: AI Client Abstraction** | Multi-client support | `AgentCapabilities` interface, Claude Code adapter, skill rewrite, one additional client adapter | Core workflow runs on 2+ AI clients; Claude retains enhanced features |
| **Phase 4: SaaS Tier** | Basileus cloud backend | HTTP client, outbox delivery, event mapping, task router, Agentic Coder dispatch, web dashboard | `cloud.enabled: true` → events in cloud dashboard, remote execution available |
| **Phase 5: Flywheel and Team** | Multi-tenant analytics and coordination | CodeQualityView aggregation, verification flywheel, cross-developer coordination, model comparison | Team of 3+ sees aggregated metrics and actionable flywheel recommendations |

---

## Risk Assessment

| Category | Risk | Severity | Mitigation |
|----------|------|----------|------------|
| Technical | Extension architecture complexity — over-abstract vs. under-abstract | High | Study Aspire's model; validate with 2-3 first-party extensions before publishing API |
| Technical | AI client abstraction leakiness — Claude Code features may not map | High | Define core vs. enhanced capability tiers; don't abstract what can't be meaningfully abstracted |
| Technical | Event schema evolution — public users have production event streams | High | Versioned migration system before public release; new fields always optional |
| Technical | JSONL performance at scale | Medium | Fine for local (thousands of events); SaaS uses Marten (PostgreSQL) |
| Product | Scope creep — shipping OSS + SaaS + extensions simultaneously | Critical | Phase strictly; local tool first (Phases 0-2); SaaS is Phase 4+ |
| Product | "Too opinionated" rejection | High | Extension points mandatory — users can swap any default |
| Product | Claude Code API dependency | Medium | AI client abstraction (Phase 3) isolates API surface changes |
| Strategic | Competitor replication | Medium | The triad is hard to replicate as a coherent system; time-to-market is the moat |
| Strategic | Model capability leapfrog makes governance unnecessary | Low | Better models increase need for verification (more generated code to verify) |

---

## Decision

1. **Phase 0 first** — Harden the foundation before adding new architecture
2. **Local tool priority** — Ship production-quality OSS before cloud features
3. **SaaS is Phase 4+** — Cloud tier depends on solid local foundation and extension architecture
4. **Aspire model** — Opinionated defaults with extension points, not a blank canvas

---

## Implementation Status

| Phase | Status |
|-------|--------|
| Phase 0: Foundation Hardening | **Not started** |
| Phase 1: CLI and Documentation | **Not started** |
| Phase 2: Extension Architecture | **Not started** |
| Phase 3: AI Client Abstraction | **Not started** |
| Phase 4: SaaS Tier | **Not started** |
| Phase 5: Flywheel and Team | **Not started** |

---

## Related Documents

| Document | Relationship |
|----------|-------------|
| [Productization Assessment](../designs/2026-02-15-productization-assessment.md) | Full assessment with code examples, ergonomics analysis, and detailed gap descriptions |
| [Distributed SDLC Pipeline](./distributed-sdlc-pipeline.md) | Core architecture this roadmap productizes |
| [Autonomous Code Verification](../designs/2026-02-15-autonomous-code-verification.md) | Verification flywheel design (Phase 0 dependency, Phase 5 flywheel) |
| [SDLC Eval Framework](../designs/2026-02-13-sdlc-eval-framework.md) | Eval infrastructure the flywheel integrates with |
