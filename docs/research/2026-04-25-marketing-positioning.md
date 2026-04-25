# Marketing Positioning Research: Differentiating Exarchos in the Agent Harness Ecosystem

> **Status:** Discovery — `marketing-positioning-research`
> **Date:** 2026-04-25
> **Workflow:** `/exarchos:discover`
> **Companion deliverable:** `2026-04-25-readme-amendments.md` (proposed README rewrite)
> **Related:** `2026-04-23-rehydrate-differentiation.md` (rehydrate cache economics & memory architecture)
> **Scope:** Marketing-only. Recommends README copy changes; no implementation.

---

## 1. Why this research exists

Exarchos has strong primitives — a state machine that enforces SDLC phases, an append-only event log, deterministic convergence gates as TypeScript checks, and `/rehydrate` as a first-class projection — but the README under-sells them. Trending GitHub repositories in adjacent niches (Archon at 19k stars, Spec-Kit at 90k, claude-mem at 67k, agent-os, BMAD-METHOD, Superpowers) consume the oxygen with sharper hero lines and clearer "what's different" frames.

The user-stated goal: communicate the value props in a way that lands for a **solo Claude Code power user first**, while still working for **engineering teams / leaders evaluating agent governance**. Demonstrate differentiation against **common approaches**, not specific products.

This document lays out the landscape, identifies where Exarchos uniquely sits, and proposes a set of marketing principles. The README rewrite itself is in the companion file.

---

## 2. The landscape: six common approaches to "agent state and structure"

Surveying the trending and high-star repos in this space, products cluster into six approaches. None of them are wrong — they're just answers to different questions. Categorizing by approach (not by product name) is the right comparison lens because it makes the differentiation legible without picking fights.

### 2.1 Plan files in the repo (manual)

The pattern most readers already practice. `plan.md`, `todo.md`, `session_handoff.md`, `CLAUDE.md` updated between sessions. The agent reads them at startup. Discipline-driven.

