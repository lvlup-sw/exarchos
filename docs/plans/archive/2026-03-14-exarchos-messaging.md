# Implementation plan: Exarchos messaging

**Design:** `docs/designs/2026-03-14-exarchos-messaging.md`
**Type:** Content (markdown only, no TypeScript)
**Tasks:** 5

Note: This is a content/copy task. No production code, no TDD. Tasks are validated by humanize pass and consistency check against the design doc's messaging principles.

---

## Task group A: Core messaging (sequential)

### Task 1: Restructure README around approved copy

**Files:**
- `README.md`

**Work:**
1. Replace the hero subtitle ("Durable SDLC workflows for Claude Code — checkpoint any task, resume where you left off") with the new positioning: "A local-first SDLC workflow harness — structured, durable state for coding agents."
2. Replace "You probably already do this" and "Your plan.md workflow, with teeth" sections with the approved Draft 4 copy (from design doc)
3. Update "What you get" section — replace "Verification scripts, not vibes" with "Deterministic convergence gates run as TypeScript checks" language
4. Update install section to mention standalone MCP server with CLI adapter alongside the plugin install
5. Run humanize pass on full README — check against all 24 patterns

**Depends on:** None
**Parallelizable:** No (other tasks reference README as source of truth)

### Task 2: Update docs site landing page

**Files:**
- `documentation/index.md`

**Work:**
1. Update hero text from "Durable SDLC Workflows for Claude Code" to align with "local-first SDLC workflow harness" positioning
2. Update tagline to match README
3. Revise feature cards to use approved terminology (structured durable state, deterministic convergence gates, etc.)
4. Humanize pass on all feature card copy

**Depends on:** Task 1
**Parallelizable:** No

### Task 3: Update "Why Exarchos" page

**Files:**
- `documentation/learn/index.md`

**Work:**
1. Rewrite opening section — lead with what developers already do (plan files, CLAUDE.md, deliberate /clear), not what happens to them
2. Replace "What the manual approach is missing" — frame as the gap between manual process and enforcement, per design doc
3. Update "What Exarchos adds" — use "local-first SDLC workflow harness" category, "structured durable state" mechanism, "deterministic convergence gates" for verification
4. Replace "verification scripts" with accurate description (TypeScript checks against diff and git history)
5. Humanize pass — especially watch for rule-of-three in bullet lists and promotional language

**Depends on:** Task 1
**Parallelizable:** Yes (parallel with Task 2)

---

## Task group B: Distribution and campaign (parallel after group A)

### Task 4: Update marketplace metadata

**Files:**
- `.claude-plugin/plugin.json` (description field)
- `manifest.json` (if description exists)

**Work:**
1. Update plugin.json description to align with positioning
2. Ensure manifest.json keywords reflect new messaging terms
3. Keep descriptions under marketplace character limits

**Depends on:** Task 1
**Parallelizable:** Yes

### Task 5: Create copy templates

**Files:**
- `docs/market/copy-templates.md` (new file — in exarchos repo, not basileus)

**Work:**
1. Write short-form copy variants: one-liner, two-liner, paragraph
2. Twitter/X templates (5)
3. HN Show/Launch post draft
4. Controlled vocabulary list (terms to use, terms to avoid)
5. Humanize pass on all templates

**Depends on:** Task 1
**Parallelizable:** Yes (parallel with Task 4)

---

## Execution order

```
Task 1 (README) ──→ Task 2 (docs landing)
                ├──→ Task 3 (why exarchos)   ← parallel with Task 2
                ├──→ Task 4 (marketplace)    ← parallel
                └──→ Task 5 (copy templates) ← parallel
```

## Validation

Each task validated by:
1. Consistency with design doc messaging principles (6 principles from design)
2. Humanize skill pass (24 AI writing patterns)
3. No "governance", "missing layer", "seamless", "groundbreaking", or other flagged terms in user-facing copy
