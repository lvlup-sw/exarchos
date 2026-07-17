# Design: VitePress Documentation Site

**Feature ID:** `vitepress-docs`
**Date:** 2026-03-08
**Status:** Draft

## Problem

Exarchos v2.5.0 is the first public release. The project has 195+ internal documents (designs, plans, ADRs) but no user-facing documentation site. The README covers the basics, but developers evaluating or adopting Exarchos need structured documentation they can browse, search, and reference.

## Goals

- Ship a comprehensive VitePress documentation site at `lvlup-sw.github.io/exarchos/`
- Follow the same VitePress patterns as Strategos (`../strategos/docs/`)
- Use the voice and messaging from the Basileus marketing materials (`../basileus/docs/market/exarchos/`)
- Target developers as the primary audience — direct, technical, no hype
- Surface architectural rationale and diagrams from internal docs (reworked for public consumption)

## Non-Goals

- Custom Vue components or theme modifications (use VitePress default theme)
- Automated API doc generation (manual markdown for now)
- Blog or changelog section (can add later)
- Migrating all 195+ internal docs — only curated, reworked content

## Directory Structure

```
documentation/                    # Separate from internal docs/
├── .vitepress/
│   └── config.ts                 # VitePress configuration
├── public/
│   ├── logo.svg                  # Exarchos logo (copy from root)
│   └── architecture.svg          # Architecture diagram (copy from docs/assets/)
├── index.md                      # Landing page (hero + features)
├── package.json                  # VitePress dev dependency
├── learn/
│   ├── index.md                  # Why Exarchos
│   ├── core-concepts.md          # Workflows, phases, events, state
│   ├── how-it-works.md           # Event sourcing, MCP server, state machine
│   └── comparison.md             # vs. Superpowers, Task Master, manual workflows
├── guide/
│   ├── index.md                  # Getting started overview
│   ├── installation.md           # Marketplace install + dev setup
│   ├── first-workflow.md         # Walk through a feature workflow end-to-end
│   ├── feature-workflow.md       # Feature: ideate → plan → delegate → review → synthesize
│   ├── debug-workflow.md         # Debug: triage → investigate → fix → validate
│   ├── refactor-workflow.md      # Refactor: assess → brief → implement → validate
│   ├── checkpoint-resume.md      # Checkpoint, rehydrate, reload
│   ├── agent-teams.md            # Implementer, fixer, reviewer — dispatch and coordination
│   └── review-process.md         # Two-stage review: spec compliance + code quality
├── reference/
│   ├── index.md                  # Reference overview
│   ├── commands.md               # All 15 slash commands with usage
│   ├── tools/
│   │   ├── index.md              # MCP tools overview (4 composite + describe pattern)
│   │   ├── workflow.md           # exarchos_workflow: init, get, set, cancel, cleanup, reconcile
│   │   ├── event.md              # exarchos_event: append, query, batch
│   │   ├── orchestrate.md        # exarchos_orchestrate: dispatch, review, scripts, runbooks, specs
│   │   └── view.md               # exarchos_view: pipeline, taskboard, stack health
│   ├── skills.md                 # Skill system: frontmatter, references, metadata
│   ├── agents.md                 # Agent specs: implementer, fixer, reviewer
│   ├── scripts.md                # Validation scripts: conventions, exit codes, co-located tests
│   ├── events.md                 # Event types reference (59+ event types)
│   ├── configuration.md          # Settings, hooks, plugin structure
│   └── convergence-gates.md      # D1-D5 quality dimensions explained
├── architecture/
│   ├── index.md                  # Architecture overview with diagrams
│   ├── event-sourcing.md         # Event store design, append-only log, reconciliation
│   ├── state-machine.md          # HSM phases, transitions, guards
│   ├── token-efficiency.md       # Lazy schema, field projection, artifact references
│   ├── agent-model.md            # Typed agents, worktree isolation, runbook protocol
│   └── design-rationale.md       # Reworked ADRs: why these choices were made
└── examples/
    ├── index.md                  # Examples overview
    ├── feature-development.md    # End-to-end: design a feature through to merged PR
    ├── bug-investigation.md      # Debug workflow: triage through validated fix
    ├── code-refactor.md          # Refactor workflow: assess through validated improvement
    ├── agent-delegation.md       # Multi-agent: dispatch tasks, manage worktrees, merge results
    └── session-recovery.md       # Checkpoint mid-task, close laptop, rehydrate next day
```

