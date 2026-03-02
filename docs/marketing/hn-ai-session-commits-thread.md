# HN Market Intelligence: Structured Agent Workflows

Two HN threads and a detailed blog post capturing the state of structured agent development, parallel agent coordination, and plan-driven workflows in the Claude Code ecosystem. Both threads validate Exarchos's core thesis: power users are independently building the workflows Exarchos systematizes.

---

# Thread 1: "If AI writes code, should the session be part of the commit?"

**Source:** https://news.ycombinator.com/item?id=47212355
**Date:** 2026-03-02
**Stats:** ~260 points, ~240 comments
**Project:** [memento](https://github.com/mandel-macaque/memento) — git-notes-based AI session archival
**Submitted by:** mandel_x

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

---

# Thread 2: "Parallel coding agents with tmux and Markdown specs"

**Source:** https://news.ycombinator.com/item?id=47218318
**Blog post:** https://schipper.ai/posts/parallel-coding-agents/
**Date:** 2026-03-02
**Stats:** ~83 points, ~56 comments
**Author:** Manuel Schipper (schipperai) — works at Snowflake
**System:** Feature Designs (FDs) — Markdown specs with 8-stage lifecycle, 6 slash commands, 3 agent roles

## Executive Summary

A detailed blog post and HN discussion about running 4-8 parallel coding agents using tmux, Markdown specifications, and bash aliases. The author has built a structured SDLC workflow strikingly similar to Exarchos — with lifecycle stages, slash commands, artifact tracking, and verification steps — but entirely through manual markdown conventions and human-mediated coordination. The thread exposes the **pain points that emerge at scale** (context drift, merge conflicts, cognitive overload, token burn) that Exarchos's event-sourced approach is designed to solve.

---

## The Feature Design System (Blog Post)

The blog post describes a system built over **300+ specifications** in a single project:

**8-stage lifecycle:** Planned → Design → Open → In Progress → Pending Verification → Complete → Deferred → Closed

**6 slash commands:**
| Command | Purpose |
|---------|---------|
| `/fd-new` | Create new spec from idea dump |
| `/fd-status` | Display active/pending/completed index |
| `/fd-explore` | Bootstrap session with project context |
| `/fd-deep` | Launch 4 parallel Opus agents for design exploration |
| `/fd-verify` | Proofread code, execute verification plan, commit |
| `/fd-close` | Archive spec, update index and changelog |

**3 agent roles:** PM (backlog grooming), Planner (spec design), Worker (implementation)

**Development loop:**
```
PM: /fd-status → pick FD or /fd-new
Planner: /fd-explore → design FD → status: Open
Worker: /fd-explore → implement → /fd-verify → /fd-close
```

**Key parallel to Exarchos:** The FD lifecycle maps almost directly to Exarchos's workflow phases:

| FD Stage | Exarchos Phase |
|----------|---------------|
| Planned / Design | `/ideate` |
| Open | `/plan` (plan-review checkpoint) |
| In Progress | `/delegate` |
| Pending Verification | `/review` |
| Complete | `/synthesize` → `/cleanup` |

The critical difference: the FD system is **human-mediated** with no persistent state, no automated phase gates, and no event-sourced audit trail. The human is the orchestrator, the scheduler, and the quality gate.

---

## Key Themes

### 1. Structured Spec-Driven Workflows Are the Emerging Best Practice

The blog post's FD system is the most developed example yet of what jedberg, jumploops, and others described in Thread 1. It demonstrates that power users converge on the same pattern:

- Write specs before implementing
- Track specs through lifecycle stages
- Commit specs alongside code
- Use specs as context bootstrap for new sessions

**schipperai** on how specs survive compaction:
> "Compaction tends to work better with Workers probably because the FD has granular plan details that a newborn Worker can attend to."

**schipperai** on specs as knowledge base:
> "An emergent property of this system is that agents frequently rediscover past FDs on their own... The added context of what was considered prior helps the agents plan better, and also remind me of relevant work I may have forgotten about."

**Relevance to Exarchos:** This validates two things: (1) structured specifications are the right abstraction for agent workflows, and (2) they need to survive beyond the current session. The FD system achieves the first but not the second — specs are markdown files with no persistent state, no event sourcing, and no way to resume a partially-complete workflow beyond re-reading the file.

---

### 2. Context Drift Is the Central Scaling Problem

Multiple commenters identify context divergence across parallel agents as the #1 bottleneck:

**CloakHQ:**
> "The bottleneck wasn't the agents, it was keeping their context from drifting. Each tmux pane has its own session state, so you end up with agents that 'know' different versions of reality by the second hour."

**CloakHQ** on the solution:
> "We found we also needed a short shared 'ground truth' file the agents could read before taking any action — basically a live snapshot of what's actually done vs what the spec says."

**schipperai** on avoiding drift:
> "I avoid this with one spec = one agent, with worktrees if there is a chance of code clashing."

**briantakita** (describes his agent-doc system):
> "For context sync across agents, the key insight was: don't sync. Each agent owns one document with its own conversation history. The orchestration doc (plan.md) references feature docs but doesn't duplicate their content."

**Relevance to Exarchos:** Exarchos's approach — event-sourced state per workflow, materialized views for team coordination, worktree isolation per agent — solves this at the architecture level. The "one spec = one agent" pattern is essentially what `/delegate` does, but with persistent state tracking and convergence gates at the boundaries.

---

### 3. Compaction Kills Decisions — Checkpointing Is Essential

The blog post explicitly calls out compaction as a threat to planning quality:

**schipperai:**
> "I noticed that compaction can drop good context or even the decisions made during planning, so now I checkpoint FD progress often. This adds time to the planning cycle but results in tighter plans."

**schipperai** on why workers handle compaction better:
> "Compaction tends to work better with Workers probably because the FD has granular plan details that a newborn Worker can attend to."

The `/fd-explore` command is essentially a manual rehydrate — it bootstraps context from architecture docs, dev guide, and FD index "so the agent doesn't start from zero."

**Relevance to Exarchos:** This is precisely what `/checkpoint` and `/rehydrate` automate. The blog post describes the pain; Exarchos provides the solution. The ~2-3k token rehydrate cost vs. the manual `/fd-explore` context loading is a concrete advantage.

---

### 4. Cognitive Load of Multi-Agent Orchestration

Several commenters describe orchestration fatigue:

**ramoz** (describes a bell curve from single agent → multi-agent → back to single agent):
> "I spent a ton of time enforcing Claude to use the system I put in place including documentation updates and continuous logging of work."

**medi8r:**
> "It looks cognitively like being a pilot landing a plane *all day long*, and not what I signed up for. Where is my walk in the local park where I think through stuff and come up with a great idea?"

**schipperai** on practical limits:
> "Around 8 agents is my practical max. Past that, I lose track of what each one is doing and design decisions suffer."
> "When I have to prompt an agent to 'summarize its work' I know I need to dial it back."

**Relevance to Exarchos:** The orchestration overhead is the tax for doing this manually. Exarchos's auto-continuation between human checkpoints (only 2 approvals per workflow) is a direct answer to "landing a plane all day." The event-sourced state means you don't have to remember what each agent is doing — the system tracks it.

---

### 5. Merge Conflicts and Sequential Dependencies

**ramoz:**
> "My problem with these extensive self-orchestrated multi-agent / spec modes is the type of drift and rot of all the changes and then integrated parts of an application that a lot of the time end up in merge conflicts."

**schipperai:**
> "Not everything parallelizes. Some features have sequential dependencies. While I could force parallelism in some features with worktrees and then try and merge things, it creates merge conflicts and can lead to confusion."

**aceelric** (describes a supervisor pattern):
> "If it sees that workers can collide it spawns them in worktrees while it handles the merging and cherry-picking."

**schipperai** (on reliability of merge agents):
> "Do you find the merging agent to be reliable? I had a few bad merges in the past that makes me nervous."

**aceelric:**
> "Opus 4.6 is great at this compared to other models."

**Relevance to Exarchos:** Exarchos's worktree isolation per delegate task + stacked PR workflow (`/synthesize`) addresses this directly. Each teammate works in an isolated worktree; merging happens through the PR process, not agent-driven cherry-picking.

---

### 6. Token Cost Is Prohibitive at Scale

**hinkley:**
> "These setups pretty much require the top tier subscription, right?"

**0x457:**
> "Even Claude Max x1 if you run 2 agents with Opus in parallel you're going hit limits."

**ecliptik:**
> "The parallel agents burn through tokens extremely quickly and hit Max plan limits in under an hour."

**Relevance to Exarchos:** Token efficiency isn't just a nice-to-have — it's a prerequisite for multi-agent workflows to be economically viable. Exarchos's field-projected state queries (90% reduction), diff-based review, and ~2-3k token rehydrate are material cost savings when running at scale.

---

### 7. Verification Is Still Manual and Ad-Hoc

**schipperai** on `/fd-verify`:
> "I didn't feel the need to have a separate window / agent for reviewing. The same Worker can review its own code."

**kledru** (pushes back):
> "I am currently quite impressed with a dedicated verifier that has large degree of freedom (very simple prompt)."

**kledru** (on review workflow):
> "Github issues used by implementer and reviewer for back-and-forth."

**Relevance to Exarchos:** The debate about self-review vs. dedicated review mirrors Exarchos's design choice: two-stage review (spec compliance + code quality) by the orchestrator, not the implementer. Deterministic verification scripts (not LLM judgment) for quality gates.

---

### 8. Dev Guides Evolve to Manage Agent "Taste"

**schipperai** on growing CLAUDE.md:
> Agents "lack taste and good judgement" — "mortally terrified of errors, often duplicate code, leave dead code behind, or fail to reuse existing working patterns."

Solution: split CLAUDE.md into `docs/dev_guide/` with summary-on-start and deep-dive-on-demand.

**Relevance to Exarchos:** This mirrors Exarchos's architecture: safety rules in `rules/*.md` (always loaded), domain knowledge in `skills/*/references/` (loaded on demand). The pattern is the same — the dev guide IS the rules/references split.

---

## Tooling Landscape (Thread 2)

| Tool | Author | Description |
|------|--------|-------------|
| **Feature Designs (FDs)** | schipperai | Markdown spec system with 8-stage lifecycle, 6 slash commands |
| **agent-doc** | briantakita | Document-scoped agent coordination with snapshot diffs, tmux routing |
| **plannotator** | ramoz | Plan mode review hook for Claude Code |
| **CAS** | aceelric | Factory-mode supervisor with automatic worktree spawning and merge handling |
| **fluxland** | ecliptik | Wayland compositor built entirely with agent teams |
| **Claude Code Teams** | Anthropic | Built-in multi-agent orchestration (env var activated) |

---

## Notable Quotes for Marketing Use (Thread 2)

> "Compaction can drop good context or even the decisions made during planning, so now I checkpoint FD progress often." — schipperai

> "The bottleneck wasn't the agents, it was keeping their context from drifting." — CloakHQ

> "For context sync across agents, the key insight was: don't sync." — briantakita

> "It looks cognitively like being a pilot landing a plane all day long." — medi8r

> "Around 8 agents is my practical max. Past that, I lose track of what each one is doing." — schipperai

> "I spent a ton of time enforcing Claude to use the system I put in place." — ramoz

> "An emergent property of this system is that agents frequently rediscover past FDs on their own." — schipperai

> "The parallel agents burn through tokens extremely quickly and hit Max plan limits in under an hour." — ecliptik

---

## Commenters of Interest (Thread 2)

| Username | Signal | Why |
|----------|--------|-----|
| schipperai | FD system author, Snowflake engineer | Built the most developed manual workflow system; describes exact pain points Exarchos solves |
| CloakHQ | Context drift in multi-agent | Articulates the central scaling problem clearly |
| briantakita | agent-doc builder | "Don't sync, own" model; backs up Exarchos's one-task-per-agent approach |
| ramoz | Bell curve from single→multi→single agent | Validates orchestration fatigue; shows the failure mode Exarchos avoids |
| aceelric | CAS supervisor pattern | Describes automated worktree spawning + merge — closest to Exarchos's delegate model |
| medi8r | Cognitive load | "Landing a plane all day" — memorable framing for the manual overhead problem |
| sluongng | Multi-agent reliability timeline | Predicts reliable multi-agent by mid-to-end 2026; validates that tooling matters now |
| kledru | Dedicated reviewer advocate | Validates Exarchos's two-stage review with separate reviewer |
| ecliptik | Token burn reality | Concrete data on Max plan limits hit in under an hour |
| linsomniac | Diverse project portfolio | Demonstrates breadth of agent-team use cases |

---

## Combined Competitive Positioning Matrix

| Feature | memento | FD System | agent-doc | CAS | plannotator | Exarchos |
|---------|---------|-----------|-----------|-----|-------------|----------|
| Structured spec lifecycle | No | Yes (8 stages) | Partial | Yes | No | Yes (HSM phases) |
| Persistent state | No | No (files only) | No | Unclear | No | Yes (event-sourced) |
| Checkpoint / resume | No | Manual (re-read FD) | No | Unclear | No | Yes (`/rehydrate`) |
| Multi-agent coordination | No | Manual (tmux) | Manual (tmux) | Automated | No | Automated (`/delegate`) |
| Quality gates | No | `/fd-verify` (manual) | No | Unclear | Plan review only | 5-dimension convergence |
| Token efficiency | N/A | Manual context loading | Snapshot diffs | Unclear | N/A | Field projection, diff review |
| Audit trail | git notes | FD commit messages | No | Unclear | No | Event-sourced log |
| Worktree isolation | No | Manual | No | Yes (auto) | No | Yes (auto via `/delegate`) |
| Human checkpoints | N/A | Continuous oversight | Continuous | Unclear | Plan review | 2 only (design + merge) |

---

## Combined Market Signals (Both Threads)

### Validated Demand
1. **Plan-file workflows** — Thread 1 shows independent invention; Thread 2 shows a mature 300+ spec implementation
2. **Structured artifact preservation** — Consensus across both threads that specs belong alongside code
3. **Context recovery** — Both threads identify compaction as a workflow killer; schipperai explicitly checkpoints to mitigate
4. **Multi-agent coordination** — Thread 2 reveals scaling challenges (drift, merge conflicts, cognitive load) that manual approaches can't solve
5. **Token efficiency** — Thread 2 shows token burn as a practical constraint that limits multi-agent viability

### Differentiation Opportunities
1. **Automated orchestration** — Most systems are human-mediated; Exarchos auto-continues between checkpoints
2. **Event-sourced persistence** — No competitor persists state across sessions; FD system is file-only
3. **Token-efficient rehydrate** — ~2-3k tokens vs. manual `/fd-explore` context loading
4. **Convergence gates** — No competitor verifies quality dimensions; `/fd-verify` is manual and self-reviewing
5. **Reduced cognitive load** — 2 checkpoints vs. "landing a plane all day"

### Messaging Angles (Updated)
1. **"Your plan.md workflow, systematized"** — target jedberg/jumploops/schipperai cohort
2. **"300+ specs later, you'll wish it persisted"** — speak to the FD system's scaling limit
3. **"2 checkpoints, not 8 tmux panes"** — cognitive load reduction angle
4. **"Rehydrate in 2-3k tokens, not re-explain in 20k"** — token efficiency for resumption
5. **"Quality gates that aren't self-review"** — verification angle vs. `/fd-verify` self-check

---

*Captured 2026-03-02 for lvlup-sw market research. Updated with Thread 2 analysis.*
