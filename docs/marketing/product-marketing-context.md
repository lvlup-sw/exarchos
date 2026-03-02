# Product Marketing Context

*Last updated: 2026-03-02*

## Product Overview

**One-liner:** Local agent governance for Claude Code — durable SDLC workflows that survive context loss

**What it does:** Exarchos is a Claude Code plugin that adds structured software development lifecycle workflows to AI-assisted coding. It provides persistent state that survives context compaction, phase-gated quality verification at every workflow boundary, parallel agent team coordination in isolated git worktrees, and a complete audit trail of every agent decision. Workflows auto-continue between two human checkpoints (design approval and merge).

**Product category:** Claude Code plugin / Agent workflow tooling / SDLC automation

**Product type:** Open-source developer tool (Claude Code plugin distributed via marketplace)

**Business model:** Free, open-source (Apache-2.0). Part of the lvlup-sw ecosystem. Validates demand for the Basileus cloud platform (future paid offering).

**Pricing:** Free

## Target Audience

**Target users:** Solo developers and small-team power users of Claude Code who use it for non-trivial development work (multi-file features, bug investigation, refactoring)

**Decision-makers:** Individual developers (self-serve install from marketplace)

**Primary use case:** Structuring AI-assisted development so that Claude Code agents produce verifiable, traceable output instead of unpredictable one-shot code

**Jobs to be done:**
- Keep my agent workflow alive when Claude Code loses context mid-task — checkpoint, walk away, `/rehydrate` later
- Verify that AI-generated code actually matches what I designed before I merge it
- Coordinate multiple Claude Code agents working on the same feature without conflicts
- Minimize token waste on workflow overhead so more context goes to actual code

**Use cases:**
- Feature development with design → plan → implement → review → ship lifecycle
- Bug investigation with structured triage, root cause analysis, and validated fixes
- Code refactoring with scope assessment and parallel delegation
- Multi-agent team coordination with worktree isolation

## Personas

| Persona | Cares about | Challenge | Value we promise |
|---------|-------------|-----------|------------------|
| Solo dev power user | Shipping features fast with confidence | Context dies mid-task, agent skips tests, no way to verify output | Durable workflows that resume + quality gates that verify |
| Tech lead / architect | Code quality, architectural compliance | AI agents produce code that works but violates patterns | Convergence gates enforce standards at every phase |
| Early adopter / tinkerer | Pushing agent capabilities further | Raw Claude Code is powerful but chaotic for complex tasks | Structure that enables ambitious multi-agent workflows |

## Problems & Pain Points

**Core problem:** Claude Code agents lose context mid-task, skip verification, produce monolithic diffs, and leave no record of what they did or why. Every session starts from scratch.

**Why alternatives fall short:**
- Stateless skill bundles (Superpowers, etc.) shape behavior within a session but can't persist across context compaction — agents eventually ignore suggestions
- Task trackers (Claude Task Master) manage *what* to do but don't structure *how* to do it or verify it was done correctly
- Full autonomy tools (Auto-Claude) optimize for speed but have no quality gates or audit trail — agents proceed without verification

**What it costs them:**
- Hours re-explaining context after compaction events
- Merged code that doesn't match the original design intent
- No way to trace what the agent decided or why when something goes wrong
- Manual quality verification that defeats the purpose of agent-assisted development
- Cognitive overload from manually orchestrating multiple agents — "landing a plane all day" (medi8r, HN)
- Token burn: parallel agents "hit Max plan limits in under an hour" (ecliptik, HN)
- One power user built a 300+ spec system and still has no persistent state or automated gates

**Emotional tension:** Frustration at watching a capable agent lose its way. The feeling of "I could have written this faster myself" after cleaning up unverified agent output. The exhaustion of being the human orchestrator across 4-8 tmux panes — one developer described a bell curve from single agent to elaborate multi-agent back to single agent because the overhead wasn't worth it. Anxiety about merging AI-generated code without understanding every line.

## Competitive Landscape

**Direct:** Obra Superpowers — Mature, cross-platform skill bundle with active community. Falls short because it's stateless (no persistence across sessions), behavioral suggestions rather than enforced gates, and no audit trail.

**Direct:** Claude Task Master — Task management for AI development. Falls short because it's task tracking, not workflow governance — no phase gates, no quality verification, no team coordination.

**Direct:** Auto-Claude — Full SDLC autonomous multi-agent framework. Falls short because no durable state (context loss kills the workflow), no quality gates, no audit trail.

**Direct:** Manual spec-file systems (schipperai's Feature Designs, briantakita's agent-doc) — Power users building structured workflows with Markdown specs, lifecycle stages, and slash commands. The most sophisticated (FD system: 300+ specs, 8-stage lifecycle) mirrors Exarchos's phases almost exactly. Falls short because no persistent state across sessions, no automated phase gates, no convergence verification, and requires continuous human orchestration ("landing a plane all day").

