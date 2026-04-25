# Proposed README Amendments

> **Status:** Discovery deliverable — `marketing-positioning-research`
> **Date:** 2026-04-25
> **Companion:** `2026-04-25-marketing-positioning.md` (research and rationale)
> **Action expected:** Review the proposed rewrites below; if accepted directionally, apply via `/exarchos:ideate readme-rewrite-2026-04` (or commit directly if changes are limited to copy).

This document proposes a section-by-section rewrite of the README. Each section shows the **current text** and the **proposed text**, with a short rationale tying back to the marketing principles in the companion doc.

---

## Summary of proposed changes

1. **Tighten the lede** — keep the hero, shorten paragraph 1, move paragraph 2 below the new rehydration callout.
2. **Add a rehydration callout** between the lede and the install block. This is the killer feature; promote it.
3. **Add a "what's different" comparison table** — six approaches, capability-only, no product names.
4. **Reorganize "What you get"** into four pain-anchored capability blocks instead of seven flat bullets.
5. **Add a one-paragraph "for teams" passage** near the end. Solo-led ordering preserved.
6. **Trim the install block** modestly — it's currently a third of the page above the fold.

Lower priority (not blocking): the architecture section is already strong; leave it. Workflows tables are great; leave them. Build & test, license — leave.

---

## Proposed change 1 — Hero and lede

### Current

```markdown
## You already manage this by hand

A plan file per feature, CLAUDE.md updated between sessions, summaries written out before `/clear` so the next context window has something to work with. Maybe you enforce your own phases — design, plan, implement, review. It works. It's also manual, and nothing holds the agent to it once the window gets long enough that your instructions start getting ignored.

## Your plan.md workflow, with teeth

Exarchos is a local-first SDLC workflow harness. It gives your agent structured, durable state that lives outside the context window. Phase transitions are enforced by a state machine. Deterministic convergence gates run as TypeScript checks against your diff and git history, not prompts. You approve the design, you approve the merge — everything between runs on its own.

`/clear` whenever you want. `/rehydrate` when you're back. State persists.

It ships as a Claude Code plugin and a standalone MCP server with a CLI adapter. Install it and run `/ideate`.
```

### Proposed

```markdown
## You already manage this by hand

A plan file per feature, `CLAUDE.md` updated between sessions, summaries written before `/clear` so the next context window has something to work with. It works. It's also manual — and nothing holds the agent to it once the window gets long enough that your instructions start getting ignored.

## Survives `/clear`

Exarchos is a local-first SDLC workflow harness — it gives your agent structured, durable state outside the context window. The killer move:

```bash
# Mid-task, context filling up
/checkpoint

# /clear, close the laptop, come back tomorrow
/rehydrate
# → full workflow document restored in ~2-3k tokens:
#   phase, approved design, task table, gate results, last commit
```

State doesn't live in the conversation. It lives in an append-only event log. `/rehydrate` is a projection that rebuilds the workflow document from events — so a fresh context window picks up exactly where the last one left off, without re-explaining anything.

That alone is the reason most users install it. The rest is what you get for free once state is durable.

## Your plan.md workflow, with teeth

Phase transitions are enforced by a state machine, not a paragraph in `CLAUDE.md`. Convergence between phases — "is this implemented?", "does it match the design?" — runs as deterministic TypeScript checks against your diff and git history, not as prompts the agent can talk itself out of. You approve the design and you approve the merge. Everything between auto-continues.

It ships as a Claude Code plugin and a standalone MCP server with a CLI adapter. Install it and run `/ideate`.
```

**Rationale (principles 1, 2, 6):** lead with the shared pain, show the seam (the actual command pair), promote rehydration to the hero spot. The "/clear whenever you want" line is preserved inside the new code block — it now comes with proof. Removes the awkward double-tagline ("with teeth" + "structured durable state"); each paragraph now does one job.

---

## Proposed change 2 — New section: "What's different"

Insert this section between **Install** and **What you get**.

```markdown
## What's different

Exarchos isn't the only project that tries to give coding agents structure. It approaches the problem differently from the common patterns:

| Approach | What it gives you | What it doesn't |
|-----------|-------------------|-----------------|
| Plan files in repo (manual) | A surface to write context to | Enforcement, replay, the *why* behind a state change |
| Memory layers | Re-injection of relevant past slices | Workflow structure, phase order, audit trail |
| Spec-driven toolkits | Artifacts (spec, plan, tasks) | A state machine that holds you to them |
| Multi-agent simulators | Many specialized personas in concert | Lightweight ergonomics for solo work |
| Workflow DAG engines | A general runner for any DAG you write | An opinion about what an SDLC actually looks like |
| **Workflow harness (Exarchos)** | **Enforced SDLC + event log + rehydratable state** | **Custom DAG authoring (intentionally — not the goal)** |

A harness is opinionated about the shape of work. An engine isn't. Exarchos's shape is the SDLC, and it survives `/clear` because the state of work lives in an event log instead of in your context window.
```

**Rationale (principles 3, 4):** the canonical "what's different" frame from the research doc, lifted into the README. Compares approaches, not products. Closes with the harness-vs-engine line — the single highest-leverage distinction in the corpus.

---

## Proposed change 3 — Rewrite "What you get"

### Current

The current section has seven flat bullets (workflow types, checkpoint/resume, typed agent teams, runbooks, two-stage review, audit trail, token-efficient). Reads as a feature list, not a value story.

