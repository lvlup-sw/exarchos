# Proposed README Amendments (v2)

> **Status:** Discovery deliverable, `marketing-positioning-research`
> **Date:** 2026-04-25
> **Companion:** `2026-04-25-marketing-positioning.md` (research and rationale)
> **Frameworks applied:** copywriting, page-cro, competitor-alternatives, and marketing-psychology skills from `coreyhaines31/marketingskills`. Final pass: `/humanize` against the 24-pattern AI-writing checklist.

This is a section-by-section rewrite. Each block shows the **current text** then the **proposed text**, with rationale tying back to a specific copywriting or psychology principle.

---

## What changed in v2

The v1 draft sketched the structure but the copy was too generic, leaned heavily on the Claude Code plugin as the lead install path, and under-stated platform support. v2 fixes three things.

1. **Platform-agnosticity is the headline, not the architecture footnote.** The CLI is the product. The Claude Code plugin is one delivery mechanism. Codex, Cursor, OpenCode, Copilot, and generic CLI agents are first-class targets for skill rendering and MCP transport.
2. **Specificity replaces vague benefits.** Concrete numbers and a one-screen rehydrate transcript replace prose claims. ("Survives `/clear`" is shown, not asserted.)
3. **Honesty replaces puffery.** A new "Where Exarchos isn't the right fit" line applies the pratfall effect: admitting weaknesses raises trust and clarifies fit.

---

## Proposed change 1 — Hero, lede, killer-feature callout

### Current

```markdown
**Your agents forget. Exarchos doesn't.**
A local-first SDLC workflow harness — structured, durable state for coding agents.

## You already manage this by hand

A plan file per feature, CLAUDE.md updated between sessions, summaries written out before `/clear` so the next context window has something to work with. Maybe you enforce your own phases — design, plan, implement, review. It works. It's also manual, and nothing holds the agent to it once the window gets long enough that your instructions start getting ignored.

## Your plan.md workflow, with teeth

Exarchos is a local-first SDLC workflow harness. It gives your agent structured, durable state that lives outside the context window. Phase transitions are enforced by a state machine. Deterministic convergence gates run as TypeScript checks against your diff and git history, not prompts. You approve the design, you approve the merge — everything between runs on its own.

`/clear` whenever you want. `/rehydrate` when you're back. State persists.

It ships as a Claude Code plugin and a standalone MCP server with a CLI adapter. Install it and run `/ideate`.
```

### Proposed

```markdown
**Your agents forget. Exarchos doesn't.**

Persistent SDLC state for any AI coding agent. Survives `/clear`, auto-compaction, and context overflow. First-class with Claude Code; works with Codex, Cursor, OpenCode, Copilot, and any agent that runs a CLI.

## You already manage this by hand

A `plan.md` per feature. `CLAUDE.md` rewritten between sessions. Summaries scrawled before `/clear` so the next session has something to start from. Phases enforced by you reminding the agent. It works. It's also manual, and one long context window away from the agent ignoring all of it.

## Survives `/clear`
```bash
You: continue the auth refactor we planned yesterday
Agent: which workflow? checking exarchos…
       → /rehydrate auth-refactor
       → restored: design approved, 4 of 7 tasks done,
         last commit on feature/auth-refactor,
         gates pending on tasks 5–7 (~2,500 tokens)
       → continuing from task 5

State doesn't live in your conversation. It lives in an append-only event log. `/rehydrate` is a projection that rebuilds the workflow document (phase, design, task table, gate results, last commit) for a fresh context window. Same place, no re-explaining.

## Your plan.md workflow, with teeth

A state machine owns phase transitions, not a paragraph in `CLAUDE.md`. Convergence between phases ("is this implemented?", "does it match the design?") runs as TypeScript checks against your diff and git history, not prompts the agent can talk itself out of. You approve the design and you approve the merge. The middle runs on its own.

Run `/ideate` to start.
```

**Principles applied:**

- *Copywriting (clarity over cleverness, specificity over vagueness).* The lede answers "what is this?" in one sentence and names the runtimes inline. The pain paragraph swaps generic ("plan file per feature") for concrete ("scrawled before `/clear`").
- *Marketing psychology (Jobs to be Done).* The job is "ship features with my AI agent without losing the plot every `/clear`." Hero subheader names the job; rehydrate transcript shows it being done.
- *Page-CRO 5-second value prop.* A scanner reading hero plus the first paragraph of "Survives /clear" gets the entire pitch.
- *Show, don't tell.* The rehydrate block is a real-shape transcript, not a feature description.
- *Marketing principle 9 (platform-agnosticity in the lede).* Runtime list named in the second sentence, not the architecture section.

---

## Proposed change 2 — Add a "Works with your agent" section

This is the single most important new section. Insert it between **Survives `/clear`** and **Install**.

```markdown
## Works with your agent

The CLI is the universal surface. Each runtime talks to it through whichever invocation it speaks natively.