## VitePress Configuration

Based on the Strategos pattern (`../strategos/docs/.vitepress/config.ts`):

```typescript
import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Exarchos',
  description: 'Durable SDLC workflows for Claude Code — checkpoint any task, resume where you left off',

  // GitHub Pages project site
  base: '/exarchos/',

  // No srcExclude needed — documentation/ only contains public content
  ignoreDeadLinks: true, // During initial build, resolve as content is added

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/exarchos/logo.svg' }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Learn', link: '/learn/' },
      { text: 'Guide', link: '/guide/' },
      { text: 'Reference', link: '/reference/' },
      { text: 'Architecture', link: '/architecture/' },
      { text: 'Examples', link: '/examples/' },
    ],

    sidebar: {
      '/learn/': [
        {
          text: 'Learn',
          items: [
            { text: 'Why Exarchos', link: '/learn/' },
            { text: 'Core Concepts', link: '/learn/core-concepts' },
            { text: 'How It Works', link: '/learn/how-it-works' },
            { text: 'Comparison', link: '/learn/comparison' },
          ],
        },
      ],
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Overview', link: '/guide/' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'First Workflow', link: '/guide/first-workflow' },
          ],
        },
        {
          text: 'Workflows',
          items: [
            { text: 'Feature Development', link: '/guide/feature-workflow' },
            { text: 'Debugging', link: '/guide/debug-workflow' },
            { text: 'Refactoring', link: '/guide/refactor-workflow' },
          ],
        },
        {
          text: 'Key Capabilities',
          items: [
            { text: 'Checkpoint & Resume', link: '/guide/checkpoint-resume' },
            { text: 'Agent Teams', link: '/guide/agent-teams' },
            { text: 'Review Process', link: '/guide/review-process' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Overview', link: '/reference/' },
            { text: 'Commands', link: '/reference/commands' },
            { text: 'Skills', link: '/reference/skills' },
            { text: 'Agents', link: '/reference/agents' },
            { text: 'Scripts', link: '/reference/scripts' },
            { text: 'Events', link: '/reference/events' },
            { text: 'Configuration', link: '/reference/configuration' },
            { text: 'Convergence Gates', link: '/reference/convergence-gates' },
          ],
        },
        {
          text: 'MCP Tools',
          items: [
            { text: 'Tools Overview', link: '/reference/tools/' },
            { text: 'Workflow', link: '/reference/tools/workflow' },
            { text: 'Event', link: '/reference/tools/event' },
            { text: 'Orchestrate', link: '/reference/tools/orchestrate' },
            { text: 'View', link: '/reference/tools/view' },
          ],
        },
      ],
      '/architecture/': [
        {
          text: 'Architecture',
          items: [
            { text: 'Overview', link: '/architecture/' },
            { text: 'Event Sourcing', link: '/architecture/event-sourcing' },
            { text: 'State Machine', link: '/architecture/state-machine' },
            { text: 'Token Efficiency', link: '/architecture/token-efficiency' },
            { text: 'Agent Model', link: '/architecture/agent-model' },
            { text: 'Design Rationale', link: '/architecture/design-rationale' },
          ],
        },
      ],
      '/examples/': [
        {
          text: 'Examples',
          items: [
            { text: 'Overview', link: '/examples/' },
            { text: 'Feature Development', link: '/examples/feature-development' },
            { text: 'Bug Investigation', link: '/examples/bug-investigation' },
            { text: 'Code Refactor', link: '/examples/code-refactor' },
            { text: 'Agent Delegation', link: '/examples/agent-delegation' },
            { text: 'Session Recovery', link: '/examples/session-recovery' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/lvlup-sw/exarchos' },
    ],

    editLink: {
      pattern: 'https://github.com/lvlup-sw/exarchos/edit/main/documentation/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the Apache-2.0 License.',
      copyright: 'Copyright (c) lvlup-sw',
    },
  },
})
```

## Landing Page

The homepage uses VitePress `layout: home` with hero and features grid. Messaging draws from the Basileus copy templates:

- **Hero name:** Exarchos
- **Hero text:** Durable SDLC Workflows for Claude Code
- **Tagline:** Checkpoint any task. Resume where you left off. Ship with confidence.
- **Primary CTA:** Get Started → `/guide/`
- **Secondary CTA:** Why Exarchos? → `/learn/`

**Features grid (4 cards):**

| Title | Details |
|-------|---------|
| Checkpoint & Resume | Context compaction wipes your session. `/rehydrate` restores it in ~2-3k tokens. Your workflow picks up where it left off. |
| Structured Workflows | Design, plan, implement, review, ship. Phase gates between each step catch drift before it reaches your codebase. |
| Agent Teams | Implementer, fixer, reviewer. Each runs in an isolated worktree with scoped tools and verification hooks. |
| Audit Trail | Every transition, gate result, and agent action goes into an append-only event log. Trace what happened when things break. |

## Content Sources

Content comes from three sources, with different treatment:

### 1. New content (written fresh)

Most pages need to be written from scratch for a public audience:
- All Learn section pages
- All Guide section pages
- All Examples (narrative walkthroughs, not internal test output)
- Reference overview pages

### 2. Adapted from README

The README already has solid public-facing copy that can be extracted:
- Installation instructions → `guide/installation.md`
- "What you get" section → feeds into Learn and Guide pages
- Architecture section → seeds `architecture/index.md`
- Workflows table → seeds `reference/commands.md`
- Integrations table → `reference/configuration.md`

### 3. Reworked from internal docs

Internal docs provide raw material that needs rewriting for public consumption:
- `docs/assets/architecture.svg` → `documentation/public/architecture.svg` (copy directly)
- `docs/adrs/` → Rework into `architecture/design-rationale.md` (consolidate, remove internal context)
- Event type definitions from MCP server source → `reference/events.md`
- Skill frontmatter schemas → `reference/skills.md`
- Agent specs from `agents/` → `reference/agents.md`
- Convergence gate dimensions → `reference/convergence-gates.md`

## Writing Guidelines

All documentation content must follow these guidelines:

### Voice and Tone

From the Basileus marketing context — developer-to-developer conversation:
- Direct and technical, no marketing hype
- Lead with concrete capabilities, not promises
- Acknowledge trade-offs honestly
- Problem-first narrative where applicable
- Quantified over abstract ("~2-3k tokens" not "efficient recovery")

### Controlled Vocabulary (Tier 1)

Always use these terms consistently:
- Structured workflows (not "governance" or "enforcement")
- Checkpoint / rehydrate (not "save/restore")
- Token-efficient (not "lightweight")
- Artifact references (not "inlining")
- Durable workflows (not "persistent state")
- Convergence gates (not "quality checks")
- Audit trail (not "logging")
- Agent teams (not "multi-agent")

### Terms to Avoid as Lead Terms

