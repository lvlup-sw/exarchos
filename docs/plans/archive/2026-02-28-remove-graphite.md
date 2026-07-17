# Implementation Plan: Remove Graphite — GitHub-Native Stacking

## Source Design
Brief: `refactor-remove-graphite` workflow state (no separate design doc — refactor workflow uses brief)

## Scope
**Target:** Full — all 13 goals from brief
**Excluded:** None

## Summary
- Total tasks: 16
- Parallel groups: 4 worktrees
- Estimated test count: 12 (unit) + 2 (bash script)
- Design coverage: 13 of 13 brief goals covered

## Spec Traceability

| Brief Goal | Tasks |
|---|---|
| G1: Remove Graphite from manifest/installer | T1, T2 |
| G2: Remove detectGraphite from session-start | T3 |
| G3: Replace gt log in prepare-synthesis | T4 |
| G4: Update playbook compactGuidance | T5 |
| G5: Replace mcp__graphite__run_gt_cmd in skills | T9, T10, T11, T12 |
| G6: Replace gt create/submit in commit strategy | T10 |
| G7: Create github-native-stacking.md | T7 |
| G8: Replace reconstruct-stack.sh with validate-pr-stack.sh | T8 |
| G9: Update skill frontmatter descriptions | T9, T11 |
| G10: Update CLAUDE.md and rules | T13 |
| G11: Update distributed-sdlc-pipeline.md | T14 |
| G12: Update MEMORY.md | T16 |
| G13: All tests pass | T1–T8 (each verifies), T6 (integration) |

## Task Breakdown

---

### Worktree 1: MCP Server Code (TypeScript)

> **Branch:** `refactor/remove-graphite-mcp-server`
> **Dependencies:** None (foundation layer)

---

### Task 1: Remove Graphite MCP server from manifest.json

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `loadManifest_McpServers_DoesNotContainGraphite`
   - File: `src/manifest/loader.test.ts`
   - Expected failure: manifest still contains graphite server entry
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Remove graphite entry from manifest.json mcpServers array
   - File: `manifest.json`
   - Changes: Remove lines 36-46 (graphite MCP server object)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] N/A

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after removal
- [ ] manifest.json has exactly 2 mcpServers (exarchos, microsoft-learn)

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes (within worktree 1)

---

### Task 2: Remove Graphite from installer and plugin metadata

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `addMcpConfig_ConfiguresServers_NoGraphiteEntry` in `src/operations/mcp.test.ts`
   - `removeMcpConfig_RemovesServers_NoGraphiteDelete` in `src/operations/mcp.test.ts`
   - Expected failure: installer still writes/deletes graphite config
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement changes:
   - File: `src/install.ts` — Remove lines 99-103 (graphite addMcpConfig), remove line 125 (graphite removeMcpConfig)
   - File: `package.json` — Update description to remove "Graphite", remove "graphite" keyword
   - File: `.claude-plugin/plugin.json` — Update description and keywords
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up any Graphite-related test helpers in mcp.test.ts

**Verification:**
- [ ] Witnessed tests fail for the right reason
- [ ] Tests pass after implementation
- [ ] `grep -r graphite src/install.ts` returns nothing

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** Task 1
**Parallelizable:** No (sequential with Task 1)

---

### Task 3: Remove detectGraphite from session-start.ts

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `handleSessionStart_Result_NoGraphiteAvailableField` in `session-start.test.ts`
   - Update all existing `graphiteAvailable` expectations to assert field is absent
   - Expected failure: SessionStartResult still has graphiteAvailable
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement changes:
   - File: `servers/exarchos-mcp/src/cli-commands/session-start.ts`
   - Remove: `graphiteAvailable` from `SessionStartResult` interface (line 62)
   - Remove: `detectGraphite()` function (lines 87-104)
   - Remove: `GRAPHITE_INSTALL_MESSAGE` constant (lines 512-516)
   - Remove: `enrichResult()` graphiteAvailable parameter and logic (lines 519-532)
   - Remove: All `graphiteAvailable` references in `handleSessionStart()` (lines 574-712)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Simplify enrichResult signature (no longer needs graphite boolean)