| Runtime | Transport | Skill rendering | Slash commands |
|---------|-----------|------------------|----------------|
| **Claude Code** | Plugin + MCP | First-class (rendered + hooks) | Yes (`/ideate`, `/plan`, etc.) |
| **Codex CLI** | MCP | First-class | Via Codex's command surface |
| **Cursor** | MCP | First-class | Via Cursor's MCP integration |
| **OpenCode** | CLI | First-class | Via OpenCode's runtime |
| **GitHub Copilot CLI** | CLI | First-class | Via Copilot's runtime |
| Anything else | CLI | Generic bundle | Whatever your agent supports |

```bash
exarchos install-skills
```

Auto-detects which runtime is on your `PATH` and installs the matching skill bundle. One match installs that bundle. Multiple matches prompt you to pick. No match installs the generic bundle and tells you what it found and why.

The Claude Code plugin is convenience for that runtime. The product is the CLI.
```

**Principles applied:**

- *Marketing principle 9.* This section makes the design choice visible.
- *Page-CRO trust signals.* A matrix is a credibility move; it shows the work has been done across runtimes, not just promised.
- *Pratfall effect.* "Whatever your agent supports" is honest about the generic-runtime ceiling.
- *Status-quo bias.* "Auto-detects" reduces switching friction for readers already on Codex or Cursor.

---

## Proposed change 3 — Reorder the install block

CLI first (universal), Claude Code plugin second (Tier 1 sugar). The current order reads as "this is a Claude Code plugin," which contradicts platform-agnosticity.

### Proposed

```markdown
## Install

The CLI is the universal surface. The plugin is sugar for Claude Code.

**Standalone CLI / MCP server (any agent, any runtime):**

```bash
# Unix
curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh | bash

# Windows
irm https://lvlup-sw.github.io/exarchos/get-exarchos.ps1 | iex

exarchos doctor      # confirm install
exarchos mcp         # run as MCP server over stdio
```

A self-contained ~98 MB binary at `~/.local/bin/exarchos`. No Node, npm, or Bun required. The installer pins SHA-512, adds `~/.local/bin` to your PATH (idempotent), and resolves the latest release. Pin a specific version with `--version v2.9.0-rc.1`.

**Claude Code plugin (Tier 1 ergonomics):**

```bash
/plugin marketplace add lvlup-sw/.github
/plugin install exarchos@lvlup-sw
```

Same binary underneath. Adds Claude Code slash commands, hooks, and rendered skills.