- CMDP / HSM (academic jargon — explain if needed, don't lead with)
- D1-D5 (use explicit dimension names)
- "Governance" (use "structure")
- "Enforcement" (use "verification")
- Superlatives / hype language

### Humanize

All documentation must pass the `/humanize` skill review before finalizing. Key patterns to avoid:
- Inflated symbolism and promotional language
- Superficial analyses and vague attributions
- Em dash overuse and rule-of-three constructions
- AI vocabulary words and negative parallelisms
- Excessive conjunctive phrases

Write like one developer explaining something to another over a screen share. Short sentences. Concrete examples. Skip the throat-clearing.

## Build and Deploy

### Package setup

`documentation/package.json`:
```json
{
  "name": "exarchos-docs",
  "private": true,
  "type": "module",
  "scripts": {
    "docs:dev": "vitepress dev",
    "docs:build": "vitepress build",
    "docs:preview": "vitepress preview"
  },
  "devDependencies": {
    "vitepress": "^1.5.0"
  }
}
```

### GitHub Pages deployment

Add a GitHub Actions workflow (`.github/workflows/docs.yml`) triggered on pushes to `main` that affect `documentation/**`. Steps:
1. Checkout
2. Setup Node 20
3. `cd documentation && npm install && npm run docs:build`
4. Deploy `.vitepress/dist/` to GitHub Pages

### Root package.json integration

Add convenience scripts to the root `package.json`:
```json
{
  "docs:dev": "cd documentation && npm run docs:dev",
  "docs:build": "cd documentation && npm run docs:build",
  "docs:preview": "cd documentation && npm run docs:preview"
}
```

## Content Outline by Page

### Learn Section

**Why Exarchos** (`learn/index.md`)
- The problem: context compaction, workflow drift, no audit trail
- What developers already do (plan.md workflows)
- What Exarchos adds: persistence, verification, coordination
- Two human checkpoints: design approval and merge approval

**Core Concepts** (`learn/core-concepts.md`)
- Workflows: feature, debug, refactor
- Phases and transitions
- Events and state
- Convergence gates (5 dimensions)
- Artifact references vs. inlining
- Agent roles

**How It Works** (`learn/how-it-works.md`)
- MCP server as state backend
- Event-sourced append-only log
- State machine enforcing phase transitions
- Lazy schema registration
- Field projection for token efficiency
- Lifecycle hooks for automation

**Comparison** (`learn/comparison.md`)
- Table: Exarchos vs. Obra Superpowers vs. Claude Task Master vs. manual workflows
- Honest assessment: what Exarchos is good at, where it has trade-offs
- Complementary tools (Serena, Context7, Microsoft Learn)

### Guide Section

**Overview** (`guide/index.md`)
- What you can build with Exarchos
- Prerequisites (Claude Code, Node 20+)
- Reading paths: quickstart, workflow deep-dives, capabilities

**Installation** (`guide/installation.md`)
- Marketplace install (primary)
- Dev companion (optional)
- Development setup (clone + build)
- Verifying installation

**First Workflow** (`guide/first-workflow.md`)
- Walk through `/ideate` on a small feature
- Each phase explained as it happens
- What to expect at each checkpoint
- The full cycle: design → plan → implement → review → ship

**Feature Workflow** (`guide/feature-workflow.md`)
- Ideation: design exploration, approach selection
- Planning: TDD implementation plan, task breakdown
- Delegation: agent dispatch, worktree isolation
- Review: two-stage verification
- Synthesis: PR creation, shepherd to merge

**Debug Workflow** (`guide/debug-workflow.md`)
- Triage: identify the issue
- Investigation: root cause analysis
- Fix: hotfix track vs. thorough track
- Validation: verify the fix

**Refactor Workflow** (`guide/refactor-workflow.md`)
- Assessment: scope and impact
- Brief: what changes and why
- Implementation: polish track vs. overhaul track
- Validation: verify no regressions

**Checkpoint & Resume** (`guide/checkpoint-resume.md`)
- When context compaction happens
- `/checkpoint`: what gets saved
- `/rehydrate`: what gets restored (~2-3k tokens)
- `/reload`: lighter-weight context recovery
- `/autocompact`: proactive compaction management

**Agent Teams** (`guide/agent-teams.md`)
- Three roles: implementer, fixer, reviewer
- Worktree isolation: why and how
- Dispatch and coordination via `/delegate`
- Runbook protocol: machine-readable step sequences
- Fixer recovery: resuming failed tasks with full context

**Review Process** (`guide/review-process.md`)
- Stage 1: spec compliance (does it match the design?)
- Stage 2: code quality (is it well-written?)
- Verification scripts: deterministic checks, not vibes
- Convergence gates: the 5 quality dimensions

### Reference Section

**Overview** (`reference/index.md`)
- How to use this reference
- MCP tool architecture (4 composite tools + describe pattern)
- Quick links to each subsection

**Commands** (`reference/commands.md`)
- All 15 commands with: syntax, description, when to use, options
- Grouped by purpose: workflow start, lifecycle, context management

**MCP Tools** (`reference/tools/`)
- Overview: composite tool pattern, discriminated unions, lazy schema
- Per-tool pages: every action with parameters, return types, examples
- Describe pattern: how agents discover schemas on demand

**Skills** (`reference/skills.md`)
- Skill anatomy: SKILL.md, frontmatter, references/
- Frontmatter schema: name, description, metadata
- MCP server dependency declaration
- List of all 11 production skills

**Agents** (`reference/agents.md`)
- Agent spec format
- Per-agent: role, tools, hooks, constraints
- How specs are served via `exarchos_orchestrate`

**Scripts** (`reference/scripts.md`)
- Validation script conventions
- Exit codes: 0 (pass), 1 (fail), 2 (skip)
- Co-located tests (`.test.sh`)
- Script resolution: plugin root → ~/.claude/scripts/

**Events** (`reference/events.md`)
- Event store model
- Event categories and types (59+)
- Event schema: timestamp, type, payload
- Querying events

**Configuration** (`reference/configuration.md`)
- Plugin settings (settings.json)
- Lifecycle hooks
- Integrations: Serena, Context7, Microsoft Learn

**Convergence Gates** (`reference/convergence-gates.md`)
- The 5 dimensions explained with concrete criteria
- How gates are evaluated
- Gate results and their effect on workflow progression

### Architecture Section

**Overview** (`architecture/index.md`)
- Architecture diagram (SVG)
- System components and how they connect
- Design principles: agent-first, event-sourced, token-efficient

**Event Sourcing** (`architecture/event-sourcing.md`)
- Why event sourcing for agent workflows
- Append-only log design
- State reconstruction via reconciliation
- Trade-offs vs. mutable state

**State Machine** (`architecture/state-machine.md`)
- Hierarchical state machine (HSM) model
- Phase transitions and guards
- How the state machine enforces workflow discipline

**Token Efficiency** (`architecture/token-efficiency.md`)
- Problem: LLM context windows are finite and expensive
- Lazy schema registration (<500 tokens at startup)
- Field projection (90% reduction on state queries)
- Artifact references (design docs, plans referenced not inlined)
- Diff-based review (97% reduction vs. full files)

**Agent Model** (`architecture/agent-model.md`)
- Typed agents vs. generic prompting
- Worktree isolation model
- Runbook protocol: machine-readable orchestration
- Hook system: pre/post tool execution
- Task lifecycle and failure recovery

**Design Rationale** (`architecture/design-rationale.md`)
- Reworked from internal ADRs
- Key decisions: why MCP over markdown, why event sourcing, why typed agents
- Trade-offs acknowledged: learning curve, Claude Code only, MCP overhead

### Examples Section

**Overview** (`examples/index.md`)
- What the examples demonstrate
- How to follow along

**Feature Development** (`examples/feature-development.md`)
- Annotated walkthrough: building a real feature from `/ideate` to merged PR
- Shows actual command output, state transitions, agent interactions

**Bug Investigation** (`examples/bug-investigation.md`)
- Annotated walkthrough: triaging and fixing a real bug
- Hotfix vs. thorough track decision

**Code Refactor** (`examples/code-refactor.md`)
- Annotated walkthrough: improving existing code
- Polish vs. overhaul track

**Agent Delegation** (`examples/agent-delegation.md`)
- Multi-agent scenario: dispatching tasks, parallel work, merge coordination
- Worktree lifecycle

**Session Recovery** (`examples/session-recovery.md`)
- Checkpoint mid-feature, close session
- Rehydrate next day, continue where you left off
- Shows the ~2-3k token restoration

## Implementation Notes

### Task Breakdown

The implementation naturally splits into parallelizable work:

1. **Scaffold** — Create `documentation/` directory, VitePress config, package.json, landing page, GitHub Actions workflow
2. **Learn section** — 4 pages, independent of other sections
3. **Guide section** — 9 pages, depends on Learn for cross-references
4. **Reference section** — 12 pages (including tools/), largely independent, draws from source code
5. **Architecture section** — 6 pages, draws from internal ADRs and assets
6. **Examples section** — 6 pages, depends on Guide for cross-references
7. **Root integration** — Add scripts to root package.json, update README with docs link

### Content Dependencies

```
Scaffold ─────────────────────────────────────┐
    │                                         │
    ├── Learn (4 pages)                       │
    │     │                                   │
    │     ├── Guide (9 pages) ────────────────┤
    │     │                                   │
    │     └── Examples (6 pages)              │
    │                                         │
    ├── Reference (12 pages) ─────────────────┤
    │                                         │
    └── Architecture (6 pages) ───────────────┘
                                              │
                                    Root integration
```

Learn, Reference, and Architecture can be written in parallel after scaffold. Guide depends on Learn. Examples depend on Guide.

### Estimated Page Count

37 markdown pages + config + package.json + GitHub Actions workflow = ~40 files total.