- **Strengths:** Zero dependencies. Lives in git. Works with every agent.
- **Weaknesses:** Static, manual, goes stale. No enforcement — instructions in CLAUDE.md are advisory. No record of *why* a state changed. Compaction can still drop the in-flight work mid-task (Claude Code issue #26061: "Plan mode state lost after context compression").
- **Examples called out in the corpus:** the BSWEN three-file system (plan/todo/session_handoff), Chudi Nnorukam's "dev docs workflow," Andrej Karpathy-derived CLAUDE.md tweaks.

### 2.2 Memory layers (capture-and-inject)

Tools that watch a session, extract or compress what happened, and re-inject relevant slices into future sessions. claude-mem's pitch — "automatically captures everything Claude does … compresses it … injects relevant context back" — is the canonical version.

- **Strengths:** Transparent to the agent. Solves cross-session amnesia at the conversation level.
- **Weaknesses:** No structural model of *what task you were doing*. Inject the wrong slice and you bias the new session. Doesn't enforce phase order. No audit. Not a substitute for a workflow record.
- **Examples:** claude-mem (67k★), MemClaw, Hypercontext, Superpowers (memory-leaning variants).

### 2.3 Spec-driven toolkits

Commands that produce artifacts: a constitution, a spec, a plan, a task list. The user is the orchestrator; the AI fills in each artifact. The artifact is the deliverable; the workflow is "you write `/specify`, then `/plan`, then `/tasks`."

- **Strengths:** Linear, predictable, tool-agnostic. Specs as first-class artifacts. Works in any IDE.
- **Weaknesses:** Each command is independent — no enforcement that you ran them in order or finished one before starting the next. The "state machine" is in the user's head. Brownfield is a known weak spot.
- **Examples:** Spec-Kit (90k★), OpenSpec, related toolkits.

### 2.4 Multi-agent simulators (a "team in a box")

Many specialized AI personas — analyst, PM, developer, reviewer — collaborating in a scripted choreography. BMAD's "21 specialized AI agents" is the prototypical version.

- **Strengths:** Models a real team's separation of concerns. Comprehensive for greenfield work.
- **Weaknesses:** Heavy to set up. "Sledgehammer to crack a nut" critique appears repeatedly in independent reviews. Token cost compounds — multi-agent ≈ 15× single-agent token use per the harness-engineering literature. Less suited to a solo dev resuming yesterday's work.
- **Examples:** BMAD-METHOD, Agent-OS-style frameworks.

### 2.5 Workflow DAG engines

Define your dev process as a YAML or graph workflow. Nodes are AI prompts or deterministic steps. The engine runs the graph. Archon's pitch — "Like Dockerfiles for infra, GitHub Actions for CI/CD — Archon does for AI coding workflows" — is the prototype.

- **Strengths:** Repeatable. Worktree-per-run. Composable. Custom workflows per project. Multi-platform adapters (Slack/Telegram/Web).
- **Weaknesses:** *You write the workflow.* The engine doesn't know what an SDLC is — it runs whatever DAG you give it. No enforced convergence on a known SDLC pattern. Mid-run state lives in the engine's tables, not as a replayable contract.
- **Examples:** Archon (19k★), AgentFlow.

### 2.6 Hook-pipeline harnesses

Lifecycle hooks (PreToolUse, PostToolUse, SessionStart, Stop) wired to scripts that block, format, or validate. Each step in a pipeline is a hook with a hard `decision: block` exit.

- **Strengths:** Hooks fire deterministically. Hard gates that the model can't argue with. Cheap.
- **Weaknesses:** Hooks can be rewritten by the model itself (Claude Code RFC #45427 documents this). State across hooks lives in ad-hoc files. No structured replay. Subagents can bypass parent hooks in some configurations.
- **Examples:** autonomous-dev, sd0x-dev-flow, Chachamaru127/claude-code-harness.

---

## 3. Where Exarchos uniquely sits

Each of the six approaches above answers *one* question. Exarchos's differentiation is that it answers all of them through a single mechanism, and adds one capability nobody else has wired up first-class: **reconstructable workflow state**.

| Capability the reader needs | Where most approaches put it | Where Exarchos puts it |
|------------------------------|------------------------------|--------------------------|
| Survives `/clear` and compaction | Re-injection of a memory blob | A projection over an append-only event log; rehydrates the full workflow document in 2-3k tokens |
| Enforces SDLC phase order | Advisory text in CLAUDE.md or hook scripts | Hierarchical state machine; phase transitions are typed actions on `exarchos_workflow` |
| Verifies "is the work done?" | LLM-written review prompts | Deterministic TypeScript convergence gates against diff and git history |
| Coordinates multiple sub-agents | Hooks + worktrees + honor system | Typed agent roles (implementer, fixer, reviewer) with scoped tools and worktree isolation |
| Replayability / audit | Plan file revisions in git | Append-only event log with sequence numbers — rebuild state from any point |
| Works without the engine running | Engine owns mutable state | Event log is the source of truth; the engine is a projection layer |

Stated as a single sentence:

> **Exarchos is a workflow harness — not a workflow engine, a memory layer, or a spec toolkit.** A harness enforces a known shape of work; an engine runs whatever shape you give it. The shape Exarchos enforces is the SDLC, and it survives `/clear` because state lives in an event log, not in your context window.

This is the line that distinguishes Exarchos from the closest-looking competitor (workflow DAG engines): **a harness is opinionated about the SDLC; an engine asks you to bring your own.**

---

## 4. Pain points the corpus surfaces (in priority order for a solo Claude Code user)

These are the verbatim and near-verbatim phrasings the reader has already heard. The README should hook on at least the top three.

1. **"Plan mode state lost after context compression."** GitHub issue #26061 explicitly. After auto-compact, Claude Code prompts the user to re-enter plan mode even though the plan was already approved and implementation was in progress.
2. **"Every conversation starts from zero."** Cross-session amnesia. Quoted in code-relay, agentic-beacon, claude-mem, MemClaw, BSWEN, Felo Search.
3. **"Manual CLAUDE.md goes stale."** Felo: "static — you maintain it manually, it slowly goes stale … no history … no record of when decisions were made or why."
4. **"Rebuilding context becomes the biggest time sink."** BSWEN, on long projects spanning many sessions.
5. **"Hooks are advisory but the model can rewrite them."** Claude Code RFC #45427 — PreToolUse hooks fail silently, can be bypassed by subagents, can be rewritten by the model itself.
6. **"Every run is different."** Archon's hero phrasing: "what happens depends on the model's mood." Symptom of unenforced workflows.
7. **"Onboarding / re-orientation costs hours."** DevToolPicks: "Letting sessions grow too long … starts producing weird mistakes around hour two."

The first three are universal. The last four are felt by the same audience but slightly later in the maturity curve. Lead with #1 and #2.

---

## 5. Vocabulary the market uses (and what to do about each)

Words appearing repeatedly across the corpus, with a recommendation for each:

| Word / phrase | Status in our copy |
|----------------|--------------------|
| **Harness** | Use. Already differentiated and on-brand. Backed by Addy Osmani, LangChain, Augment Code blogs. |
| **Workflow harness** | Use. The exact differentiator vs "workflow engine" (DAG runners). |
| **Deterministic / repeatable** | Use sparingly. Adjacent products overuse it; we should *show* it (TypeScript convergence gates, event log) rather than claim it. |
| **State machine** | Use. Concrete and accurate. |
| **Event-sourced** | Use. Technical readers recognize it; non-technical readers will infer "durable record." |
| **Rehydrate** | Use. This is becoming the proper noun for our killer feature. |
| **Convergence gates** | Use, with a one-line gloss ("TypeScript checks against the diff, not prompts"). |
| **Context engineering** | Avoid as a primary frame. It belongs to memory tools. We do something *adjacent* (workflow engineering). |
| **Vibe coding** | Avoid. Negative framing of others is on-trend but lowers the tone. Compare on capability instead. |
| **Memory** | Avoid as a primary noun. Conflates with vector stores / RAG. Already in the controlled-vocabulary "avoid" list. |
| **Governance** | Avoid in solo-led copy. Surface only in a teams-facing section. |
| **Spec-driven** | Avoid. Owned by another category. We're SDLC-driven, which is bigger and includes specs. |
| **Multi-agent** | Use cautiously. Our agent teams are typed and small (3 roles); avoid implying BMAD-style 21-agent simulation. |

---

## 6. Marketing principles (the durable rules)

These are the rules to apply when revising any user-facing surface — README, landing page, docs, social. They're derived from what worked across the corpus and what the existing `docs/market/copy-templates.md` already establishes.

### Principle 1 — Lead with the shared pain, then the unique fix

Every reader has lost work to `/clear` or compaction. Open with that recognition, not a tagline. The current README does this in paragraph 1 ("you already manage this by hand") and that paragraph should be preserved and shortened, not replaced.

### Principle 2 — Show the seam, not the slogan

Don't write "deterministic." Show a one-line example of what a TypeScript convergence gate looks like or what `/rehydrate` returns. The reader is technical; concrete examples convert better than adjectives. Archon does this well with the YAML workflow snippet on the fold.

### Principle 3 — Position as a workflow harness, not a workflow engine

This is the single highest-leverage line. *Engines run any workflow you give them. Harnesses enforce a known one.* Exarchos enforces the SDLC. Lead with this whenever the question "how is this different from Archon-class tools" is asked or implied.

### Principle 4 — Compare on capability axes, not product names

The reader gets oriented faster from a six-row table ("plan files / memory layers / spec toolkits / DAG engines / hook pipelines / workflow harness") than from a per-competitor breakdown. It's also lower-conflict — we describe approaches, not roast products.

### Principle 5 — Solo-first, team-ready

Lead every section with the solo Claude Code use case (`/clear`, `/rehydrate`, single human approving the design). Add the team layer (audit trail, runbooks, agent specs) as a one-paragraph "and it scales when you want it to" passage near the end. Do not split the README into two audiences.

### Principle 6 — Rehydration is the killer feature; promote it accordingly

Currently buried as bullet four in "What you get." Promote it to its own section between the problem statement and the install block. Show a concrete example. Cite the token number (~2-3k). The companion document `2026-04-23-rehydrate-differentiation.md` already establishes that this surface is also a *cache-economics* lever — that's a teams-leaning argument and belongs in the secondary section, not the lead.

### Principle 7 — Concrete numbers beat vibes

Use specific numbers when they exist: ~2-3k tokens to rehydrate, ≤500 tokens MCP startup, 90% reduction on state queries via projection, single ~98 MB binary, four MCP tools. Numbers signal that the project measures itself.

### Principle 8 — Acknowledge the ecosystem; don't claim the universe

The README already mentions "Works well alongside" and runtime auto-detection (Claude / Codex / OpenCode / Copilot / Cursor). Keep that. It defuses the lock-in objection and invites coexistence rather than displacement.

---

## 7. Audience prioritization

| Audience | Lead question | What this README needs to answer in the first 60 seconds |
|----------|---------------|----------------------------------------------------------|
| **Solo Claude Code power user (lead)** | "Will this end the `/clear` problem and the stale-CLAUDE.md problem?" | Yes, via `/rehydrate` over an event log. Show the command and the token cost. |
| **Team / engineering lead (secondary)** | "Can my org standardize an SDLC for AI-assisted dev that actually enforces?" | Yes, via the state machine + audit trail + typed agent teams. Mentioned but not fronted. |

The dual-audience approach is achieved by ordering, not segregation. The solo material works for the team reader (every team lead is also a Claude Code user). The team material — audit trail, runbook MCP, multi-agent dispatch — does *not* work for the solo reader if it's the lead.

---

## 8. The "what's different" frame (reusable across surfaces)

This is the canonical six-row capability comparison. It belongs in the README, the landing page, and any longer-form pitch. It compares approaches, not products — and that's the entire point of the principles above.

| Approach | What it gives you | What it doesn't |
|-----------|-------------------|-----------------|
| Plan files in repo | A surface to write context to | Enforcement, replay, version of *why* |
| Memory layers | Re-injection of relevant past slices | Workflow structure, phase order, audit |
| Spec-driven toolkits | Artifacts (spec, plan, tasks) | A state machine that holds you to them |
| Multi-agent simulators | Role separation across many personas | Lightweight ergonomics for solo work |
| Workflow DAG engines | A general-purpose runner for any DAG | An opinion about what an SDLC looks like |
| **Workflow harness (Exarchos)** | **Enforced SDLC + event log + rehydratable state** | **Custom DAG authoring (intentionally — not the goal)** |

Caveats embedded in the table itself: nothing in column 3 is a *flaw* of the other approach. Each approach has the right "doesn't" for its purpose. Exarchos's "doesn't" — no custom DAG authoring — is a *position*, not a gap.

---

## 9. Concrete README amendments

The companion document `2026-04-25-readme-amendments.md` contains:

- A side-by-side of the current README sections and proposed replacements
- Three new sections (rehydration callout, "what's different" table, capability blocks)
- A condensed "What you get" rewrite
- Tightened install block

Apply via a normal `/exarchos:ideate` workflow if the directional changes here are accepted.

---

## 10. Open questions for the user

Before applying the README diff, two design calls remain:

1. **Show one rehydrate example or two?** A single block (the token count + a one-liner of returned state) is tighter; two blocks (`/checkpoint` first, then `/rehydrate`) tells the full story. Recommend one block.
2. **How aggressive on the "harness vs engine" framing?** Strong version: replace "workflow harness" with "workflow harness (not a workflow engine — see below)" in paragraph 1. Soft version: introduce the distinction only in the comparison table. Recommend the soft version on first contact and let the table do the work.

---

## 11. Sources

See `artifacts.sources` on workflow `marketing-positioning-research`. Headline references:

- Archon (`coleam00/Archon`) — workflow DAG engine archetype
- Spec-Kit (`github/spec-kit`) — spec-driven toolkit archetype
- claude-mem (`thedotmack/claude-mem`) — memory layer archetype
- BMAD-METHOD — multi-agent simulator archetype
- autonomous-dev, sd0x-dev-flow, Chachamaru127/claude-code-harness — hook-pipeline harness archetypes
- AddyOsmani / LangChain / Augment Code / harness-engineering.ai — terminology backing for "harness"
- Claude Code issue #26061 — plan-mode-after-compaction pain
- Claude Code RFC #45427 — hook bypass / model self-modification
- BSWEN / Felo / Chudi / DevToolPicks — solo developer pain narratives
- littlebearapps/pitchdocs — README "lobby principle" guidance
- Internal: `docs/research/2026-04-23-rehydrate-differentiation.md`, `docs/market/copy-templates.md`