> **Status:** Marketplace tracks **v2.9.0-rc.1** (release candidate). Release notes: [v2.9.0-rc.1](https://github.com/lvlup-sw/exarchos/releases/tag/v2.9.0-rc.1).

For two-step download/inspect/run, channel selection, validation, update, and uninstall: see the [full install guide](https://lvlup-sw.github.io/exarchos/guide/installation).
```

**Principles applied:**

- *Marketing principle 9.* CLI first reads as "platform-agnostic tool." Plugin first reads as "Claude Code add-on."
- *Anchoring effect.* The first install method is the one readers anchor on as the canonical path. Make it the universal one.
- *Page-CRO friction reduction.* Three install paths with one dominant. No paradox of choice.

---

## Proposed change 4 — "What's different" with a "best for" column

The v1 draft compared on what each approach gives and doesn't give. The competitor-alternatives skill points out a missing column: who each is best for. Honest recommendations build trust. Insert between **Install** and **What you get**.

```markdown
## What's different

Other approaches in this space optimize for different things. None are wrong. They answer different questions.

| Approach | What it gives you | Best for |
|----------|-------------------|----------|
| Plan files in repo (manual) | A surface to write context to | Solo, short-lived projects, simple tasks |
| Memory layers | Re-injection of relevant past conversation slices | Cross-session chat continuity |
| Spec-driven toolkits | Artifacts (spec, plan, tasks) as deliverables | Greenfield work where the spec is the deliverable |
| Multi-agent simulators | Many specialized AI personas in concert | Enterprise greenfield with heavy planning |
| Workflow DAG engines | A general-purpose runner for any DAG you write | Custom orchestration across your own pipelines |
| **Workflow harness (Exarchos)** | **Enforced SDLC + event log + rehydratable state** | **Solo and team SDLC work that needs to survive `/clear`** |

A harness is opinionated about the shape of work. An engine isn't. Exarchos's shape is the SDLC, and the state survives `/clear` because it lives in an event log instead of the context window.

**Where Exarchos isn't the right fit:** if you want to author a custom DAG, run 21 specialized AI personas, or just keep chat continuity across sessions, there are better tools for those jobs. Exarchos answers one question: "how do I keep an AI coding agent on the rails through a multi-day SDLC."
```

**Principles applied:**

- *Competitor-alternatives skill (honesty builds trust).* The "best for" column gives readers a real recommendation. The "isn't the right fit" line names the disqualifying cases.
- *Pratfall effect.* Admitting what Exarchos doesn't do raises perceived honesty and helps the reader self-select.
- *Curse-of-knowledge fix.* The "isn't the right fit" line is also a vocabulary check; readers from each adjacent category will recognize themselves and route correctly.
- *Marketing principle 3 (harness vs engine).* Explicit, but the table does the heavy lifting.

---

## Proposed change 5 — "What you get" rewritten as four pain-anchored blocks

### Current

Seven flat bullets reading as a feature list. Audit trail and token efficiency are equal-billed with the rehydrate killer feature.

### Proposed

```markdown
## What you get

**`/clear` no longer costs you anything.** State lives in an append-only event log. `/checkpoint` saves mid-task; `/rehydrate` restores the full workflow document (phase, design, task table, gate results) in about 2,500 tokens. If state and reality drift, reconcile from any point in history.

**Phases that enforce themselves.** A state machine owns transitions across four workflow types: `feature`, `debug`, `refactor`, `oneshot`. The agent can't skip review because the context got long. The state machine refuses the transition.

**Convergence gates run as code.** Two-stage review. Spec compliance first ("does this match the approved design?"), code quality second ("is it well-written?"). Both are TypeScript checks against your diff and git history, with exit codes. No "the model should evaluate."

**Typed agent teams in worktrees.** Three roles, scoped tools. Implementer writes code via TDD. Fixer resumes failed tasks with the failure event in context, not a fresh start. Reviewer is read-only and can't edit files. Each role runs in its own git worktree.

Audit trail comes free. Every transition, gate result, and agent action lands in the event log. Trace it, replay it, rebuild from scratch.

Token-efficient by construction. ≤500 tokens to register the MCP surface. Lazy schema loading. Field projection trims state queries by ~90%. Review sends diffs, not full files.
```

**Principles applied:**

- *Copywriting (benefits over features).* Each bold opener is a benefit. `/clear` no longer costs you. Phases enforce themselves. Gates run as code. Agents resume failures with context. The mechanism follows in the body.
- *Specificity.* "About 2,500 tokens" beats "low token count." "≤500 tokens to register the MCP surface" beats "fast startup."
- *Marketing principle 6 (promote the killer feature).* Rehydrate is the first block, not the fourth bullet.
- *Customer language.* "Refuses the transition" is concrete and slightly memorable. "Enforces phase ordering" would be flatter.

---

## Proposed change 6 — "When a team adopts it" passage

Insert one paragraph between **Architecture** and **Workflows**. Solo-led ordering preserved.

```markdown
### When a team adopts it

Same primitives, more places. Runbooks (machine-readable orchestration sequences served via MCP) let any agent request "the steps for the implementing phase" and get back ordered tool calls with schemas and gate semantics. Agent specs are typed and committed to the repo, so every team member's agent inherits the same scoped tools and hooks. The single binary runs identically on a developer's laptop and in CI. Everything in the event log is auditable: when a workflow goes sideways, you have a replayable record of what the agent did and which gate said no.
```

**Principles applied:**

- *Marketing principle 5 (solo-first, team-ready).* One paragraph, late in the page, after the solo case has landed.
- *Specificity.* "Replayable record of which gate said no" is concrete; "audit trail" alone is generic.
- *Avoiding "governance".* Per controlled vocabulary, the word governance is too enterprise-leaning for first contact. The substance is governance; the word stays out.

---

## Proposed final ordering (above the fold and below)

1. Hero (`Your agents forget. Exarchos doesn't.`) + runtime-list subheader
2. **You already manage this by hand** (tightened)
3. **Survives `/clear`** *(new — rehydrate transcript)*
4. **Your plan.md workflow, with teeth** (kept, shortened)
5. Architecture diagram
6. **Works with your agent** *(new — runtime matrix)*
7. **Install** (CLI first, plugin second)
8. **What's different** *(new — six-row table with "best for" column)*
9. **What you get** (four pain-anchored blocks)
10. **Agent-first architecture** (kept)
11. **When a team adopts it** *(new paragraph)*
12. Works well alongside (kept)
13. Workflows (kept)
14. Build & test (kept)
15. License (kept)

---

## What stays unchanged

- Hero tagline (`Your agents forget. Exarchos doesn't.`). Strong.
- Architecture SVG. Strong.
- Four-tool MCP table (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`). Strong.
- Workflows tables (lifecycle commands and "When you need to..." table). Strong.
- Build & test, license, footer. No reason to touch them.

---

## Vocabulary updates for `docs/market/copy-templates.md`

Add to "Use":

- **runtime-agnostic** — accurate description of the CLI's design
- **harness-agnostic** — alternative phrasing for the same idea
- **first-class for Tier 1** — names the Claude Code / Codex / Cursor priority
- **graceful degradation** — names the OpenCode / Copilot / generic story
- **survives `/clear`** — short-form benefit phrase, ready for one-liners

Keep all existing "Avoid" rules. The proposed copy honors them: no "governance" in solo-led sections, no "memory" as a primary noun, no "seamless / unlock / leverage / delve."

---

## Apply path

If the directional choices above land, two paths to apply:

1. **Copy-only commit.** Pull the proposed text directly into `README.md`. Single PR.
2. **`/exarchos:ideate readme-rewrite-2026-04`.** Treat this as a small feature (it touches one file, but the marketing surface area is large). Lets the design and review phases catch anything I missed.

Recommend path 1 unless someone other than the author wants reviewer time on the copy.