### Proposed

```markdown
## What you get

Four pain points, four answers:

**Survives `/clear` and compaction.** State lives in an append-only event log, not in your conversation. `/checkpoint` saves mid-task; `/rehydrate` returns the full workflow document in ~2-3k tokens. Reconcile from any point in history if state and reality diverge.

**Phases that actually enforce.** A state machine — not advisory prose — owns transitions across the four workflow types: feature, debug, refactor, oneshot. The agent can't skip review because the context got long; the state machine won't let it through.

**Convergence gates as code.** Deterministic TypeScript checks run against your diff and git history. Two-stage review is the visible payoff: spec compliance first ("does it match the approved design?"), code quality second ("is it well-written?"). Both stages are checks, not prompts.

**Typed agent teams in worktrees.** Three roles with scoped tools — implementer (writes code via TDD), fixer (resumes failed tasks with full context), reviewer (read-only, can't edit files). Each runs in its own git worktree. Failure recovery is "spawn a fixer with the failure event," not "start over."

Audit trail comes free: every transition, gate result, and agent action goes into the event log. Trace what happened, replay, or rebuild state from scratch.

Token-efficient by design: ≤500 tokens to register the MCP surface, lazy schema loading on demand, field projection trims state queries by ~90%. Review sends diffs, not full files.
```

**Rationale (principles 1, 2, 7):** four blocks, each anchored to a pain point the reader actually has. Audit trail and token efficiency demoted to closing paragraphs — they support the four pillars rather than competing with them. Concrete numbers preserved (≤500, ~90%, ~2-3k).

---

## Proposed change 4 — Add a "for teams" paragraph

Insert this single paragraph between **Architecture** and **Workflows** sections. Do not split the page into "for solo / for teams."

```markdown
### When a team adopts it

The same primitives scale beyond solo use. Runbooks (machine-readable orchestration sequences served via MCP) let any agent request the steps for a given phase and get back ordered tool calls with schemas and gate semantics. The append-only event log is an audit trail by construction. Agent specs are typed and checked-in: every team member's agent inherits the same scoped tools and hooks. The single binary distribution means CI runs Exarchos identically to a developer's laptop.
```

**Rationale (principle 5):** team material exists, but as a one-paragraph supplement after the solo-anchored case has already landed.

---

## Proposed change 5 — Trim the install block

The install block currently runs ~30 lines, occupying a large fraction of the above-the-fold real estate. Trim by deferring detail to the docs.

### Proposed

```markdown
## Install

> **Status:** Marketplace tracks **v2.9.0-rc.1** (release candidate). Release notes: [v2.9.0-rc.1](https://github.com/lvlup-sw/exarchos/releases/tag/v2.9.0-rc.1).

**Claude Code plugin:**
```bash
/plugin marketplace add lvlup-sw/.github
/plugin install exarchos@lvlup-sw
```

**Standalone CLI / MCP server (single ~98 MB binary, no Node/Bun required):**
```bash
# Unix
curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh | bash
# Windows
irm https://lvlup-sw.github.io/exarchos/get-exarchos.ps1 | iex

exarchos doctor
exarchos mcp
```

The installer resolves the latest release, verifies SHA-512, and adds `~/.local/bin` to your PATH. Pin a version with `--version v2.9.0-rc.1`. Channel selection, two-step download/inspect/run, validation, update, and uninstall: see the [full install guide](https://lvlup-sw.github.io/exarchos/guide/installation).

After install, render skills for your runtime:
```bash
exarchos install-skills   # auto-detects Claude / Codex / OpenCode / Copilot / Cursor
```
```

**Rationale (lobby principle):** the README is the lobby of the repo, not the manual. Detail belongs in the install guide; the README needs enough to start.

---

## Section ordering after all proposed changes

The above-the-fold flow becomes:

1. Hero (`Your agents forget. Exarchos doesn't.`)
2. **You already manage this by hand** — tightened
3. **Survives `/clear`** *(new — rehydration callout with code block)*
4. **Your plan.md workflow, with teeth** — kept, shortened
5. Architecture diagram
6. **Install** — trimmed
7. Skills install (`exarchos install-skills`)
8. **What's different** *(new — six-row comparison table)*
9. **What you get** — rewritten as four capability blocks
10. **Agent-first architecture** — kept
11. **When a team adopts it** *(new paragraph)*
12. Works well alongside — kept
13. Workflows — kept (tables)
14. Build & test — kept
15. License — kept

---

## Out of scope for this round

- Hero tagline ("Your agents forget. Exarchos doesn't.") — strong, keep.
- Architecture SVG and the four-tool MCP table — strong, keep.
- Workflows tables — strong, keep.
- Logo, badges, footer — no changes proposed.

---

## Notes on tone consistency

All proposed copy honors the controlled vocabulary in `docs/market/copy-templates.md`:

- Uses: `harness`, `workflow harness`, `state machine`, `event log`, `event-sourced`, `convergence gates`, `rehydrate`, `checkpoint`, `typed agent teams`, `worktree`, `local-first`.
- Avoids: `governance` (in solo-led copy), `memory` as a primary noun, `seamless`, `groundbreaking`, `unlock`, `delve`, `leverage`, `vibe coding`, "missing piece" framing.
- Adds one new term: **workflow harness vs workflow engine** distinction. Recommend adding this to the copy-templates "Use" list.