**Direct:** CAS (aceelric) — Factory-mode supervisor agent with automatic worktree spawning and merge handling. Closest automated competitor to Exarchos's `/delegate`. Unclear on state persistence, quality gates, and audit trail.

**Secondary:** Generic SDLC skill bundles (Fullstack Dev Skills, wshobson/agents) — Collections of independent tools, not integrated workflows. No state management, no phase transitions.

**Indirect:** Raw Claude Code with CLAUDE.md instructions — The "just write good prompts" approach. Falls short because prompts can't persist state, enforce phase gates, or coordinate agent teams.

## Differentiation

**Key differentiators:**
- **Structured SDLC workflows** — Design → plan → implement → review → ship as a systematized, persistent workflow — not ad-hoc markdown conventions. Power users are already building plan.md workflows by hand (HN thread: jedberg, jumploops, brendanmc6 all independently invented this pattern). Exarchos gives them the systematic version with enforced phase transitions, auto-continuation, and three workflow types (feature, debug, refactor). Spec, plan, and design artifacts are first-class objects committed alongside code, not afterthoughts.
- **Rehydrate + artifacts** — Checkpoint mid-task, disappear for an hour (or a week), run `/rehydrate` and pick up exactly where you left off. Rehydrate restores behavioral guidance, artifact pointers (design docs, plans, PR URLs), and task progress in ~2-3k tokens — no history replay, no context reinflation. Artifacts live as file references in state, never inlined. Context stays constant regardless of how many documents the workflow has generated.
- **Exceptional token efficiency** — Field-projected state queries return only requested fields (90% reduction vs. full state). Diff-based code review sends only changed lines, not full files (97% reduction for large files). Post-compaction context assembly fits full workflow awareness into ~2-3k tokens with an 8k-char budget cap. Context economy is also a verified quality gate (D3) — code that's too complex for LLM context (files >400 lines, functions >80 lines, diffs >30 files) can't ship, preventing the death spiral of increasingly bloated files.
- Event-sourced durability — workflows survive context compaction, session restarts, and machine switches (requires MCP server with append-only event store; can't be replicated with markdown files)
- Convergence gates — five independent quality dimensions verified at every phase boundary via deterministic scripts, not behavioral suggestions
- Provenance chain — requirement IDs trace from design document through plan tasks through tests through merged code; gaps are detectable by query
- Two human checkpoints — approve the design, approve the merge, everything else auto-continues

**How we do it differently:** We use an MCP server with event-sourced state (not markdown files) to persist workflows. State reads use field projection and materialized CQRS views — agents query pre-computed read models instead of reconstructing state from events. Quality verification runs as deterministic bash scripts (not LLM judgment). Phase transitions are gated (not suggested).

**Why that's better:** Behavior shaping works until the agent ignores it. Enforcement works always. When context dies, stateless skills start over; Exarchos resumes where it left off with minimal token cost. Every token spent on workflow infrastructure is a token not spent on your actual code — Exarchos is designed to be the cheapest possible workflow layer.

**Why customers choose us:** They've felt the pain of context loss killing a multi-hour workflow. They want structure without giving up speed — two checkpoints, everything else flows. And they don't want workflow overhead eating their context budget.

## Objections

| Objection | Response |
|-----------|----------|
| "Seems like a lot of overhead for solo dev work" | Two human checkpoints total — design approval and merge. Everything between auto-continues. The overhead is 2 approvals; the payoff is verified code with full traceability. |
| "I just use CLAUDE.md and it works fine" | Until context compaction hits, or your agent ignores the instructions, or you need to trace what happened in a failed session. CLAUDE.md is great — Exarchos builds on it. |
| "Why not just use Superpowers?" | Superpowers shapes behavior; Exarchos persists and verifies it. They're complementary layers. Use both. |
| "Claude Code only? I use Cursor too" | By design — deep integration enables durable state, convergence gates, and team coordination. Shallow portability would require giving up the features that matter. |

**Anti-persona:** Developers who only use Claude Code for one-shot tasks (single-file fixes, quick scripts). If your prompts are one-and-done, you don't need workflow structure.

## Switching Dynamics

**Push (away from current):** Context dies mid-feature and you lose 2 hours of agent work. You merge AI code and discover it doesn't match the design. You can't explain to a colleague what the agent did or why. You built a 300-spec workflow system and it still can't persist state or resume after compaction. You're spending more time orchestrating agents than writing code — "landing a plane all day."

**Pull (toward us):** Workflows that survive context loss. Quality verified before merge. Full audit trail. Agent teams working in parallel. Two human checkpoints instead of continuous oversight. Token-efficient enough to make multi-agent viable on a Max plan.

**Habit (keeps them stuck):** "My current setup works well enough." "I've invested time in my CLAUDE.md." "I've already built my own spec system." "Learning a new tool has a cost."

**Anxiety (about switching):** "Is this going to slow me down?" "Is the learning curve worth it?" "What if it conflicts with my existing setup?" "Will it work with the workflow I've already built?"

## Customer Language

**How they describe the problem:**
- "Context died and I lost everything"
- "The agent just ignored my instructions"
- "I have no idea what the agent actually did"
- "I spent more time reviewing than it would have taken to write it myself"
- "My plan.md workflow works but it's all manual"
- "I start with a project.md file, iterate on plan.md, then tell it to execute" — jedberg (HN, 260+ points)
- "A living lexicon of the architecture" — jumploops (HN, describing plan/design files)
- "Compaction can drop good context or even the decisions made during planning" — schipperai (HN, 300+ spec system)
- "The bottleneck wasn't the agents, it was keeping their context from drifting" — CloakHQ (HN)
- "It looks cognitively like being a pilot landing a plane all day long" — medi8r (HN)
- "I spent a ton of time enforcing Claude to use the system I put in place" — ramoz (HN)
- "The parallel agents burn through tokens extremely quickly and hit Max plan limits in under an hour" — ecliptik (HN)

**How they describe us:**
- "Structured workflows for Claude Code"
- "My plan.md workflow, but systematized"
- "It's like CI/CD for agent development"
- "Durable state that survives context windows"
- "Checkpoint, walk away, rehydrate later"
- "Barely uses any context for workflow overhead"
- "Your plan.md workflow, with teeth"

**Words to use:** durable, structure, verified, workflows, convergence gates, audit trail, agent teams, phase-gated, checkpoint-resume, rehydrate, token-efficient, context economy, artifacts, systematized, plan.md (as recognition hook)

**Words to avoid:** governance (as lead term — sounds enterprise), enforcement (sounds restrictive), CMDP/HSM (academic jargon), compliance (sounds bureaucratic)

**Glossary:**
| Term | Meaning |
|------|---------|
| Convergence gates | Automated quality checks at every phase boundary — 5 independent dimensions |
| Context compaction | When Claude Code compresses prior messages as context window fills up, losing state |
| Rehydrate | Restore full workflow awareness after compaction or session break — behavioral guidance + artifact pointers in ~2-3k tokens |
| Context economy | Quality gate (D3) that prevents context-consuming code patterns from shipping — files >400 lines, functions >80 lines, diffs >30 files |
| Field projection | State queries that return only requested fields — 90% token reduction vs. full state reads |
| Worktree | Isolated git working copy where agent teammates execute tasks independently |
| Provenance chain | Traceability from design requirement → plan task → test → merged code |
| Event sourcing | Append-only log of all state changes — enables resume, audit, and replay |

## Brand Voice

**Tone:** Direct and technical — no hype, no superlatives, no marketing buzzwords

**Style:** Lead with concrete capabilities, not abstract promises. Acknowledge trade-offs honestly. Talk to developers the way developers talk to each other.

**Personality:** Competent, honest, structured, pragmatic, occasionally dry

## Proof Points

**Metrics:**
- 9,000+ plugins in Claude Code marketplace — Exarchos is one of the few with durable state
- 2 human checkpoints per workflow (design + merge), everything else auto-continues
- 5 independent quality dimensions at every phase boundary

**Customers:** Early-stage — building initial user base through marketplace distribution

**Testimonials:** Collecting — Two HN threads show strong organic demand:
- Thread 1 (260+ points): jedberg, jumploops, brendanmc6 independently invent plan-file workflows
- Thread 2 (83 points): schipperai builds a 300+ spec system with 8-stage lifecycle and 6 slash commands — mirrors Exarchos's phases almost exactly, but without persistent state or automated gates

**Value themes:**
| Theme | Proof |
|-------|-------|
| Structured workflows | Design → plan → implement → review → ship systematized from manual plan.md conventions; HN thread (260+ points) shows power users independently reinventing what Exarchos provides |
| Rehydrate + artifacts | Checkpoint mid-task, `/rehydrate` later — behavioral guidance + artifact pointers restored in ~2-3k tokens, no history replay |
| Token efficiency | Field projection (90% reduction), diff-based review (97% reduction), 8k-char context budget cap, context economy quality gate prevents bloated code from shipping |
| Durability | Event-sourced state survives context compaction, session restarts, machine switches |
| Verification | 5 quality dimensions checked by deterministic scripts, not LLM judgment |
| Traceability | Provenance chain from requirement → code → test, queryable |
| Speed | 2 checkpoints, auto-continuation between — structure enables speed, not restricts it |

## Goals

**Business goal:** Validate product-market fit for agent workflow tooling via Google Ads campaigns measuring CTR, CPC, and conversion (install/star)

**Conversion action:** Install from marketplace (`/plugin marketplace add lvlup-sw/exarchos`) or GitHub star

**Current metrics:** Early-stage; establishing baseline through paid acquisition testing
