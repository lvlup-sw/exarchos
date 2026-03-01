# Design: Exarchos Marketplace Positioning Strategy

## Problem Statement

Exarchos is a technically sophisticated Claude Code plugin with deep competitive advantages — event-sourced durable state, five-dimensional convergence gates, multi-agent team coordination, and provenance-traced SDLC workflows. It competes in a marketplace of 9,000+ plugins where the SDLC/workflow category is crowded at the skills layer (Obra Superpowers, Fullstack Dev Skills, Claude Task Master) but essentially empty at the durable governance layer.

The problem: Exarchos's current README and public messaging don't communicate why a solo developer should install it in the 10 seconds they spend scanning a marketplace listing. The theory documents (CMDP, adversarial convergence) are rigorous but opaque to the target user. We need positioning that translates technical depth into immediate, felt value — and key terms that work across README, social media, and ad campaigns.

## Approaches Considered

### Option 1: "The Missing Layer" — Infrastructure Positioning

**Approach:** Lead with the pain every power user feels — context loss, session amnesia, untraceable output — and present Exarchos as the durable infrastructure layer that solves it.

**Pros:** Speaks to the #1 ecosystem pain point; aligns with durable execution trends; sharp differentiation from Superpowers.
**Cons:** "Infrastructure" sounds dry; requires the user to have already felt the pain.
**Best when:** Users are actively searching for context persistence solutions.

### Option 2: "Professional Grade" — Methodology Positioning

**Approach:** Position Exarchos as what separates professional AI-assisted engineering from ad-hoc prompting. Lead with convergence gates, two-stage review, and structured phases.

**Pros:** Creates competitive contrast (enforcement vs. suggestion); compelling in demos; auditability fits naturally.
**Cons:** "Discipline" and "enforcement" can feel heavy-handed; harder to demonstrate in 30s.
**Best when:** Competing head-to-head with skill bundles on quality enforcement.

### Option 3: "Autopilot with a Black Box" — Auditability Positioning

**Approach:** Position the event-sourced audit trail as the hero. Every decision traced, every transition logged, every requirement verified.

**Pros:** Unique — no competitor emphasizes auditability; strongest Basileus bridge; durable competitive moat.
**Cons:** "Governance" and "audit" sound enterprise-y for solo devs; pain not yet widely felt.
**Best when:** Market narrative shifts toward AI accountability.

## Chosen Approach

**Hybrid of Options 1 + 2, with Option 3 as supporting proof point.**

Lead with the universal pain (agents lose context, skip steps, produce untraceable output). Prove the solution with the methodology (structured phases, convergence gates, quality verification). Close with what no one else offers (full event-sourced audit trail, provenance chain from requirement to test to code).

### Why this hybrid

Per the CVFB framework (T.A. McCann): pain-led hooks capture attention, methodology builds credibility, auditability creates defensible differentiation. Per Bussgang's *Experimentation Machine*: nail the beachhead (solo power user) with a message that also resonates upmarket (team leads, enterprise) without repositioning.

## Requirements

### DR-1: Positioning statement and value proposition

Define a single positioning statement using the CVFB framework that works across all marketing surfaces. The statement must distinguish Exarchos from stateless skill bundles (Superpowers) and one-shot agent launchers (Claude Squad, Auto-Claude).

**Acceptance criteria:**
- Positioning statement follows Customer / Value / Features / Business model structure
- Statement is under 50 words
- A/B testable tagline candidates (3-5) provided with rationale
- Competitive differentiation table included

### DR-2: Key terms and messaging vocabulary

Establish a controlled vocabulary of 15-25 key terms for use across README, ads, social media, and marketplace listing. Terms must be jargon-accessible (a Claude Code user understands them without reading the ADRs) while remaining technically accurate.

**Acceptance criteria:**
- Each term has: name, one-line definition, usage context (README / ad / social / all)
- Terms cover all five convergence dimensions without naming them as "D1-D5"
- No term requires reading an ADR to understand
- Terms are SEO-relevant for Claude Code plugin discovery

### DR-3: README restructure specification

Define the new README structure optimized for three read depths: scan (5 seconds), skim (30 seconds), and read (3 minutes). The README is simultaneously a marketplace listing, a landing page, and onboarding documentation.

**Acceptance criteria:**
- Scan layer: tagline + 1-sentence description + badge row (under 20 words of prose)
- Skim layer: 4-6 bullet value propositions using key terms from DR-2
- Read layer: workflow diagrams, installation, integrations
- Current README content preserved or improved, not deleted
- Competitive differentiation visible within skim layer

### DR-4: Social media and ad copy specifications

Provide templates for social media posts (Twitter/X, LinkedIn) and Google Ads copy that use the key terms and positioning from DR-1 and DR-2.