**Verification:**
- [ ] Witnessed tests fail for the right reason
- [ ] Tests pass after implementation
- [ ] `grep -r graphite servers/exarchos-mcp/src/cli-commands/` returns nothing
- [ ] `npm run typecheck` passes

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes (within worktree 1)

---

### Task 4: Replace gt log with git-native stack verification in prepare-synthesis.ts

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `verifyStack_UsesGitBranch_NotGtLog`
   - File: `servers/exarchos-mcp/src/orchestrate/prepare-synthesis.test.ts`
   - Mock `execSync` to verify it calls `git log --oneline` or `git branch` (not `gt log`)
   - Expected failure: verifyStack still calls gt log
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Replace `verifyStack()` implementation:
   - File: `servers/exarchos-mcp/src/orchestrate/prepare-synthesis.ts`
   - Replace `execSync('gt log', ...)` with `execSync('git log --oneline --graph main..HEAD', ...)`
   - Parse branch chain from git output instead of gt output
   - Update comment on line 4 (remove "Graphite stack health")
   - Update comment on line 236 ("Verify Graphite stack" → "Verify branch stack")
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Rename function `verifyStack` → `verifyBranchChain` for clarity

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] `grep -r 'gt log' servers/exarchos-mcp/` returns nothing

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes (within worktree 1)

---

