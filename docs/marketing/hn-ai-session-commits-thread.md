# HN Thread Analysis: "If AI writes code, should the session be part of the commit?"

**Source:** https://news.ycombinator.com/item?id=47212355
**Date:** 2026-03-02
**Stats:** ~260 points, ~240 comments
**Project:** [memento](https://github.com/mandel-macaque/memento) — git-notes-based AI session archival
**Submitted by:** mandel_x

---

## Executive Summary

A Hacker News discussion about whether AI coding sessions should be preserved alongside commits. The thread reveals strong demand for **structured workflow artifacts** (plans, specs, ADRs) over raw session transcripts. Multiple commenters independently describe workflows that closely mirror Exarchos's approach — committing plan files, iterating on specs before implementation, and maintaining living documentation. This validates Exarchos's core thesis while highlighting differentiation opportunities.

---

## Key Themes

### 1. Plan-Driven Development Is Already Emerging Organically

Multiple highly-upvoted commenters describe independently inventing plan-file workflows:

**jedberg** (top comment):
> "I start with a project.md file, where I describe what I want done. I then ask it to make a plan.md file... I then iterate on that plan.md with the AI until it's what I want. Then I tell it to execute the plan. Once done, I commit the project and plan files with the code."

**jumploops** (reply to jedberg):
> Describes a three-doc structure: design, plan, and debug files. Calls it "a living lexicon of the architecture" for future context-loading. Plans are prefixed by feature name and committed alongside code.

**miki123211:**
> Outlines a workflow with `.gitignored` directories for agent docs, creating structured context for AI sessions.

**shinycode:**
> "I also do that and it works quite well to iterate on spec md files first."

**nomilk:**
> Stores prompts in a versioned directory organized by feature, treating prompts as first-class project artifacts.

**Relevance to Exarchos:** These users are reinventing what Exarchos provides out of the box — structured ideation → planning → implementation workflows with committed artifacts. They're doing it manually with markdown files and ad-hoc conventions.

---

### 2. Raw Sessions Are Rejected; Distilled Artifacts Are Valued

The thread's strongest consensus: raw AI transcripts are noise, but distilled reasoning has value.

**827a** (second-most-upvoted top-level):
> "I don't think so. It's much the same problem as asking, for example, if every single line-by-line commit should be preserved..." Argues the noise outweighs the value.

**YoumuChan:**
> "Should my google search history be part of the commit? No."

**tpmoney:**
> "We don't make the keystroke logs part of the commit history." Draws parallel to raw sessions.

**rfw300:**
> "The agent session is a messy intermediate output..." Argues for polished commit messages/docs over raw transcripts.

**abustamam:**
> "I don't think it should be. I think a distilled summary... what changed, the mechanism, and the tests."

**But the counter-arguments for *some* preservation:**

**lacunary:**
> "If you just save the raw log... you can always ask new questions of it later." Argues raw logs enable future interrogation.

**aspenmartin:**
> Cites post-mortem and bug-hunting value — "pinpointing what part of the logic the AI got wrong."

**solarkraft:**
> "Corrections reveal actual requirements" — the back-and-forth exposes what the developer truly wanted.

**Relevance to Exarchos:** Exarchos's design documents, ADRs, and workflow state already solve this — they capture distilled intent without session noise. The checkpoint/resume mechanism preserves reasoning without raw transcript bloat.

---

### 3. The "Prompt as Source Code" Debate

A philosophical thread about whether prompts are the new source code:

**medstrom:**
> "The prompt is the code. The code is like a compiled binary."

**xigoi:**
> "The source code is whatever is easiest for a human to understand and modify."

**onion2k:**
> Frames this as analogous to the squash-commits debate — how much intermediate history should be preserved?

**globular-toast:**
> Distinguishes human-crafted development (where code is source) from fully agentic development (where prompts become source).

**Relevance to Exarchos:** Exarchos's skill system and structured prompts (SKILL.md files with frontmatter) treat prompts as engineered artifacts, not throwaway chat. This aligns with the "prompts as source code" perspective while avoiding the noise problem.

---

### 4. Tooling Landscape (Competitors & Adjacent Projects)

**memento** (thread subject):
- Git-notes-based approach to storing cleaned AI session transcripts
- Deliberately avoids polluting standard git history
- mandel_x: "That's why I chose git notes — they're separate from the commit history"

**DataClaw** (mentioned by woctordho):
- Archives sessions to JSONL, can publish to HuggingFace
- Positions as training-data pipeline for future AI models

**claudebin.com** (by vtemian):
- "Git was designed for humans. Commits, branches, and the entire workflow assume a person behind every change."
- Open-source Claude Code session sharing, human-readable format
- Can be embedded in PRs or blogs

**Entire.io** (mentioned by jwbron):
- Former GitHub CEO's startup
- "Checkpoints" concept for preserving AI development state

**GitHub spec-kit** (mentioned by frank00001):
- Spec-driven development approach from GitHub
- Formalizes the plan-first methodology

**Antigravity** (mentioned by StrangeSound):
- Inline document commenting tool for collaborative spec iteration

**Relevance to Exarchos:** These tools focus on *capturing* sessions or *sharing* them. None provide the full SDLC governance loop (ideate → plan → delegate → review → synthesize → cleanup). Exarchos occupies a different layer — it's the workflow engine, not just the artifact store.

---

### 5. Audit, Compliance, and Reproducibility

**Muromec:**
> Raises audit trail concerns for regulated environments — "if you work in a special place."

**rzerowan:**
> References the replication crisis in scientific research as analogy — AI-generated code without preserved reasoning creates similar reproducibility problems.

**D-Machine:**
> "Having the basic prompts, we can see if we run into similar issues given a bad prompt." Values sessions for debugging AI-specific failure modes.

**killingtime74:**
> "The models change all the time and are not deterministic." Points out that even preserved sessions aren't truly reproducible.

**mandel_x (OP):**
> Explains memento motivation: "audit the vibe-code tool itself" — understanding *how* AI tools perform, not just what they produce.

**Relevance to Exarchos:** Exarchos's event-sourced workflow state provides an audit trail by design. The workflow transitions, checkpoints, and review phases create a compliance-friendly record without needing raw session transcripts.

---

### 6. Show HN Quality Crisis (Meta-Discussion)

HN moderator **dang** frames a broader problem:
> "People have been submitting so many Show HNs of generated apps... the only novel element is that an LLM was involved... So, community: what should we do?"

**tptacek:**
> "A starting point would be excluding Show HNs with generated READMEs, or that lack human-written explanations."

**maxbond:**
> Proposes heavier submission friction: one Show HN per week limit, review queue approval.

**grey-area:**
> Suggests banning fully automated HN comments/accounts, tagging AI-generated submissions.

**CuriouslyC:**
> Counters effort-based objections: "Taking a good picture requires very little effort once you've found yourself in the right place. You gonna shit on Ansel Adams?"

**Relevance to Exarchos:** The quality problem dang describes is exactly what structured workflows solve. Projects built with proper ideation → planning → review cycles produce substantive artifacts that demonstrate real engineering effort, not just "vibe coded" output.

---

## Market Signals

### Validated Demand
1. **Plan-file workflows** — Multiple users independently invented what Exarchos systematizes
2. **Structured artifact preservation** — Strong consensus that *distilled* reasoning belongs in repos
3. **Workflow governance** — Desire for process around AI-assisted development, not just raw output
4. **Context recovery** — Several mentions of needing to resume/reload context across sessions

### Differentiation Opportunities
1. **Full lifecycle** — Competitors capture sessions or share them; Exarchos governs the entire SDLC
2. **Distillation by design** — Exarchos produces design docs, plans, and review artifacts, not raw transcripts
3. **Agent coordination** — No competitor mentioned handles multi-agent delegation
4. **Event-sourced state** — Workflow state that survives context compaction is unique

### Messaging Angles
1. "Your plan.md workflow, systematized" — target the jedberg/jumploops cohort who are doing this manually
2. "Distilled intent, not session noise" — address the dominant concern about raw transcript clutter
3. "Governance for AI-assisted development" — appeal to the audit/compliance crowd
4. "Workflows that survive context windows" — address the session-loss pain point

---

## Notable Quotes for Marketing Use

> "I start with a project.md file... I then iterate on that plan.md with the AI until it's what I want. Then I tell it to execute the plan." — jedberg

> "A living lexicon of the architecture" — jumploops (describing plan/design files)

> "Having the basic prompts, we can see if we run into similar issues given a bad prompt." — D-Machine

> "The prompt is the code. The code is like a compiled binary." — medstrom

> "Corrections reveal actual requirements." — solarkraft

> "Should my google search history be part of the commit? No." — YoumuChan (counterpoint to address)

> "Git was designed for humans." — vtemian

---

## Commenters of Interest

| Username | Signal | Why |
|----------|--------|-----|
| jedberg | Power user, plan-driven workflow | Top comment; already doing Exarchos-style planning manually |
| jumploops | Multi-doc architecture workflow | "Living lexicon" framing; sophisticated approach |
| brendanmc6 | Acceptance-criteria IDs in specs | Describes spec-driven development with cross-referenced IDs |
| D-Machine | Audit/debugging value of sessions | Multiple thoughtful comments on distillation vs. raw capture |
| dang | HN moderator | Framing the quality problem Exarchos could solve |
| tptacek | Security/quality bar advocate | Influential voice proposing quality filters |
| mandel_x | memento author, adjacent space | Potential collaborator or integration partner |
| vtemian | claudebin.com builder | Adjacent tooling, sharing-focused |
| sunir | Agent repo with compressed memories | "Set up the agent in the repo" — similar architectural instinct |
| claud_ia | ADR advocate | Proposes synthesizing ADRs at session close — exactly what Exarchos does |

---

## Competitive Positioning Matrix

| Feature | memento | DataClaw | claudebin | Entire.io | Exarchos |
|---------|---------|----------|-----------|-----------|----------|
| Session capture | git notes | JSONL export | HTML render | Checkpoints | Event-sourced state |
| Workflow governance | No | No | No | Unclear | Full SDLC |
| Plan artifacts | No | No | No | No | Design docs, plans |
| Agent coordination | No | No | No | No | Team delegation |
| Review process | No | No | No | No | Two-stage review |
| Context recovery | No | No | No | Partial | Checkpoint/resume |
| Distilled output | Cleaned transcript | Raw archive | Formatted session | Unknown | ADRs, specs, plans |

---

*Captured 2026-03-02 for lvlup-sw market research.*