**Acceptance criteria:**
- 3 Twitter/X post templates (under 280 chars each, distinct angles)
- 2 LinkedIn post templates (professional tone, 100-200 words each)
- 3 Google Ads headlines (30 chars max) + 2 descriptions (90 chars max)
- All copy uses terms from the controlled vocabulary
- Each template targets the solo dev power user persona

### DR-5: Competitive landscape documentation

Document the competitive positioning relative to key competitors with honest assessment of strengths and weaknesses.

**Acceptance criteria:**
- Comparison covers: Superpowers, Claude Task Master, Auto-Claude, generic SDLC skill bundles
- Each competitor assessed on: durability, enforcement, auditability, team coordination, methodology
- Exarchos weaknesses acknowledged (not marketing fluff)
- Competitive moat identified and articulated

### DR-6: Basileus funnel alignment

Ensure the free Exarchos positioning creates a natural upgrade path to the paid Basileus platform without the free tier feeling crippled or the paid tier feeling like a bait-and-switch.

**Acceptance criteria:**
- Clear delineation: what Exarchos does locally vs. what Basileus adds in the cloud
- Messaging frames Basileus as "scale up" not "unlock features you need"
- At least one README mention of Basileus integration without dominating the page
- Funnel language tested against the "Mom Test" — does it describe real value or manufactured need?

### DR-7: Error cases and positioning risks

Identify positioning risks and failure modes.

**Acceptance criteria:**
- At least 3 risks identified (e.g., "governance" scares solo devs, "structure" implies rigidity)
- Mitigation strategy for each risk
- Anti-positioning defined: what Exarchos is NOT (not a Cursor replacement, not an IDE, not a model wrapper)

## Technical Design

### Positioning Statement (CVFB)

> **For** solo developers and power users of Claude Code **who** need their agent workflows to survive context loss and produce verifiable output, **Exarchos is** a free SDLC plugin **that** provides durable, phase-structured workflows with convergence-verified quality gates and a complete audit trail. **Unlike** stateless skill bundles that shape behavior within a single session, **Exarchos** persists workflow state across sessions, enforces multi-dimensional quality verification at every phase boundary, and traces every agent decision from design requirement to merged code.

### Competitive Differentiation Matrix

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

### Controlled Vocabulary (Key Terms)

**Tier 1 — Hero terms (README headline, ads, social):**

| Term | Definition | Context |
|:-----|:-----------|:--------|
| **Durable workflows** | Workflows that survive context compaction and session restarts — pick up where you left off | All |
| **Convergence gates** | Automated quality checks at every phase boundary that verify code against multiple independent dimensions before advancing | All |
| **SDLC structure** | Defined phases (design → plan → implement → review → ship) with human checkpoints at design and merge | All |
| **Audit trail** | Append-only event log recording every workflow transition, agent decision, and quality gate result | All |
| **Agent teams** | Parallel Claude Code instances working in isolated git worktrees, coordinated by the orchestrator | README, social |

**Tier 2 — Credibility terms (README body, LinkedIn, blog):**

| Term | Definition | Context |
|:-----|:-----------|:--------|
| **Event-sourced state** | Every state change is stored as an immutable event — state can be reconstructed by replaying the log | README, LinkedIn |
| **Provenance chain** | Traceability from design requirement → implementation task → test → merged code | README, LinkedIn |
| **Phase boundaries** | Explicit transition points between workflow phases where quality gates execute | README |
| **Checkpoint-resume** | Save workflow progress mid-session and resume in a new session without losing context | README, social |
| **Two-stage review** | Spec compliance verification first, then code quality assessment — automated, not vibes-based | README |
| **Quality verification** | Deterministic scripts (static analysis, security scanning, TDD compliance, provenance checks) that gate advancement | README |
| **Convergence dimensions** | Five independent quality axes — spec fidelity, architectural compliance, context economy, operational resilience, workflow determinism | README, blog |

**Tier 3 — Depth terms (docs, blog, technical content):**

| Term | Definition | Context |
|:-----|:-----------|:--------|
| **Adversarial verification** | Quality checks designed to find what's missing, not confirm what's present — "passing tests prove what they test, nothing about untested requirements" | Blog, docs |
| **CQRS readiness projections** | Pre-computed views that track whether a workflow phase is ready to advance, updated incrementally from events | Docs |
| **Graduated gate depth** | Earlier gates are lightweight (design completeness); later gates are comprehensive (all 5 convergence dimensions) | Docs, blog |
| **Remediation loop** | When a convergence gate fails, the workflow returns to the appropriate phase for fixes rather than blocking | Docs |
| **Context economy** | Minimizing token consumption through progressive disclosure, composite tools, and bounded payloads | Blog, docs |
| **Discriminative selection** | Agent decisions choose from constrained enum sets rather than generating free-form text — reducing variance | Docs |

**Terms to AVOID (too academic, too enterprise, or misleading):**