### Task 5: Update playbook compactGuidance strings

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `playbookGuidance_SynthesizePhase_ReferencesGhCli`
   - File: `servers/exarchos-mcp/src/workflow/playbooks.test.ts` (or guards.test.ts if that's where playbook tests live)
   - Assert that compactGuidance for synthesize phases does not contain "Graphite"
   - Assert guidance contains "gh pr create" or "GitHub"
   - Expected failure: guidance still references Graphite
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Update 3 compactGuidance strings:
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts`
   - Line 308 (feature synthesize): "via Graphite" → "via GitHub CLI"
   - Line 577 (debug synthesize): "via Graphite" → "via GitHub CLI"
   - Line 879 (refactor synthesize): "via Graphite for the overhaul refactoring" → "via GitHub CLI for the overhaul refactoring"
   - Also update `validationScripts` on line 875: replace `reconstruct-stack.sh` → `validate-pr-stack.sh`
   - Also update `validationScripts` on line 304 similarly
   - Update guards.test.ts fixture data (line 333: `gt submit failed` → `gh pr create failed`)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] N/A

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] `grep -ri graphite servers/exarchos-mcp/src/workflow/` returns nothing

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes (within worktree 1)

---

### Task 6: Integration verification — typecheck and full test suite

**Phase:** GREEN (verification only)

**Steps:**
1. Run `npm run typecheck` — MUST PASS (no type errors from removed fields)
2. Run `npm run test:run` — ALL tests MUST PASS
3. Run `grep -ri 'graphite\|gt submit\|gt create\|gt log\|gt modify\|gt restack\|mcp__graphite' servers/exarchos-mcp/src/` — MUST return nothing

**Verification:**
- [ ] Zero type errors
- [ ] All tests green
- [ ] Zero Graphite references in MCP server source

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** Tasks 1-5
**Parallelizable:** No (runs after all worktree 1 tasks)

---

### Worktree 2: New Reference Content + Scripts

> **Branch:** `refactor/remove-graphite-stacking-reference`
> **Dependencies:** None (parallel with worktree 1)

---

### Task 7: Create github-native-stacking.md reference

**Phase:** Content creation (no TDD — Markdown only)

**Steps:**
1. Create `skills/synthesis/references/github-native-stacking.md`
2. Content must cover:
   - **PR Chain Creation:** `gh pr create --base <previous-branch> --title "..." --body "..."`
   - **Merge Ordering:** Bottom-up (merge PR 1 → GitHub auto-retargets PR 2 to main)
   - **Auto-retargeting:** When a PR's base branch is merged+deleted, GitHub retargets dependent PRs
   - **Branch Updates:** `gh pr update-branch --rebase` for rebasing on updated base
   - **Stack Visualization:** `gh pr list --json number,baseRefName,headRefName`
   - **Merge Queue:** GitHub native merge queue + auto-merge (`gh pr merge --auto --squash`)
   - **Comparison table:** Graphite → GitHub-native equivalents (from brief)
   - **Error handling:** What to do when retargeting fails, merge conflicts, etc.
3. Validate: `bash scripts/validate-frontmatter.sh skills/synthesis/` (if applicable, or manual review)

**Verification:**
- [ ] File exists at correct path
- [ ] All 7 sections present
- [ ] No Graphite references (except in comparison table "was → now" format)

**testingStrategy:** `{ exampleTests: false, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes

---

### Task 8: Create validate-pr-stack.sh (replaces reconstruct-stack.sh)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test script: `scripts/validate-pr-stack.test.sh`
   - Test cases:
     - `validate_pr_stack_NoArgs_ExitsWithUsageError` (exit 2)
     - `validate_pr_stack_NoPRs_ExitsClean` (exit 0)
     - `validate_pr_stack_HealthyChain_ExitsClean` (exit 0)
     - `validate_pr_stack_BrokenChain_ExitsWithError` (exit 1)
   - Expected failure: script doesn't exist
   - Run: `bash scripts/validate-pr-stack.test.sh` - MUST FAIL

2. [GREEN] Implement `scripts/validate-pr-stack.sh`:
   - Pattern: `set -euo pipefail`
   - Uses `gh pr list --json number,baseRefName,headRefName,state` to discover PR chain
   - Validates each PR's base branch matches the previous PR's head branch
   - Exit 0: chain is healthy
   - Exit 1: chain has gaps or mismatched bases
   - Exit 2: usage error
   - Run: `bash scripts/validate-pr-stack.test.sh` - MUST PASS

3. [REFACTOR] Remove `scripts/reconstruct-stack.sh` (Graphite-specific)

**Verification:**
- [ ] Test script fails before implementation
- [ ] Test script passes after implementation
- [ ] reconstruct-stack.sh deleted
- [ ] validate-pr-stack.sh follows `set -euo pipefail` pattern

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes

---

### Worktree 3: Skills & Commands Content

> **Branch:** `refactor/remove-graphite-skills-content`
> **Dependencies:** None (parallel with worktrees 1-2; references github-native-stacking.md by path)

---

### Task 9: Update synthesis skill (frontmatter + body + references)

**Phase:** Content update

**Steps:**
1. Update `skills/synthesis/SKILL.md`:
   - Frontmatter `description`: Remove "Graphite stacked PRs" → "GitHub-native stacked PRs"
   - Body: Replace all `mcp__graphite__run_gt_cmd` → `gh` CLI equivalents
   - Replace `gt submit --no-interactive --publish --merge-when-ready` → `gh pr create --base <base> --title "..." --body "..."`
   - Add reference link to `references/github-native-stacking.md`
2. Update `skills/synthesis/references/synthesis-steps.md`:
   - Replace all Graphite MCP calls with `gh` CLI commands
   - Replace `gt log` → `gh pr list --json number,baseRefName,headRefName`
   - Replace `gt sync` → `git fetch --prune`
3. Update `skills/synthesis/references/troubleshooting.md`:
   - Replace `gt modify` → `git commit --amend` + `git push --force-with-lease`
   - Replace `gt submit` → `gh pr create` or `gh pr edit`
   - Replace `gt log` → `gh pr list`
4. Validate: `bash scripts/validate-frontmatter.sh skills/synthesis/`

**Verification:**
- [ ] `grep -ri 'graphite\|gt submit\|gt create\|gt log\|gt modify\|mcp__graphite' skills/synthesis/` returns nothing
- [ ] Frontmatter validation passes
- [ ] Description under 1024 chars, includes trigger phrases

**testingStrategy:** `{ exampleTests: false, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes (within worktree 3)

---

### Task 10: Update delegation implementer prompt

**Phase:** Content update

**Steps:**
1. Update `skills/delegation/references/implementer-prompt.md`:
   - Replace "## Commit Strategy" section entirely:
     - `gt create <branch> -m "feat: ..."` → `git commit -m "feat: ..."` + `git push -u origin <branch>`
     - `gt submit --no-interactive --publish --stack` → (no equivalent needed — PR creation handled by synthesis phase)
     - Remove "**IMPORTANT:** When using Graphite, never use `git commit` or `git push`" → Replace with "Use standard git commit + push. PR creation is handled during the synthesis phase."
   - Update "Graphite-First" bullet point → "Git-First" or remove

**Verification:**
- [ ] `grep -ri 'graphite\|gt create\|gt submit\|mcp__graphite' skills/delegation/` returns nothing
- [ ] Commit strategy section is coherent and actionable

**testingStrategy:** `{ exampleTests: false, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes (within worktree 3)

---

### Task 11: Update shepherd skill (frontmatter + references)

**Phase:** Content update

**Steps:**
1. Update `skills/shepherd/SKILL.md`:
   - Frontmatter `description`: Remove any Graphite references
   - Body: Replace Graphite references with GitHub-native equivalents
2. Update `skills/shepherd/references/fix-strategies.md`:
   - Replace `mcp__graphite__run_gt_cmd({ args: ["checkout", ...] })` → `git checkout <branch>`
   - Replace `mcp__graphite__run_gt_cmd({ args: ["modify", ...] })` → `git commit -m "fix: ..."` + `git push`
   - Replace `mcp__graphite__run_gt_cmd({ args: ["submit", ...] })` → remove (PR already exists)
3. Update `skills/shepherd/references/assess-checklist.md`:
   - Replace `mcp__graphite__run_gt_cmd({ args: ["log"] })` → `gh pr list --json number,baseRefName,headRefName`
   - Remove Graphite agent inline comment references
4. Validate frontmatter

**Verification:**
- [ ] `grep -ri 'graphite\|mcp__graphite' skills/shepherd/` returns nothing
- [ ] Frontmatter validation passes

**testingStrategy:** `{ exampleTests: false, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes (within worktree 3)

---

### Task 12: Update remaining skills and commands

**Phase:** Content update

**Steps:**
1. `skills/refactor/phases/polish-implement.md`:
   - Replace `gt create` → `git commit` + `git push`
   - Replace `gt submit` → remove or replace with `gh pr create`
   - Remove "NEVER use git commit or git push" warning
2. `skills/debug/references/thorough-track.md`:
   - Replace `mcp__graphite__run_gt_cmd` calls → `git commit` + `git push` + `gh pr create`
3. `skills/sync-schemas/references/configuration.md`:
   - Replace `gt create` → `git commit` + `git push`
   - Replace `gt submit` → `gh pr create`
   - Remove "NEVER use git commit or git push" warning
4. `skills/workflow-state/references/mcp-tool-reference.md`:
   - Remove entire "Graphite MCP" section (lines 68-86)
   - Update key commands table
5. `commands/synthesize.md`:
   - Replace `mcp__graphite__run_gt_cmd` invocation → `gh pr create --base <base> --title "..." --body "..."`
   - Replace "NEVER use gh pr create" → make `gh pr create` the standard
   - Replace `gt modify` → `git commit` + `git push`
   - Remove "NEVER use git commit or git push" warnings

**Verification:**
- [ ] `grep -ri 'graphite\|gt submit\|gt create\|gt log\|gt modify\|mcp__graphite' skills/ commands/` returns nothing (except github-native-stacking.md comparison table)

**testingStrategy:** `{ exampleTests: false, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes (within worktree 3)

---

### Worktree 4: Rules, Docs, Scripts, Memory

> **Branch:** `refactor/remove-graphite-rules-docs`
> **Dependencies:** None (parallel with worktrees 1-3)

---

### Task 13: Update CLAUDE.md and rules

**Phase:** Content update

**Steps:**
1. `CLAUDE.md`:
   - Line 9: "Core plugin — Exarchos MCP server + Graphite integration" → "Core plugin — Exarchos MCP server + GitHub integration"
   - Line 73: "Graphite MCP (`gt submit ...`), never `gh pr create`" → "GitHub CLI (`gh pr create --base <base> ...`)"
2. `rules/mcp-tool-guidance.md`:
   - Line 11: Replace Graphite PR creation rule → "**PR creation** — `gh pr create --base <base-branch>`, use `--body` for PR descriptions"
3. `companion/rules/mcp-tool-guidance.md`:
   - Same change as rules/mcp-tool-guidance.md

**Verification:**
- [ ] `grep -ri 'graphite\|gt submit\|gt create\|mcp__graphite' CLAUDE.md rules/ companion/rules/` returns nothing

**testingStrategy:** `{ exampleTests: false, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes (within worktree 4)

---

### Task 14: Update distributed-sdlc-pipeline.md architecture diagram

**Phase:** Content update

**Steps:**
1. `docs/adrs/distributed-sdlc-pipeline.md`:
   - Update Mermaid diagram (section 3): Remove `Graphite["Graphite MCP"]` box and its connections
   - Replace with `GitHub["GitHub CLI (gh)"]` or simply remove (PR operations go through regular git + gh)
   - Update component table: Remove "Graphite MCP" row, add "GitHub CLI" row
   - Update section 13 (Skill Integration) if it references Graphite MCP tools
   - Search and replace remaining Graphite references throughout the doc

**Verification:**
- [ ] Mermaid diagram renders without Graphite box
- [ ] No orphaned Graphite references in the ADR

**testingStrategy:** `{ exampleTests: false, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes (within worktree 4)

---

### Task 15: Update scripts (validate-pr-body.sh, check-pr-comments.test.sh)

**Phase:** Content update

**Steps:**
1. `scripts/validate-pr-body.sh`:
   - Lines 99-100: Update or remove the "Graphite merge queue" skip condition
   - Consider whether GitHub merge queue PRs need similar treatment
2. `scripts/check-pr-comments.test.sh`:
   - Line 116: Update test fixture — "graphite-app[bot]" may no longer be a reviewer
   - Decide: keep as a valid external reviewer or remove

**Verification:**
- [ ] `bash scripts/validate-pr-body.sh` test suite passes (if co-located .test.sh exists)
- [ ] `grep -ri graphite scripts/` returns nothing

**testingStrategy:** `{ exampleTests: false, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes (within worktree 4)

---

### Task 16: Update MEMORY.md and package metadata

**Phase:** Content update

**Steps:**
1. Memory file at `~/.claude/projects/-home-reedsalus-Documents-code-lvlup-sw-exarchos/memory/MEMORY.md`:
   - Remove "Delegation: Always Use Graphite" section (lines 3-11)
   - Remove "Graphite Stack for Synthesis" section (lines 13-16)
   - Remove "Merging Graphite Stacks — Use Merge Queue" section (lines 18-23)
   - Remove "Graphite Bypass Configuration — CRITICAL" section (lines 25-30)
   - Add new section: "PR Operations: GitHub-Native" with:
     - Standard commit: `git commit` + `git push`
     - PR creation: `gh pr create --base <base-branch>`
     - Stacked PRs: Chain --base targeting, bottom-up merge, auto-retarget
     - Merge queue: GitHub native merge queue + auto-merge

**Verification:**
- [ ] `grep -ri graphite` on memory file returns nothing
- [ ] New GitHub-native section is present and coherent

**testingStrategy:** `{ exampleTests: false, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes (within worktree 4)

---

## Parallelization Strategy

```
Worktree 1 (MCP Server)  ──────┐
  T1 → T2 → T3 ┐              │
  T4            ├→ T5 → T6    │
                │              │
Worktree 2 (Reference+Script) ─┤── All merge to feature branch
  T7                           │
  T8                           │
                               │
Worktree 3 (Skills Content) ───┤
  T9, T10, T11, T12 (parallel) │
                               │
Worktree 4 (Rules/Docs/Memory) ┘
  T13, T14, T15, T16 (parallel)
```

**All 4 worktrees run in parallel.** Within each worktree:
- Worktree 1: T1→T2 sequential (manifest before installer), T3-T5 parallel, T6 last (integration check)
- Worktrees 2-4: All tasks within each are independent and can be done sequentially by the agent

## Deferred Items

| Item | Rationale |
|---|---|
| GitHub Actions for automatic restack | Out of scope per brief — would require CI infrastructure changes |
| Full stack management CLI replacement | Out of scope — gh CLI + git is sufficient |
| Graphite bypass configuration cleanup | Can be done separately on each repo's GitHub settings — not a code change |

## Completion Checklist
- [ ] All tests written before implementation (Tasks 1-6, 8)
- [ ] All tests pass (`npm run test:run`)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Zero Graphite references across entire codebase (verified by grep)
- [ ] Skill frontmatter validation passes
- [ ] New github-native-stacking.md reference exists
- [ ] New validate-pr-stack.sh script exists and passes tests
- [ ] Ready for review
