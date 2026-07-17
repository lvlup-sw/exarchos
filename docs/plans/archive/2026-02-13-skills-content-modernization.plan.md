# Implementation Plan: Skills Content Modernization

## Source Design
Link: `docs/designs/2026-02-13-skills-content-modernization.md`

## Stack Target

**Parent branch:** `feat/progressive-disclosure/d3-prompt-migration`

This plan stacks on top of the progressive-disclosure-hooks PR stack. The d3-prompt-migration branch has already migrated all 34 content files (12 skills, 7 commands, 3 rules) from individual tool names (`exarchos_workflow_init`) to the composite tool pattern (`exarchos_workflow` with `action: "init"`). Our changes build on those migrated files.

**Stack position:**
```
main
  └─► ... (hooks stack: registry, composites, CLI, hooks, gates)
        └─► d2-generate-docs (PR #192 — generate-docs.ts script)
              └─► d3-prompt-migration (tool name migration across 34 .md files)
                    └─► [OUR WORK] skills-content-mod/001..007
```

**Prerequisite:** d3-prompt-migration must be submitted to Graphite and tracked in the stack before our branches are created. Use `gt track` if needed.

## Scope

**Target:** Phase 1 content changes + generate-docs integration (design §1-§5.1)
**Excluded:**
- §5.2 Per-skill tool manifests — nice-to-have, not critical for Phase 1
- §5.3 Skill-aware SubagentStart hook — requires CLI changes beyond content scope
- §6 Validation scripts (pre-dispatch.sh, pre-submit.sh) — separate concern from content modernization

## Summary
- Total tasks: 9
- Parallel groups: 3 (5 parallel tasks after foundation, integration, then context optimization)
- Estimated test count: 18 (6 validation functions × 12 skills + per-skill .test.sh updates)
- Design coverage: 5 of 6 Technical Design sections (§1-§4 + §5.1 covered; §5.2-§5.3, §6 deferred)
- Context optimization: ~2.4k token reduction from rule scoping + post-hooks rule elimination

## Spec Traceability

### Scope Declaration

**Target:** YAML frontmatter, monolithic skill splitting, troubleshooting sections, validation infrastructure, generated mcp-tool-guidance.md, documentation, rule context optimization
**Excluded:** Per-skill tool manifests (§5.2), skill-aware SubagentStart hook (§5.3), validation scripts (§6)

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|---|---|---|---|
| §1 YAML Frontmatter Specification | - Frontmatter on all 12 skills<br>- name, description, metadata fields<br>- Trigger phrases in description<br>- Negative triggers where needed | 002, 003, 004, 005 | Covered |
| §2 Monolithic Skill Splitting | - quality-review → SKILL.md + references/<br>- implementation-planning → SKILL.md + references/ | 003, 004 | Covered |
| §3 Content Optimization Guidelines | - SKILL.md ≤2,000 words<br>- Reference files ≤1,000 words<br>- Total skill ≤5,000 words | 001, 003, 004 | Covered |
| §4 Error Handling & Troubleshooting | - Troubleshooting sections for delegation, synthesis, debug, workflow-state<br>- Use composite tool names | 005 | Covered |
| §5.1 Generated mcp-tool-guidance.md | - Replace hand-maintained rule with registry-generated content<br>- Preserve anti-patterns and proactive-use guidance | 006 | Covered |
| §5.2 Per-Skill Tool Manifests | - Generated references/tool-manifest.md per skill | — | Deferred: Low priority, skills already reference tools adequately |
| §5.3 Skill-Aware SubagentStart Hook | - Extend CLI to read skill frontmatter | — | Deferred: Requires CLI changes beyond content scope |
| §6 Validation Scripts | - delegation/scripts/pre-dispatch.sh<br>- synthesis/scripts/pre-submit.sh | — | Deferred: Separate concern from content modernization |
| Testing Strategy > Phase 1 | - Frontmatter validation script<br>- Word count checks<br>- Reference existence checks | 001 | Covered |
| Migration Plan > Step 6 | - Update CLAUDE.md with frontmatter convention | 007 | Covered |
| Context Optimization (addendum) | - Scope file-specific rules with `paths` frontmatter<br>- Condense phase-specific rules<br>- Migrate phase-specific rules into skill references | 008 | Covered |
| Post-Hooks Audit (addendum) | - Evaluate `mcp-tool-guidance.md` elimination<br>- Evaluate `primary-workflows.md` elimination<br>- Verify `workflow-auto-resume.md` removed by hooks<br>- Document final token budget | 009 | Covered |

### Already Completed by Hooks Stack

These design requirements are satisfied by the progressive-disclosure-hooks work already in review:

| Requirement | Completed By |
|---|---|
| Tool name migration (286 references) | d3-prompt-migration (34 files, ±236 lines) |
| Tool registry as source of truth | a1-registry-types (#183, merged) + a2-registry-data (#185, merged) |
| generate-docs.ts script | d2-generate-docs (PR #192) |
| hooks.json with 6 hook definitions | d1-hooks-installer |
| Phase guardrail CLI | c4-guard worktree |
| Quality gate CLI | c5-gates (PR #191, queued to merge) |
| SubagentStart context CLI | c6-subagent-context (PR #194) |

## Task Breakdown

### Task 001: Create frontmatter validation test infrastructure

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test script: `skills/validate-frontmatter.test.sh`
   - File: `skills/validate-frontmatter.test.sh`
   - Test cases (using fixture files):
     - `ValidFrontmatter_AllFieldsPresent_Passes` — valid SKILL.md with all fields → exit 0
     - `MissingFrontmatter_NoDelimiters_Fails` — SKILL.md without `---` → exit 1
     - `MissingName_EmptyField_Fails` — frontmatter without `name:` → exit 1
     - `MissingDescription_EmptyField_Fails` — frontmatter without `description:` → exit 1
     - `NameMismatch_WrongKebabCase_Fails` — name doesn't match folder → exit 1
     - `XmlTags_AngleBrackets_Fails` — description contains `<` or `>` → exit 1
     - `BodyTooLong_OverWordLimit_Fails` — SKILL.md body exceeds 2,000 words → exit 1
     - `ReferenceMissing_BrokenLink_Fails` — SKILL.md references a file in references/ that doesn't exist → exit 1
   - Expected failure: Script under test (`validate-frontmatter.sh`) doesn't exist yet
   - Run: `bash skills/validate-frontmatter.test.sh` — MUST FAIL

2. [GREEN] Implement validation script
   - File: `skills/validate-frontmatter.sh`
   - Functions:
     - `check_frontmatter_exists()` — verify `---` delimiters
     - `check_required_fields()` — verify `name` and `description` present
     - `check_name_matches_folder()` — verify name = parent directory name
     - `check_no_xml_tags()` — verify no `<` or `>` in frontmatter
     - `check_word_count()` — verify body ≤2,000 words
     - `check_references_exist()` — verify referenced files exist
   - Also: `validate-all-skills.sh` runner that invokes validation on all 12 skills
   - Run: `bash skills/validate-frontmatter.test.sh` — MUST PASS
   - Run: `bash skills/validate-all-skills.sh` — MUST FAIL (no skills have frontmatter yet)

3. [REFACTOR] Clean up validation output
   - Add colored output (PASS/FAIL)
   - Add summary line (X/Y skills passed)
   - Ensure portability (bash 4+, no platform-specific tools)

**Verification:**
- [ ] Test script exercises all validation functions
- [ ] Validation passes on fixture with valid frontmatter
- [ ] Validation fails on each specific invalid case
- [ ] All 12 real skills FAIL validation (confirms RED state)

**Dependencies:** None
**Parallelizable:** No (foundation for all other tasks)

---

### Task 002: Add YAML frontmatter to 6 simple skills

**Phase:** RED → GREEN → REFACTOR

Skills: brainstorming, dotnet-standards, git-worktrees, refactor, spec-review, sync-schemas

These skills need frontmatter only — no splitting, no troubleshooting sections needed.

**Important:** Work from the d3-prompt-migration versions of these files, which already have composite tool names.

**TDD Steps:**

1. [RED] Run validation against these 6 skills
   - Run: `bash skills/validate-frontmatter.sh skills/brainstorming/SKILL.md brainstorming`
   - Expected failure: "Missing frontmatter delimiters"
   - Repeat for all 6 skills — all MUST FAIL

2. [GREEN] Add YAML frontmatter to each skill
   - Files to modify:
     - `skills/brainstorming/SKILL.md`
     - `skills/dotnet-standards/SKILL.md`
     - `skills/git-worktrees/SKILL.md`
     - `skills/refactor/SKILL.md`
     - `skills/spec-review/SKILL.md`
     - `skills/sync-schemas/SKILL.md`
   - Each gets frontmatter block with:
     - `name:` matching folder name (kebab-case)
     - `description:` with WHAT + WHEN + 3-5 trigger phrases
     - `metadata:` with author, version, mcp-server, category, phase-affinity
   - Frontmatter goes ABOVE the existing `# Skill Name` heading
   - Run: `bash skills/validate-frontmatter.sh skills/<name>/SKILL.md <name>` — MUST PASS for all 6

   **Specific descriptions:**

   ```yaml
   # brainstorming
   name: brainstorming
   description: >-
     Collaborative design exploration for new features and architecture decisions.
     Use when the user says "let's brainstorm", "let's ideate", "explore options",
     or runs /ideate. Presents 2-3 distinct approaches with trade-offs, then
     documents the chosen approach as a design document.
     Do NOT use for implementation planning or code review.
   metadata:
     author: exarchos
     version: 1.0.0
     mcp-server: exarchos
     category: workflow
     phase-affinity: ideate

   # dotnet-standards
   name: dotnet-standards
   description: >-
     .NET and C# coding standards, conventions, and project configuration.
     Use when working with .cs files, .NET projects, or C# codebases.
     Provides SOLID constraints, naming conventions, error handling patterns,
     and project structure guidelines specific to the .NET ecosystem.
   metadata:
     author: exarchos
     version: 1.0.0
     category: standards

   # git-worktrees
   name: git-worktrees
   description: >-
     Git worktree management for parallel development in agent team workflows.
     Use when creating worktrees, validating worktree paths, or setting up
     isolated development environments. Trigger: "create worktree",
     "worktree setup", or during /delegate task dispatch.
     Do NOT use for general git operations.
   metadata:
     author: exarchos
     version: 1.0.0
     mcp-server: exarchos
     category: utility
     phase-affinity: delegate

   # refactor
   name: refactor
   description: >-
     Code improvement workflow with two tracks: polish (small, direct changes)
     and overhaul (large, delegated restructuring). Use when the user says
     "refactor", "clean up", "restructure", "reorganize", or runs /refactor.
     Handles explore, brief, implement, validate, and documentation phases.
   metadata:
     author: exarchos
     version: 1.0.0
     mcp-server: exarchos
     category: workflow
     phase-affinity: [explore, brief, implement, validate, update-docs, synthesize]

   # spec-review
   name: spec-review
   description: >-
     Design-to-plan delta analysis for implementation coverage verification.
     Use during the plan-review phase to compare design document sections
     against planned implementation tasks. Identifies gaps in spec coverage.
     Do NOT use for code quality review — use quality-review instead.
   metadata:
     author: exarchos
     version: 1.0.0
     mcp-server: exarchos
     category: workflow
     phase-affinity: plan-review

   # sync-schemas
   name: sync-schemas
   description: >-
     Synchronize TypeScript types from backend OpenAPI specifications.
     Use when the user says "sync schemas", "update types from API",
     or runs /sync-schemas. Generates TypeScript interfaces from OpenAPI
     spec files and validates type compatibility.
   metadata:
     author: exarchos
     version: 1.0.0
     category: utility
   ```

3. [REFACTOR] Review descriptions for clarity and trigger precision
   - Ensure negative triggers are present where skills could over-fire
   - Verify descriptions are ≤1,024 characters
   - Run validation one final time

**Verification:**
- [ ] All 6 skills pass frontmatter validation
- [ ] Existing .test.sh scripts still pass (frontmatter doesn't break grep patterns)
- [ ] Descriptions include WHAT + WHEN + trigger phrases
- [ ] No description exceeds 1,024 characters

**Dependencies:** Task 001
**Parallelizable:** Yes (independent of Tasks 003, 004, 005, 006)

---

### Task 003: Split quality-review + add frontmatter

**Phase:** RED → GREEN → REFACTOR

**Important:** Work from the d3-prompt-migration version which already has composite tool names (e.g., `mcp__exarchos__exarchos_workflow` with `action: "set"`).

**TDD Steps:**

1. [RED] Define expected structure and validate
   - Run: `bash skills/validate-frontmatter.sh skills/quality-review/SKILL.md quality-review`
   - Expected failure: "Missing frontmatter delimiters"
   - Verify current SKILL.md is >2,000 words (monolithic)

2. [GREEN] Split skill and add frontmatter
   - **Create reference files:**
     - `skills/quality-review/references/code-quality-checklist.md` — Extract code quality criteria: DRY enforcement, SOLID principles (ISP violations, composition over inheritance), control flow patterns, structural standards
     - `skills/quality-review/references/security-checklist.md` — Extract security review criteria: OWASP patterns, input validation, auth checks
     - `skills/quality-review/references/review-report-template.md` — Extract report template and verdict categories
   - **Restructure SKILL.md** (~800 words):
     - Keep: Overview, two-stage review process flow, stage descriptions
     - Keep: References to checklists using `Consult references/<file>` pattern
     - Keep: Transition logic, state management, exarchos integration
     - Remove: Inline criteria (moved to references/)
     - Preserve: All composite tool name references from d3-prompt-migration
   - **Add frontmatter:**
     ```yaml
     ---
     name: quality-review
     description: >-
       Two-stage code review: spec compliance then code quality analysis.
       Use when the user says "review code", "check quality", "code review",
       or runs /review. Stage 1 verifies design alignment. Stage 2 checks
       SOLID principles, DRY, security, and test quality.
       Do NOT use for plan-design delta analysis — use spec-review instead.
     metadata:
       author: exarchos
       version: 1.0.0
       mcp-server: exarchos
       category: workflow
       phase-affinity: review
     ---
     ```
   - Run: `bash skills/validate-frontmatter.sh skills/quality-review/SKILL.md quality-review` — MUST PASS
   - Run: `bash skills/quality-review/SKILL.md.test.sh` — MUST PASS (existing tests still green)

3. [REFACTOR] Verify progressive disclosure
   - Confirm SKILL.md is ≤800 words
   - Confirm each reference file is ≤1,000 words
   - Confirm total skill is ≤5,000 words
   - Ensure SKILL.md explicitly references each reference file

**Verification:**
- [ ] Frontmatter validation passes
- [ ] SKILL.md ≤800 words (was 2,040)
- [ ] All reference files ≤1,000 words
- [ ] Existing .test.sh still passes
- [ ] All review criteria preserved (nothing lost in split)
- [ ] SKILL.md references each checklist at the appropriate workflow step
- [ ] Composite tool names from d3-prompt-migration preserved in all files

**Dependencies:** Task 001
**Parallelizable:** Yes (independent of Tasks 002, 004, 005, 006)

---

### Task 004: Split implementation-planning + add frontmatter

**Phase:** RED → GREEN → REFACTOR

**Important:** Work from the d3-prompt-migration version which already has composite tool names.

**TDD Steps:**

1. [RED] Define expected structure and validate
   - Run: `bash skills/validate-frontmatter.sh skills/implementation-planning/SKILL.md implementation-planning`
   - Expected failure: "Missing frontmatter delimiters"
   - Verify current SKILL.md is >1,000 words (monolithic)

2. [GREEN] Split skill and add frontmatter
   - **Create reference files:**
     - `skills/implementation-planning/references/task-template.md` — Extract TDD task format template
     - `skills/implementation-planning/references/spec-tracing-guide.md` — Extract traceability matrix methodology
     - `skills/implementation-planning/references/plan-document-template.md` — Extract plan document structure
   - **Restructure SKILL.md** (~700 words):
     - Keep: Overview, triggers, revision mode, Iron Law, planning process steps (high-level)
     - Keep: References to templates using `Consult references/<file>` pattern
     - Keep: Anti-patterns table, state management, transition logic
     - Remove: Inline templates and detailed methodology (moved to references/)
     - Preserve: All composite tool name references from d3-prompt-migration
   - **Add frontmatter:**
     ```yaml
     ---
     name: implementation-planning
     description: >-
       Transform design documents into TDD-based implementation plans with
       granular, parallelizable tasks. Use when the user says "plan implementation",
       "create tasks from design", "break down the design", or runs /plan.
       Enforces the Iron Law: no production code without a failing test first.
       Do NOT use for design exploration — use brainstorming instead.
     metadata:
       author: exarchos
       version: 1.0.0
       mcp-server: exarchos
       category: workflow
       phase-affinity: plan
     ---
     ```
   - Run: `bash skills/validate-frontmatter.sh skills/implementation-planning/SKILL.md implementation-planning` — MUST PASS

3. [REFACTOR] Verify progressive disclosure
   - Confirm SKILL.md is ≤700 words
   - Confirm each reference file is ≤1,000 words
   - Ensure SKILL.md references each template at the appropriate step
   - Verify step numbering is preserved

**Verification:**
- [ ] Frontmatter validation passes
- [ ] SKILL.md ≤700 words (was 1,370)
- [ ] All reference files ≤1,000 words
- [ ] All planning methodology preserved (nothing lost in split)
- [ ] SKILL.md references each template at the correct planning step
- [ ] Iron Law and anti-patterns table remain in SKILL.md (core workflow content)
- [ ] Composite tool names from d3-prompt-migration preserved

**Dependencies:** Task 001
**Parallelizable:** Yes (independent of Tasks 002, 003, 005, 006)

---

### Task 005: Add frontmatter + troubleshooting to 4 MCP-heavy skills

**Phase:** RED → GREEN → REFACTOR

Skills: debug, delegation, synthesis, workflow-state

These skills coordinate MCP calls and need both frontmatter AND troubleshooting sections.

**Important:** d3-prompt-migration has already migrated tool names in these files. Troubleshooting sections MUST use composite tool names.

**TDD Steps:**

1. [RED] Run validation against these 4 skills
   - Run: `bash skills/validate-frontmatter.sh skills/debug/SKILL.md debug`
   - Expected failure: "Missing frontmatter delimiters"
   - Repeat for delegation, synthesis, workflow-state — all MUST FAIL

2. [GREEN] Add frontmatter and troubleshooting to each skill
   - Files to modify:
     - `skills/debug/SKILL.md`
     - `skills/delegation/SKILL.md`
     - `skills/synthesis/SKILL.md`
     - `skills/workflow-state/SKILL.md`

   **Frontmatter descriptions:**

   ```yaml
   # debug
   name: debug
   description: >-
     Bug investigation and fix workflow with hotfix and thorough tracks.
     Use when the user says "debug", "fix bug", "investigate issue",
     "something is broken", or runs /debug. Hotfix track for quick fixes,
     thorough track for complex bugs requiring root cause analysis.
     Do NOT use for code improvement — use refactor instead.
   metadata:
     author: exarchos
     version: 1.0.0
     mcp-server: exarchos
     category: workflow
     phase-affinity: [triage, investigate, rca, design, implement, validate, review, synthesize]

   # delegation
   name: delegation
   description: >-
     Dispatch implementation tasks to agent teammates in git worktrees.
     Use when the user says "delegate", "dispatch tasks", "assign work",
     or runs /delegate. Spawns teammates, creates worktrees, monitors
     progress, and collects results. Supports --fixes flag for review
     finding remediation.
     Do NOT use for direct implementation — orchestrator delegates only.
   metadata:
     author: exarchos
     version: 1.0.0
     mcp-server: exarchos
     category: workflow
     phase-affinity: delegate

   # synthesis
   name: synthesis
   description: >-
     Create pull request from completed feature branch using Graphite
     stacked PRs. Use when the user says "create PR", "submit for review",
     "synthesize", or runs /synthesize. Validates branch readiness, creates
     PR with structured description, and manages merge queue.
     Do NOT use before /review has passed.
   metadata:
     author: exarchos
     version: 1.0.0
     mcp-server: exarchos
     category: workflow
     phase-affinity: synthesize

   # workflow-state
   name: workflow-state
   description: >-
     Checkpoint and resume workflow state for context persistence across
     sessions. Use when the user says "save progress", "checkpoint",
     "I need to stop", or runs /checkpoint or /resume. Saves current
     workflow phase, task progress, and artifacts for later resumption.
   metadata:
     author: exarchos
     version: 1.0.0
     mcp-server: exarchos
     category: utility
     phase-affinity: [ideate, plan, delegate, review, synthesize]
   ```

   **Troubleshooting section** (added before the Exarchos Integration section, using **composite tool names**):

   ```markdown
   ## Troubleshooting

   ### MCP Tool Call Failed
   If an Exarchos MCP tool returns an error:
   1. Check the error message — it usually contains specific guidance
   2. Verify the workflow state exists: call `exarchos_workflow` with `action: "get"` and the featureId
   3. If "version mismatch": another process updated state — retry the operation
   4. If state is corrupted: call `exarchos_workflow` with `action: "cancel"` and `dryRun: true`

   ### State Desync
   If workflow state doesn't match git reality:
   1. The SessionStart hook runs reconciliation automatically on resume
   2. If manual check needed: compare state file with `git log` and branch state
   3. Update state via `exarchos_workflow` with `action: "set"` to match git truth
   ```

   Plus skill-specific troubleshooting entries:
   - **debug:** "Investigation timeout" (15 min limit), "Track switching" (hotfix → thorough)
   - **delegation:** "Worktree creation failed", "Teammate spawn timeout" (`exarchos_orchestrate` with `action: "team_status"` to check), "Task claim conflict" (`exarchos_orchestrate` with `action: "task_claim"` returns `ALREADY_CLAIMED`)
   - **synthesis:** "PR creation failed" (check `gt submit` output), "Stack rebase conflict" (`gt restack`), "Merge queue rejection"
   - **workflow-state:** "Checkpoint file missing" (PreCompact hook creates `.checkpoint.json`), "Resume finds stale state" (SessionStart hook handles automatically), "Multiple active workflows"

   - Run: `bash skills/validate-frontmatter.sh skills/<name>/SKILL.md <name>` — MUST PASS for all 4
   - Run existing .test.sh scripts — MUST PASS (delegation/SKILL.md.test.sh, synthesis/SKILL.md.test.sh)

3. [REFACTOR] Verify word counts remain within limits
   - All 4 skills should remain ≤2,000 words after additions
   - Troubleshooting sections should be ~150-250 words each (concise)
   - If any skill exceeds limit, extract troubleshooting to `references/troubleshooting.md`

**Verification:**
- [ ] All 4 skills pass frontmatter validation
- [ ] Existing .test.sh scripts still pass
- [ ] Troubleshooting sections use composite tool names (NOT old individual names)
- [ ] Troubleshooting references hooks where appropriate (SessionStart, PreCompact)
- [ ] Each skill includes both generic and skill-specific troubleshooting
- [ ] No skill exceeds 2,000-word body limit after additions

**Dependencies:** Task 001
**Parallelizable:** Yes (independent of Tasks 002, 003, 004, 006)

---

### Task 006: Wire generate-docs to produce mcp-tool-guidance.md

**Phase:** RED → GREEN → REFACTOR

**Context:** d2-generate-docs (PR #192) already provides `scripts/generate-docs.ts` which reads from `TOOL_REGISTRY` and outputs markdown to stdout with composite tool tables, action details, and phase mappings. The current `rules/mcp-tool-guidance.md` was hand-updated by d3-prompt-migration to use composite names (79 lines changed). This task replaces the tool reference tables with registry-generated content while preserving the anti-patterns and proactive-use guidance.

**TDD Steps:**

1. [RED] Verify generate-docs produces valid output
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npx tsx scripts/generate-docs.ts` — should output markdown
   - Compare output structure against current `rules/mcp-tool-guidance.md` — identify sections that can be replaced vs. preserved
   - Confirm the generated output does NOT cover: anti-patterns table, proactive use guidance, tool selection priority, MCP server descriptions for non-Exarchos tools (GitHub, Serena, Context7, Graphite, Microsoft Learn)

2. [GREEN] Restructure mcp-tool-guidance.md
   - **Split the rule into two concerns:**
     - `rules/mcp-tool-guidance.md` — Keeps: proactive use guidance, anti-patterns table, tool selection priority, non-Exarchos MCP server sections (GitHub, Serena, Context7, Graphite, Microsoft Learn). Removes: Exarchos tool tables (replaced by generated reference).
     - Add `<!-- Exarchos tool reference: see generated output from scripts/generate-docs.ts -->` marker where the Exarchos tables were
   - **OR** (simpler): Keep mcp-tool-guidance.md as-is (d3-prompt-migration already updated it), add a comment noting the Exarchos section can be regenerated from registry
   - **Add npm script:** `"generate:docs": "tsx scripts/generate-docs.ts > ../../docs/schemas/tool-reference.md"` to exarchos-mcp package.json
   - Run the script and verify output matches expectations

3. [REFACTOR] Ensure generated output stays in sync
   - Add `<!-- Auto-generated from tool registry. Regenerate with: cd plugins/exarchos/servers/exarchos-mcp && npm run generate:docs -->` header to generated file
   - Verify the generated file is committed (not gitignored)

**Verification:**
- [ ] generate-docs.ts runs successfully and produces valid markdown
- [ ] npm script wired and working
- [ ] Generated tool reference committed to `docs/schemas/tool-reference.md`
- [ ] mcp-tool-guidance.md either references the generated file or retains d3's manual update
- [ ] No stale individual tool names remain

**Dependencies:** Task 001
**Parallelizable:** Yes (independent of Tasks 002, 003, 004, 005)

---

### Task 007: Update CLAUDE.md and run final validation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Run full validation suite
   - Run: `bash skills/validate-all-skills.sh` — expect some skills may still fail if prior tasks incomplete
   - Verify CLAUDE.md does not mention YAML frontmatter convention for skills

2. [GREEN] Update CLAUDE.md
   - File: `CLAUDE.md`
   - Add to "Content Layers" section after the Skills bullet:
     ```markdown
     Skills use YAML frontmatter (`name`, `description`, `metadata`) following
     Anthropic's skill format. The `description` field includes trigger phrases
     for when the skill should activate. Larger skills use `references/`
     subdirectories for progressive disclosure of detailed content.
     ```
   - Add to "Key Conventions" section:
     ```markdown
     - **Skill frontmatter** — Every `SKILL.md` has YAML frontmatter with `name`
       (kebab-case, matches folder), `description` (≤1,024 chars, WHAT + WHEN +
       triggers), and `metadata` (author, version, mcp-server, category, phase-affinity)
     ```
   - Run: `bash skills/validate-all-skills.sh` — ALL 12 skills MUST PASS

3. [REFACTOR] Final consistency pass
   - Verify all descriptions are consistent in style and format
   - Verify all metadata blocks use the same field set
   - Run every existing .test.sh script to confirm no regressions
   - Word count spot-check on split skills

**Verification:**
- [ ] All 12 skills pass frontmatter validation
- [ ] All existing .test.sh scripts pass
- [ ] CLAUDE.md documents the frontmatter convention
- [ ] No skill body exceeds 2,000 words
- [ ] No reference file exceeds 1,000 words

**Dependencies:** Tasks 001, 002, 003, 004, 005, 006 (all must complete first)
**Parallelizable:** No (final integration task)

---

### Task 008: Scope and condense rules for context optimization

**Phase:** RED → GREEN → REFACTOR

**Context:** Rules load into every session regardless of relevance. Five rules totaling ~2.8k tokens are only useful in specific contexts. Two strategies apply: `paths` frontmatter for file-specific rules (Claude Code skips loading when no matching files are active), and condensing + migrating phase-specific rules into skill `references/` so they only load when the skill is invoked.

**TDD Steps:**

1. [RED] Measure current token baseline
   - Count tokens for each rule file (approximate: `wc -w` × 1.3)
   - Record baseline: total rule tokens across all 9 rule files
   - Verify no rules currently use `paths` frontmatter

2. [GREEN] Scope file-specific rules with `paths` frontmatter
   - File: `rules/tdd-typescript.md` (434 tokens)
     - Add frontmatter: `paths: ["**/*.test.ts", "**/*.test.tsx"]`
     - Only loads when test files are being worked on
   - File: `rules/coding-standards-typescript.md` (675 tokens)
     - Add frontmatter: `paths: ["**/*.ts", "**/*.tsx"]`
     - Only loads when TypeScript files are being worked on
   - Verify: rules still load correctly when working with matching files

3. [GREEN] Condense and migrate phase-specific rules
   - File: `rules/pr-descriptions.md` (674 → ~200 tokens)
     - Keep: title format, body structure template, footer format
     - Move to: `skills/synthesis/references/pr-descriptions.md` (full version with example)
     - Replace rule with: brief 3-line reminder pointing to skill reference
     - **OR** delete rule entirely — synthesis skill already loads during PR creation
   - File: `rules/orchestrator-constraints.md` (630 → ~150 tokens)
     - Keep: core "orchestrator MUST NOT write code" constraint (3 lines)
     - Move to: `skills/delegation/references/orchestrator-constraints.md` (full version with exceptions, polish track details)
     - Replace rule with: brief constraint statement + pointer to skill reference
   - `rules/rm-safety.md` (383 tokens) — keep as-is (universal safety, justified cost)

4. [REFACTOR] Verify scoping works correctly
   - Confirm `paths`-scoped rules do NOT load when working on non-matching files
   - Confirm migrated content is accessible when relevant skill is invoked
   - Re-measure token baseline — expect ~1.5-2k reduction in typical sessions

**Verification:**
- [ ] `tdd-typescript.md` only loads when `.test.ts` files are active
- [ ] `coding-standards-typescript.md` only loads when `.ts` files are active
- [ ] `pr-descriptions.md` content preserved in synthesis skill reference
- [ ] `orchestrator-constraints.md` core constraint preserved as lean rule
- [ ] Full constraint details available via delegation skill reference
- [ ] No behavioral regressions — constraints still enforced in relevant contexts

**Files Modified:**

| File | Action |
|---|---|
| `rules/tdd-typescript.md` | Add `paths` frontmatter |
| `rules/coding-standards-typescript.md` | Add `paths` frontmatter |
| `rules/pr-descriptions.md` | Condense to brief pointer (~200 tokens) |
| `rules/orchestrator-constraints.md` | Condense to core constraint (~150 tokens) |
| `skills/synthesis/references/pr-descriptions.md` | New — full PR description guide |
| `skills/delegation/references/orchestrator-constraints.md` | New — full orchestrator constraints with exceptions |

**Dependencies:** Task 007 (all skills must have frontmatter + references/ structure first)
**Parallelizable:** Yes (independent of Task 009)

---

### Task 009: Post-hooks context audit — prune redundant rules

**Phase:** RED → GREEN → REFACTOR

**Context:** The progressive-disclosure hooks stack replaces several rules with deterministic hook behavior. Once hooks land, some rules become fully redundant (same guidance enforced by code), and others become partially redundant. This task audits and prunes them.

**Prerequisite:** Full hooks stack must be merged (PreCompact, SessionStart, phase guardrails, SubagentStart context, quality gates). This task cannot start until hooks are deployed and verified.

**TDD Steps:**

1. [RED] Audit current rules against hook coverage
   - Map each rule to hooks that subsume its guidance:

   | Rule | Tokens | Hook That Subsumes | Verdict |
   |---|---|---|---|
   | `workflow-auto-resume.md` | 2,200 | SessionStart hook (context injection + auto-resume) | **Eliminate** |
   | `mcp-tool-guidance.md` | 3,200 | Phase guardrail hook (§2.2) + SubagentStart hook (§2.4) | **Evaluate** |
   | `primary-workflows.md` | 336 | Skill frontmatter trigger phrases + SessionStart hook | **Evaluate** |

   - Verify `workflow-auto-resume.md` has already been removed by hooks stack installer changes
   - If not removed: flag as oversight in hooks stack

2. [GREEN] Evaluate and prune `mcp-tool-guidance.md`
   - With phase guardrails enforcing tool selection deterministically and SubagentStart injecting per-phase tool lists, the rule's Exarchos sections are redundant
   - **Keep:** Non-Exarchos MCP server sections (GitHub, Serena, Context7, Graphite) — hooks don't cover these
   - **Keep:** Anti-pattern table entries for non-Exarchos tools
   - **Remove:** Exarchos tool tables, Exarchos anti-patterns (hooks enforce these)
   - **Remove:** Tool selection priority for Exarchos (guardrail hook handles this)
   - Expected reduction: 3,200 → ~1,200 tokens (remove ~2k of Exarchos-specific guidance)

3. [GREEN] Evaluate and prune `primary-workflows.md`
   - With skill frontmatter containing trigger phrases, Claude already knows when to suggest each workflow
   - **If redundant:** Remove entirely (336 tokens saved)
   - **If partially useful:** Condense to a 3-line table (workflow → command mapping) ~80 tokens

4. [REFACTOR] Document final token budget
   - Create `docs/adrs/context-token-budget.md` with:
     - Per-rule token costs (measured, not estimated)
     - Per-MCP-server tool schema costs
     - Total fixed overhead per session
     - Comparison: before vs. after optimization
     - Guidance for adding new rules (token budget awareness)

**Verification:**
- [ ] `workflow-auto-resume.md` confirmed removed (by hooks stack or by this task)
- [ ] `mcp-tool-guidance.md` reduced to non-Exarchos content only (~1,200 tokens)
- [ ] `primary-workflows.md` eliminated or condensed to ≤80 tokens
- [ ] No behavioral regressions — all constraints still enforced (by hooks or remaining rules)
- [ ] Token budget documented in ADR
- [ ] Total fixed rule overhead ≤5k tokens (down from ~11k)

**Files Modified:**

| File | Action |
|---|---|
| `rules/workflow-auto-resume.md` | Verify removed (or remove) |
| `rules/mcp-tool-guidance.md` | Prune Exarchos sections |
| `rules/primary-workflows.md` | Eliminate or condense |
| `docs/adrs/context-token-budget.md` | New — token budget documentation |

**Dependencies:** Task 007 + full hooks stack merged and verified
**Parallelizable:** Yes (independent of Task 008, but both after Task 007)

---

## Parallelization Strategy

```
Task 001 (Foundation: validation script)
    │
    ├──► Task 002 (6 simple skills - frontmatter) ──────────────────┐
    ├──► Task 003 (quality-review split + frontmatter) ─────────────┤
    ├──► Task 004 (implementation-planning split + frontmatter) ─────┤
    ├──► Task 005 (4 MCP skills - frontmatter + troubleshooting) ───┤
    └──► Task 006 (Wire generate-docs to mcp-tool-guidance.md) ─────┤
                                                                     │
                                                                     ▼
                                                            Task 007 (CLAUDE.md + validation)
                                                                     │
                                                    ┌────────────────┤
                                                    ▼                ▼
                                          Task 008            Task 009
                                    (Scope/condense     (Post-hooks audit
                                       rules)            + rule pruning)
                                                          [blocked on hooks stack]
```

### Parallel Groups

- **Group 1 (sequential):** Task 001 alone (foundation)
- **Group 2 (parallel, 5 worktrees):** Tasks 002, 003, 004, 005, 006 — all edit different files
- **Group 3 (sequential):** Task 007 alone (integration)
- **Group 4 (parallel, after 007):** Tasks 008, 009 — independent rule optimizations (009 additionally blocked on hooks stack merge)

### Worktree File Ownership (no conflicts)

| Task | Files Modified |
|---|---|
| 002 | `skills/{brainstorming,dotnet-standards,git-worktrees,refactor,spec-review,sync-schemas}/SKILL.md` |
| 003 | `skills/quality-review/SKILL.md`, `skills/quality-review/references/*` (new) |
| 004 | `skills/implementation-planning/SKILL.md`, `skills/implementation-planning/references/*` (new) |
| 005 | `skills/{debug,delegation,synthesis,workflow-state}/SKILL.md` |
| 006 | `rules/mcp-tool-guidance.md`, `docs/schemas/tool-reference.md` (new), `plugins/exarchos/servers/exarchos-mcp/package.json` |
| 008 | `rules/tdd-typescript.md`, `rules/coding-standards-typescript.md`, `rules/pr-descriptions.md`, `rules/orchestrator-constraints.md`, `skills/synthesis/references/pr-descriptions.md` (new), `skills/delegation/references/orchestrator-constraints.md` (new) |
| 009 | `rules/workflow-auto-resume.md`, `rules/mcp-tool-guidance.md`, `rules/primary-workflows.md`, `docs/adrs/context-token-budget.md` (new) |

No file is touched by more than one parallel task (008 and 009 touch different rules; 009's `mcp-tool-guidance.md` edits are additive to 006's changes).

### Graphite Stacking Strategy

Each task gets its own branch stacked on d3-prompt-migration:

```
d3-prompt-migration
  ├─► skills-content-mod/001-validation-script
  │     ├─► skills-content-mod/002-simple-frontmatter
  │     ├─► skills-content-mod/003-quality-review-split
  │     ├─► skills-content-mod/004-impl-planning-split
  │     ├─► skills-content-mod/005-mcp-skills-troubleshooting
  │     └─► skills-content-mod/006-generate-docs-wiring
  │           └─► skills-content-mod/007-docs-validation
  │                 ├─► skills-content-mod/008-rule-scoping
  │                 └─► skills-content-mod/009-post-hooks-audit [after hooks stack merge]
```

Tasks 002-006 branch from 001 (not from each other) since they edit non-overlapping files. Task 007 merges all prior changes. Tasks 008-009 branch from 007; Task 009 additionally requires the full hooks stack to be merged.

## Deferred Items

| Item | Rationale |
|---|---|
| §5.2 Per-skill tool manifests | Low priority — skills already reference tools adequately via d3-prompt-migration |
| §5.3 Skill-aware SubagentStart hook | Requires extending `cli.ts` with frontmatter parsing — separate PR |
| §6 Validation scripts (pre-dispatch.sh, pre-submit.sh) | Separate concern from content modernization — own feature |
| Open Question 1 (Claude Code frontmatter behavior) | Empirical testing — can be done post-implementation |
| Open Question 5 (allowed-tools field) | Informational only until tool registry can validate |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All 12 skills have valid YAML frontmatter
- [ ] quality-review split into SKILL.md + references/ (≤800 + references)
- [ ] implementation-planning split into SKILL.md + references/ (≤700 + references)
- [ ] 4 MCP-heavy skills have troubleshooting sections (using composite tool names)
- [ ] Troubleshooting references hooks (SessionStart, PreCompact) where appropriate
- [ ] generate-docs.ts wired to produce committed tool reference
- [ ] Validation script covers all frontmatter requirements
- [ ] All existing .test.sh scripts pass (no regressions)
- [ ] CLAUDE.md documents frontmatter convention
- [ ] File-specific rules scoped with `paths` frontmatter (tdd-typescript, coding-standards-typescript)
- [ ] Phase-specific rules condensed and migrated to skill references (pr-descriptions, orchestrator-constraints)
- [ ] Post-hooks rule audit complete — redundant rules eliminated or condensed
- [ ] Token budget documented in ADR
- [ ] All branches stacked on d3-prompt-migration via Graphite
- [ ] Ready for review