| Avoid | Why | Use Instead |
|:------|:----|:------------|
| CMDP / Constrained MDP | Academic jargon | "structured workflows" or "convergence gates" |
| HSM / Hierarchical State Machine | Academic jargon | "phase-gated workflow" |
| D1-D5 / convergence dimensions (numbered) | Internal notation | Name the dimensions: "spec fidelity, architectural compliance..." |
| Governance (as lead term) | Sounds enterprise/compliance | "structure" or "quality verification" |
| Enforcement (as lead term) | Sounds restrictive | "verification" or "quality gates" |
| Agent systems contract | Borrowed term, not ours | "durable workflows" |

### Tagline Candidates

Ranked by recommendation:

1. **"Structure for agentic development"** — Direct, descriptive, SEO-friendly. "Structure" is the core value proposition: not restriction, but shape. Implies the absence of structure is the problem.

2. **"Your agents forget. Exarchos doesn't."** — Pain-led, memorable, conversational. Works in ads and social. Slightly provocative. Risk: could be read as criticism of Claude Code itself.

3. **"Durable SDLC workflows for Claude Code"** — Technically precise, marketplace-optimized. Clear category positioning. Less emotional than #2. Best for the marketplace listing subtitle.

4. **"Ship verified code with AI agents"** — Outcome-focused. "Verified" is stronger than "production" because it implies a process, not a claim. Good for ads.

5. **"The SDLC toolchain for Claude Code"** — Positions as infrastructure, not a plugin. "Toolchain" implies completeness — this isn't one skill, it's the whole pipeline. Strong for developer identity ("I use a toolchain, not tips").

### README Restructure

**Scan layer (5 seconds):**
```markdown
<div align="center">
  <img src="exarchos-logo.png" alt="Exarchos" width="280" />

  [![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

  **Structure for agentic development**<br>
  Durable SDLC workflows · Convergence gates · Agent teams · Audit trail
</div>
```

**Skim layer (30 seconds) — replace current "Why Exarchos?" with:**
```markdown
## Why Exarchos?

Claude Code is powerful but unstructured. Agents lose context mid-task,
skip verification, produce monolithic diffs, and leave no record of what
they did or why. Exarchos adds SDLC structure.

- **Durable workflows.** State survives context compaction and session
  restarts. Checkpoint mid-task, resume tomorrow, on a different machine.
- **Convergence gates.** Five independent quality dimensions verified at
  every phase boundary — spec fidelity, architectural compliance, context
  economy, operational resilience, workflow determinism. Code advances
  only when all dimensions pass.
- **Structured phases.** Design → plan → implement → review → ship, with
  human checkpoints at design approval and merge. Everything between
  auto-continues.
- **Agent teams.** Delegate tasks to parallel Claude Code instances in
  isolated git worktrees. The orchestrator coordinates; teammates execute.
- **Two-stage review.** Spec compliance first (does it match the design?),
  then code quality (is it well-written?). Automated verification scripts,
  not vibes.
- **Full audit trail.** Append-only event log records every workflow
  transition, quality gate result, and agent decision. Trace what happened,
  when, and why.
```

**Read layer:** Preserve existing workflow diagrams, installation, and integration sections with minor term alignment.

### Social Media Templates

**Twitter/X (280 chars max):**

1. *Pain-led:*
> Claude Code agents lose context mid-task, skip tests, and leave no trace of what they did. Exarchos adds durable SDLC structure — phase-gated workflows, convergence gates, full audit trail. Free plugin. github.com/lvlup-sw/exarchos

2. *Differentiation-led:*
> Most Claude Code plugins suggest good behavior. Exarchos verifies it — 5 independent quality dimensions checked at every phase boundary, event-sourced state that survives context loss, provenance from requirement to merged code.

3. *Outcome-led:*
> Shipped a feature with Claude Code yesterday. Exarchos structured the workflow: design → plan → delegate to 3 agent teammates → two-stage review → PR. Full audit trail of every decision. Context died twice. Workflow resumed both times.

**LinkedIn (100-200 words):**

1. *Industry-trend angle:*
> The agent coding tools debate is settled: durable execution wins. Temporal proved it for backend workflows. Now the same principle applies to AI-assisted development.
>
> Claude Code is the most capable coding agent available, but it has no workflow structure. Agents lose context, skip verification steps, and produce code with no audit trail. Every session starts from scratch.
>
> We built Exarchos — a free Claude Code plugin that adds SDLC structure. Durable workflows that survive context compaction. Five-dimensional convergence gates at every phase boundary. Parallel agent teams in isolated git worktrees. An append-only event log tracing every decision from design requirement to merged code.
>
> It's the same architectural pattern (event sourcing, phase-gated transitions, adversarial verification) that enterprise systems use — packaged as a free, open-source plugin for individual developers.
>
> If you use Claude Code for anything beyond one-shot tasks, this changes how you work.

