# Implementation Plan: Marketplace Positioning

## Source Design
Link: `docs/designs/2026-03-01-marketplace-positioning.md`

## Scope
**Target:** Full design — all seven requirements (DR-1 through DR-7)
**Excluded:** Google Ads campaign setup (runtime operation, not code); Basileus README section deferred until Basileus has a public URL

## Summary
- Total tasks: 5
- Parallel groups: 2
- Estimated test count: 0 (content/documentation feature — validation via scripts, not unit tests)
- Design coverage: 7 of 7 requirements covered

## TDD Exemption

This is a content/documentation feature. The deliverables are:
- Edited Markdown files (README.md)
- Edited JSON metadata (package.json, plugin.json, marketplace.json)
- New documentation files (marketing copy, competitive analysis)

No production TypeScript code is created or modified. TDD RED/GREEN/REFACTOR phases do not apply. Validation is via:
- `npm run validate` (plugin structure)
- Manual review of character limits (ads, social copy)
- `wc -w` word counts on new content

## Spec Traceability

| Requirement | Task(s) | Deliverable |
|:------------|:--------|:------------|
| DR-1: Positioning statement | Task 1 (README header), Task 3 (marketing doc) | README scan layer, marketing doc header |
| DR-2: Key terms vocabulary | Task 1 (README body), Task 2 (metadata keywords) | README value props, JSON keywords |
| DR-3: README restructure | Task 1 | README.md |
| DR-4: Social/ad copy | Task 3 | `docs/marketing/copy-templates.md` |
| DR-5: Competitive landscape | Task 4 | `docs/marketing/competitive-analysis.md` |
| DR-6: Basileus funnel | Task 1 (README section) | README "Scaling Up" section |
| DR-7: Positioning risks | Task 4 (competitive doc) | Included in competitive analysis doc |

## Task Breakdown

### Task 1: Restructure README.md
**Implements:** DR-1, DR-2, DR-3, DR-6

Apply the three-layer README restructure from the design document:

1. **Scan layer** — Replace the current header block:
   - Tagline: "Structure for agentic development"
   - Subtitle: "Durable SDLC workflows · Convergence gates · Agent teams · Audit trail"
   - Remove "Graphite stacked PRs" reference (removed in v2.2.0, #933)
   - Remove "Event-sourced state" from subtitle (moved to body)

2. **Skim layer** — Replace the current "Why Exarchos?" section with the new version from the design doc (6 bullet points using controlled vocabulary terms)

3. **Read layer** — Align existing sections with new vocabulary:
   - "Graphite stacked PRs" bullet → replace with "GitHub-native stacked PRs" or remove if already handled
   - Update any remaining references to "Graphite" in workflow diagrams/tables
   - Ensure Prerequisites section removes Graphite CLI requirement if still present
   - Update "How It Works" section labels to use Tier 1 terms where natural

4. **Basileus section** — Add "Scaling Up" section before "Build & Test" (only if Basileus has a public URL; otherwise add as HTML comment placeholder)

**Files:** `README.md`
**Dependencies:** None
**Parallelizable:** No (single file, must be one coherent edit)

---

### Task 2: Update metadata files
**Implements:** DR-2

Update description and keywords across all three metadata files to align with the controlled vocabulary.

1. **package.json** — Update `description` to: `"Structure for agentic development — durable SDLC workflows, convergence gates, agent teams, and audit trails for Claude Code"`
   - Update `keywords` to: `["claude-code-plugin", "sdlc", "workflow", "agent-teams", "event-sourcing", "code-review", "quality-gates", "tdd", "durable-workflows", "audit-trail"]`

2. **plugin.json** — Update `description` to: `"Structure for agentic development — durable SDLC workflows with convergence gates, agent teams, and full audit trail."`
   - Update `keywords` to: `["workflow", "sdlc", "event-sourcing", "quality-gates", "agent-teams", "durable-workflows", "audit-trail", "code-review"]`

3. **marketplace.json** — Update plugin `description` to: `"Durable SDLC workflows with convergence gates, agent teams, and audit trail"`
   - Update `tags` to: `["workflow", "sdlc", "quality-gates", "agent-teams", "durable-workflows"]`
   - Update marketplace `metadata.description` to: `"Structure for agentic development — SDLC workflow plugins for Claude Code"`

4. **Validate** — Run `npm run validate` to confirm plugin structure is still valid

**Files:** `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
**Dependencies:** None
**Parallelizable:** Yes (independent from Task 1)

---

### Task 3: Create marketing copy document
**Implements:** DR-4

Create `docs/marketing/copy-templates.md` containing all social media and ad copy templates from the design document.

**Structure:**
```
# Exarchos Marketing Copy Templates

## Positioning Statement
[CVFB statement from design]

## Tagline Candidates
[Ranked list from design]

## Twitter/X Templates
[3 templates: pain-led, differentiation-led, outcome-led]

## LinkedIn Templates
[2 templates: industry-trend, methodology]

## Google Ads
[Headlines + descriptions]

## Usage Guidelines
- Which terms to always use (Tier 1)
- Which terms to avoid
- Tone: direct, technical, no hype
```

**Files:** `docs/marketing/copy-templates.md` (new)
**Dependencies:** None
**Parallelizable:** Yes (independent file)

---

### Task 4: Create competitive analysis document
**Implements:** DR-5, DR-7

Create `docs/marketing/competitive-analysis.md` containing the competitive differentiation matrix, anti-positioning table, and positioning risks from the design document.

**Structure:**
```
# Exarchos Competitive Analysis

## Market Context
[Brief: 9,000+ plugins, crowded at skill layer, thin at durable governance]

## Competitive Matrix
[Table from design: Exarchos vs Superpowers vs Task Master vs Auto-Claude vs Raw Claude Code]

## Per-Competitor Assessment
[For each: what they do, where they're strong, where they're weak]

## Exarchos Weaknesses (Honest Assessment)
[Onboarding complexity, smaller community, learning curve]

## Competitive Moat
[Event-sourced durability + convergence gates + provenance chain]

## Anti-Positioning
[What Exarchos is NOT table from design]

## Positioning Risks & Mitigations
[Risk table from design]
```

**Files:** `docs/marketing/competitive-analysis.md` (new)
**Dependencies:** None
**Parallelizable:** Yes (independent file)

---

### Task 5: Validation and cross-check
**Implements:** All DRs (verification)

1. Run `npm run validate` — plugin structure valid
2. Verify README scan layer is under 20 words of prose
3. Verify Twitter templates are under 280 chars each
4. Verify Google Ads headlines are under 30 chars each
5. Verify Google Ads descriptions are under 90 chars each
6. Verify all Tier 1 terms appear in README
7. Verify no "Terms to AVOID" appear as lead terms in README
8. Cross-check: every DR acceptance criterion has a corresponding deliverable

**Files:** None (read-only verification)
**Dependencies:** Tasks 1-4
**Parallelizable:** No (must run after all content tasks complete)

## Parallelization Strategy

```
Group A (sequential):        Group B (parallel):
┌──────────────┐            ┌──────────────────┐
│  Task 1      │            │  Task 2          │
│  README.md   │            │  Metadata files  │
└──────────────┘            └──────────────────┘
                            ┌──────────────────┐
                            │  Task 3          │
                            │  Marketing copy  │
                            └──────────────────┘
                            ┌──────────────────┐
                            │  Task 4          │
                            │  Competitive doc │
                            └──────────────────┘

         ── all complete ──→ Task 5 (validation)
```

Tasks 1-4 can all run in parallel (different files). Task 5 depends on all of them.

**Recommended delegation:**
- Tasks 1 + 2 can share a worktree (both edit existing files in the repo root)
- Tasks 3 + 4 can share a worktree (both create new files in `docs/marketing/`)
- Or: all four tasks in a single worktree since edits don't conflict

Given the simplicity of these tasks (content application from a detailed design doc, no code), a single teammate or direct orchestrator execution is most efficient. Spawning 4 worktrees for content edits would add more overhead than it saves.

## Deferred Items

| Item | Rationale |
|:-----|:----------|
| Google Ads campaign setup | Runtime operation (Google Ads dashboard), not a code/content task |
| Basileus README section | Deferred until Basileus has a public URL; placeholder HTML comment included |
| Visual assets (GIFs, diagrams) | Open question from design doc; requires separate design decision |
| Marketplace A/B testing | Post-deployment activity, not implementation |
| Mom Test validation | Requires external user feedback, not automatable |

## Completion Checklist
- [ ] README.md restructured (scan + skim + read layers)
- [ ] Metadata files updated (package.json, plugin.json, marketplace.json)
- [ ] Marketing copy document created
- [ ] Competitive analysis document created
- [ ] `npm run validate` passes
- [ ] Character limits verified (ads, social)
- [ ] All Tier 1 terms present in README
- [ ] No "avoid" terms used as lead terms
- [ ] All DR acceptance criteria satisfied