2. *Methodology angle:*
> What separates structured AI-assisted development from "prompting and hoping"?
>
> Verification at every step. Not just "did the tests pass?" but five independent quality dimensions: Does the code match the spec? Does it follow architectural patterns? Is it context-efficient? Is it operationally resilient? Is the workflow deterministic?
>
> Exarchos is a free Claude Code plugin that structures agent workflows into defined SDLC phases with convergence gates at each boundary. Your agents design, plan, implement, review, and ship — with quality verified before each transition.
>
> State persists across sessions. Every decision is logged. Requirements trace to code trace to tests. Free and open-source.

### Google Ads Copy

**Headlines (30 chars max):**
1. `SDLC Structure for Claude` (25)
2. `Durable Agent Workflows` (23)
3. `Verified AI-Written Code` (24)

**Descriptions (90 chars max):**
1. `Free plugin adds phase-gated SDLC workflows, quality gates, and audit trails to Claude Code` (91 — trim to: `Free plugin adds phase-gated SDLC workflows and quality gates to Claude Code` — 76)
2. `Workflows survive context loss. 5 quality dimensions verified at every phase boundary.` (86)

### Anti-Positioning (What Exarchos Is NOT)

| Exarchos is NOT | Why this matters |
|:----------------|:-----------------|
| A Cursor/Windsurf replacement | Exarchos extends Claude Code, not replaces your editor |
| An IDE or editor plugin | It's a workflow layer, not a code editing tool |
| A model wrapper or inference layer | It orchestrates process, not model calls |
| A task tracker (like Linear/Jira) | It's a workflow engine with quality verification, not a project management tool |
| Enterprise-only or "governance theater" | It's built for solo devs who want structure, not compliance officers |

### Positioning Risks and Mitigations

| Risk | Impact | Mitigation |
|:-----|:-------|:-----------|
| "Structure" implies rigidity | Solo devs avoid tools that slow them down | Messaging emphasizes structure enables speed: "auto-continues between human checkpoints" — you approve twice (design, merge), everything else flows |
| "Convergence gates" sounds academic | Users skip past unfamiliar jargon | Always follow with concrete language: "convergence gates — automated quality checks at every phase boundary" |
| Comparison to Superpowers triggers defensiveness | Superpowers community may push back | Position as complementary layer, not replacement: "Superpowers shapes behavior; Exarchos persists and verifies it" |
| "Audit trail" sounds enterprise | Solo devs don't think they need auditing | Reframe as personal utility: "trace what your agent did and why — especially useful when context dies mid-task" |
| Free product implies low quality | Users may assume "you get what you pay for" | Emphasize Apache-2.0, active development cadence, test coverage, and the Basileus platform story |

### Basileus Funnel Language

**README mention (one paragraph, end of page):**
```markdown
## Scaling Up

Exarchos runs entirely on your local machine. For teams that need cloud
execution in secure sandboxes, multi-provider model routing, and
enterprise observability, see [Basileus](https://basileus.dev) — the
platform that Exarchos workflows connect to.
```

**Funnel principle:** Exarchos is complete and useful alone. Basileus is where you go when the local model stops being enough — cloud sandboxes, team-wide audit aggregation, enterprise security. The upgrade is about scale, not missing features.

## Integration Points

- **Marketplace listing** (`/.claude-plugin/marketplace.json`): Update description and keywords to use Tier 1 terms
- **package.json**: Update `description` and `keywords` to match controlled vocabulary
- **README.md**: Restructure per DR-3 specification
- **Social media**: Use templates from DR-4 for launch and ongoing content
- **Google Ads**: Set up campaigns targeting "Claude Code plugin", "AI coding workflow", "agentic development tools"

## Testing Strategy

- **Marketplace A/B test**: Monitor install rates before/after README restructure (2-week window)
- **Social engagement**: Track impressions, clicks, and installs from each template angle (pain-led vs. outcome-led vs. differentiation-led)
- **Mom Test validation**: Before publishing, run the tagline and value prop past 3-5 Claude Code users who don't know Exarchos. Do they understand what it does? Do they want it?
- **Competitive response**: Monitor Superpowers and other plugins for feature convergence toward durability/gates

## Open Questions

1. **Marketplace listing constraints**: What character limits exist for the marketplace description and subtitle? This affects which tagline we use in that specific context.
2. **Visual assets**: Should we create diagrams/GIFs showing the workflow in action for the README and social? A 15-second GIF of "context dies → workflow resumes" could be powerful.
3. **Superpowers interop**: Should we explicitly position as compatible with Superpowers (use both), or as an alternative? Complementary positioning reduces friction but dilutes differentiation.
4. **Basileus timeline**: When is Basileus ready for public mention? The README funnel language should only go live when there's something to link to.
