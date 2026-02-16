# Implementation Plan: Prose Validation Scripts (Issue #275)

## Source Design
Link: `docs/designs/2026-02-13-skills-content-modernization.md` §6 "Validation Scripts"
Issue: [#275 — audit: 28 prose validation steps need programmatic scripts](https://github.com/lvlup-sw/exarchos/issues/275)

## Scope

**Target:** Phases 2-5 of issue #275 (25 remaining prose validation steps across 8 skills)
**Excluded:**
- Phase 1 (synthesis scripts) — already complete
- Finding #24 (`code-metrics.sh` / jscpd) — LOW priority, deferred
- Finding #25 (`check-duplication.sh`) — LOW priority, deferred
- MCP server changes — out of scope per brief

## Summary
- Total tasks: 9
- Parallel groups: 2 (7 tasks parallel, then 2 sequential)
- Scripts to create: ~21
- Test files to create: ~21 script tests + ~7 skill integration tests
- Skills to update: 8

## Spec Traceability

### Traceability Matrix

| Issue Finding # | Script Name | Task ID | Risk | Status |
|-----------------|-------------|---------|------|--------|
| #3 | `post-delegation-check.sh` | 1 | HIGH | Planned |
| #10 | `setup-worktree.sh` | 1 | HIGH | Planned |
| #19 | `extract-fix-tasks.sh` | 1 | MEDIUM | Planned |
| #21 | `needs-schema-sync.sh` | 1 | MEDIUM | Planned |
| #11 | `verify-worktree.sh` | 2 | HIGH | Planned |
| #22 | `verify-worktree-baseline.sh` | 2 | MEDIUM | Planned |
| #8 | `review-verdict.sh` | 3 | HIGH | Planned |
| #16 | `static-analysis-gate.sh` | 3 | MEDIUM | Planned |
| #26 | `security-scan.sh` | 3 | LOW | Planned |
| #9 | `spec-coverage-check.sh` | 4 | HIGH | Planned |
| #12 | `verify-plan-coverage.sh` | 4 | MEDIUM | Planned |
| #13 | `generate-traceability.sh` | 4 | MEDIUM | Planned |
| #14 | `check-tdd-compliance.sh` | 4 | MEDIUM | Planned |
| #15 | `check-coverage-thresholds.sh` | 4 | MEDIUM | Planned |
| #4 | `assess-refactor-scope.sh` | 5 | HIGH | Planned |
| #5 | `check-polish-scope.sh` | 5 | HIGH | Planned |
| #17 | `validate-refactor.sh` | 5 | MEDIUM | Planned |
| #27 | `verify-doc-links.sh` | 5 | LOW | Planned |
| #6 | `investigation-timer.sh` | 6 | HIGH | Planned |
| #7 | `select-debug-track.sh` | 6 | HIGH | Planned |
| #18 | `debug-review-gate.sh` | 6 | MEDIUM | Planned |
| #23 | `verify-ideate-artifacts.sh` | 7 | LOW | Planned |
| #28 | `reconcile-state.sh` | 7 | LOW | Planned |
| #20 | `validate-dotnet-standards.sh` | 7 | MEDIUM | Planned |
| #24 | `code-metrics.sh` | — | LOW | Deferred: requires jscpd or AST tooling, low ROI |
| #25 | `check-duplication.sh` | — | LOW | Deferred: requires jscpd, low ROI |

## Established Patterns

All scripts follow the pattern from `pre-synthesis-check.sh`:

```bash
#!/usr/bin/env bash
# script-name.sh — One-line description
# Usage: script-name.sh --arg1 <val> [--optional-flag]
# Exit codes: 0=pass, 1=fail, 2=usage error
set -euo pipefail

# Colors, arg parsing, dependency checks, helper functions
# Main check functions with check_pass()/check_fail()
# Markdown-formatted output, exit with appropriate code
```

Test scripts follow `pre-synthesis-check.test.sh`:

```bash
#!/usr/bin/env bash
# script-name.test.sh — Tests for script-name.sh
set -euo pipefail
PASS=0; FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
# Temp dir fixtures, mock commands, assertions
# Summary with exit code
```

Skill integration tests follow `validate-synthesis-skill.test.sh`:

```bash
#!/usr/bin/env bash
# validate-<skill>-skill.test.sh — Verifies SKILL.md references scripts
# Asserts: script invocations present, prose checklists removed
```

---

## Task Breakdown

### Task 1: Delegation Skill Scripts

**Findings:** #3 (HIGH), #10 (HIGH), #19 (MEDIUM), #21 (MEDIUM)
**Branch:** `prose-scripts/delegation`

**Scripts to create:**

1. **`setup-worktree.sh`** (#10) — Atomic worktree creation with validation
   - Validates: `.worktrees/` gitignored, branch created, worktree added, npm install, baseline tests pass
   - Args: `--repo-root <path> --task-id <id> --task-name <name> [--base-branch main] [--skip-tests]`
   - Exit: 0=ready, 1=setup failed, 2=usage error

2. **`post-delegation-check.sh`** (#3) — Post-delegation result collection
   - Validates: per-worktree test runs pass, all tasks report completion, state file consistency
   - Args: `--state-file <path> --repo-root <path> [--skip-tests]`
   - Exit: 0=all pass, 1=failures detected, 2=usage error

3. **`extract-fix-tasks.sh`** (#19) — Parse review report into fix tasks
   - Validates: review findings parsed, mapped to worktrees by file ownership
   - Args: `--state-file <path> --review-report <path>`
   - Exit: 0=tasks extracted, 1=parse error, 2=usage error
   - Output: JSON array of fix tasks with file, line, worktree, description

4. **`needs-schema-sync.sh`** (#21) — Detect API file modifications requiring sync
   - Validates: git diff for patterns (`*Endpoints.cs`, `Models/*.cs`, `Requests/*.cs`, `Responses/*.cs`, `Dtos/*.cs`)
   - Args: `--repo-root <path> [--base-branch main] [--diff-file <path>]`
   - Exit: 0=no sync needed, 1=sync needed, 2=usage error

**TDD Steps:**

1. [RED] Write test files:
   - `scripts/setup-worktree.test.sh` — Mock git/npm, assert worktree creation, gitignore check, baseline test verification
   - `scripts/post-delegation-check.test.sh` — Mock state file with complete/incomplete tasks, assert per-worktree validation
   - `scripts/extract-fix-tasks.test.sh` — Mock review report JSON, assert task extraction and file-to-worktree mapping
   - `scripts/needs-schema-sync.test.sh` — Mock git diff output with/without API files, assert detection
   - Run: all tests MUST FAIL (scripts don't exist)

2. [GREEN] Implement each script following `pre-synthesis-check.sh` pattern:
   - Arg parsing with `--help`
   - Dependency checks (git, jq, npm)
   - Check functions with Markdown output
   - Proper exit codes

3. [REFACTOR] Update `skills/delegation/SKILL.md`:
   - Replace "Pre-Dispatch Checklist" prose (lines ~219-246) with `setup-worktree.sh` invocation
   - Replace "Collect Results" prose with `post-delegation-check.sh` invocation
   - Replace "Fix Mode Task Extraction" prose (lines ~308-373) with `extract-fix-tasks.sh` invocation
   - Replace "Schema Sync Auto-Detection" prose (lines ~138-169) with `needs-schema-sync.sh` invocation
   - Add exit code routing documentation for each script

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2: Git-Worktrees Skill Scripts

**Findings:** #11 (HIGH), #22 (MEDIUM)
**Branch:** `prose-scripts/git-worktrees`

**Scripts to create:**

1. **`verify-worktree.sh`** (#11) — Verify execution is inside a worktree
   - Validates: `pwd` contains `.worktrees/`
   - Args: `[--cwd <path>]` (defaults to `pwd`)
   - Exit: 0=in worktree, 1=not in worktree

2. **`verify-worktree-baseline.sh`** (#22) — Run baseline tests in worktree
   - Validates: project type detection (package.json / *.csproj / Cargo.toml), runs appropriate test command, reports pass/fail
   - Args: `--worktree-path <path> [--compare-main]`
   - Exit: 0=baseline pass, 1=baseline fail, 2=project type unknown

**TDD Steps:**

1. [RED] Write test files:
   - `scripts/verify-worktree.test.sh` — Test from inside/outside `.worktrees/` path, assert exit codes
   - `scripts/verify-worktree-baseline.test.sh` — Mock project directories, assert type detection, test command selection
   - Run: all tests MUST FAIL

2. [GREEN] Implement scripts:
   - `verify-worktree.sh` — Path check with clear error messaging
   - `verify-worktree-baseline.sh` — Project detection, test execution, comparison logic

3. [REFACTOR] Update `skills/git-worktrees/SKILL.md`:
   - Replace "Worktree Validation" section (lines ~193-243) with `verify-worktree.sh` invocation
   - Replace "Baseline Verification" section (lines ~96-117) with `verify-worktree-baseline.sh` invocation
   - Add exit code routing

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 3: Quality-Review Skill Scripts

**Findings:** #8 (HIGH), #16 (MEDIUM), #26 (LOW)
**Branch:** `prose-scripts/quality-review`

**Scripts to create:**

1. **`review-verdict.sh`** (#8) — Classify review findings into verdict
   - Validates: counts HIGH/MEDIUM/LOW findings, determines APPROVED/NEEDS_FIXES/BLOCKED
   - Args: `--findings-file <path>` or `--high <n> --medium <n> --low <n>`
   - Exit: 0=APPROVED, 1=NEEDS_FIXES, 2=BLOCKED
   - Output: Verdict with routing instructions (which skill to invoke next)

2. **`static-analysis-gate.sh`** (#16) — Run static analysis tools
   - Validates: `npm run lint`, `npm run typecheck`, `npm run quality-check` (if each exists)
   - Args: `--repo-root <path> [--skip-lint] [--skip-typecheck]`
   - Exit: 0=all pass, 1=errors found (distinguishes errors from warnings)
   - Output: Per-tool PASS/FAIL with error/warning counts

3. **`security-scan.sh`** (#26) — Scan for common security patterns
   - Validates: grep for secret patterns (hardcoded keys, `eval()`, SQL concatenation, `innerHTML`)
   - Args: `--diff-file <path>` or `--repo-root <path> --base-branch <branch>`
   - Exit: 0=no findings, 1=findings detected
   - Output: Finding list with file:line, pattern matched, severity

**TDD Steps:**

1. [RED] Write test files:
   - `scripts/review-verdict.test.sh` — Test all three verdict paths (0 HIGH→APPROVED, >0 HIGH→NEEDS_FIXES, blocking→BLOCKED)
   - `scripts/static-analysis-gate.test.sh` — Mock npm scripts, test missing commands handled, error vs warning distinction
   - `scripts/security-scan.test.sh` — Mock diff with known patterns, assert detection
   - Run: all tests MUST FAIL

2. [GREEN] Implement scripts

3. [REFACTOR] Update `skills/quality-review/SKILL.md`:
   - Replace "Step 1: Static Analysis" prose (lines ~81-90) with `static-analysis-gate.sh` invocation
   - Replace verdict determination prose (lines ~150-173) with `review-verdict.sh` invocation
   - Add `security-scan.sh` as optional Step 2.5 before manual walkthrough
   - Add exit code routing for verdict-based workflow transitions

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 4: Spec-Review & Planning Skill Scripts

**Findings:** #9 (HIGH), #12 (MEDIUM), #13 (MEDIUM), #14 (MEDIUM), #15 (MEDIUM)
**Branch:** `prose-scripts/planning`

**Scripts to create:**

1. **`spec-coverage-check.sh`** (#9) — Verify test files exist and pass for spec compliance
   - Validates: test files referenced in plan exist, tests pass, coverage thresholds met
   - Args: `--plan-file <path> --repo-root <path> [--threshold 80]`
   - Exit: 0=coverage met, 1=gaps found

2. **`verify-plan-coverage.sh`** (#12) — Cross-reference design sections to plan tasks
   - Validates: every Technical Design subsection maps to ≥1 task, no orphaned tasks
   - Args: `--design-file <path> --plan-file <path>`
   - Exit: 0=complete, 1=gaps found
   - Output: Coverage matrix (design section → task IDs)

3. **`generate-traceability.sh`** (#13) — Pre-populate traceability matrix from headers
   - Generates: Markdown traceability table by parsing design `##` headers and plan `### Task` headers
   - Args: `--design-file <path> --plan-file <path> [--output <path>]`
   - Exit: 0=generated, 1=parse error
   - Output: Markdown table to stdout or file

4. **`check-tdd-compliance.sh`** (#14) — Verify test-first git history
   - Validates: for each task branch, test file committed before implementation file
   - Args: `--repo-root <path> --branch <name> [--base-branch main]`
   - Exit: 0=compliant, 1=violations found
   - Output: Per-commit order analysis (test → impl → refactor)

5. **`check-coverage-thresholds.sh`** (#15) — Parse coverage output against thresholds
   - Validates: line/branch/function coverage against configurable thresholds (default 80/70/100%)
   - Args: `--coverage-file <path> [--line-threshold 80] [--branch-threshold 70] [--function-threshold 100]`
   - Exit: 0=thresholds met, 1=below threshold
   - Output: Coverage summary with pass/fail per metric

**TDD Steps:**

1. [RED] Write test files for each script with mock design docs, plan docs, and coverage output
   - Run: all tests MUST FAIL

2. [GREEN] Implement scripts

3. [REFACTOR] Update `skills/implementation-planning/SKILL.md`:
   - Replace "Step 1.5: Spec Tracing" prose with `verify-plan-coverage.sh` + `generate-traceability.sh` invocations
   - Replace "Step 5: Plan Verification" prose with `spec-coverage-check.sh` invocation
   - Add `check-tdd-compliance.sh` reference to TDD verification section
   - Add `check-coverage-thresholds.sh` reference to completion criteria

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 5: Refactor Skill Scripts

**Findings:** #4 (HIGH), #5 (HIGH), #17 (MEDIUM), #27 (LOW)
**Branch:** `prose-scripts/refactor`

**Scripts to create:**

1. **`assess-refactor-scope.sh`** (#4) — Assess scope and recommend track
   - Validates: file count, cross-module span, test coverage assessment
   - Args: `--files <file1,file2,...>` or `--state-file <path>`
   - Exit: 0=polish recommended, 1=overhaul recommended
   - Output: Scope assessment (file count, modules, coverage status, recommendation)

2. **`check-polish-scope.sh`** (#5) — Check if polish scope has expanded
   - Validates: file count >5, module boundaries crossed, coverage gaps, arch docs needed
   - Args: `--state-file <path> --repo-root <path>`
   - Exit: 0=scope OK, 1=scope expanded (switch to overhaul)
   - Output: Which expansion trigger fired

3. **`validate-refactor.sh`** (#17) — Run tests/lint/typecheck with structured output
   - Validates: `npm run test:run`, `npm run lint`, `npm run typecheck`
   - Args: `--repo-root <path> [--skip-lint] [--skip-typecheck]`
   - Exit: 0=all pass, 1=failures
   - Output: Structured pass/fail per check with error details

4. **`verify-doc-links.sh`** (#27) — Check internal doc links resolve
   - Validates: Markdown links (`[text](path)`) point to existing files, code examples reference valid paths
   - Args: `--doc-file <path>` or `--docs-dir <path>`
   - Exit: 0=all links valid, 1=broken links found
   - Output: Broken link list with file:line and target

**TDD Steps:**

1. [RED] Write test files with mock file lists, state files, and Markdown docs
   - Run: all tests MUST FAIL

2. [GREEN] Implement scripts

3. [REFACTOR] Update `skills/refactor/SKILL.md`:
   - Replace explore phase scope assessment prose (lines ~107-120) with `assess-refactor-scope.sh` invocation
   - Replace scope expansion triggers prose (lines ~400-411) with `check-polish-scope.sh` invocation
   - Replace validate phase prose (lines ~152-165) with `validate-refactor.sh` invocation
   - Add `verify-doc-links.sh` to doc update phase

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 6: Debug Skill Scripts

**Findings:** #6 (HIGH), #7 (HIGH), #18 (MEDIUM)
**Branch:** `prose-scripts/debug`

**Scripts to create:**

1. **`investigation-timer.sh`** (#6) — Enforce 15-minute investigation time-box
   - Validates: compares `startedAt` timestamp to current wall-clock
   - Args: `--started-at <ISO8601>` or `--state-file <path>` `[--budget-minutes 15]`
   - Exit: 0=within budget, 1=budget exceeded
   - Output: Elapsed time, remaining time, or escalation recommendation

2. **`select-debug-track.sh`** (#7) — Deterministic track selection
   - Validates: decision tree from urgency (critical/high/medium/low) + known-root-cause (yes/no)
   - Args: `--urgency <level> --root-cause-known <yes|no>` or `--state-file <path>`
   - Exit: 0=hotfix, 1=thorough
   - Output: Selected track with reasoning

3. **`debug-review-gate.sh`** (#18) — Verify fix has proper test coverage
   - Validates: new test files cover bug scenario, no regressions, test names follow convention
   - Args: `--repo-root <path> --base-branch <branch> [--state-file <path>]`
   - Exit: 0=review passed, 1=gaps found
   - Output: Test coverage for bug scenario, regression check results

**TDD Steps:**

1. [RED] Write test files:
   - `scripts/investigation-timer.test.sh` — Mock timestamps, test within/over budget
   - `scripts/select-debug-track.test.sh` — Test all urgency × root-cause combinations
   - `scripts/debug-review-gate.test.sh` — Mock git diff with test/no-test scenarios
   - Run: all tests MUST FAIL

2. [GREEN] Implement scripts

3. [REFACTOR] Update debug skill:
   - Read the debug skill file (`skills/debug/SKILL.md` or equivalent)
   - Replace hotfix track investigation prose with `investigation-timer.sh` invocation
   - Replace track selection prose with `select-debug-track.sh` invocation
   - Replace thorough track review prose with `debug-review-gate.sh` invocation

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 7: Brainstorming, Workflow-State & Dotnet-Standards Scripts

**Findings:** #23 (LOW), #28 (LOW), #20 (MEDIUM)
**Branch:** `prose-scripts/misc-skills`

**Scripts to create:**

1. **`verify-ideate-artifacts.sh`** (#23) — Check brainstorming completion
   - Validates: design doc exists at `docs/designs/`, has required sections (Problem, Approach, Technical Design, Integration Points, Testing Strategy, Open Questions), state file updated
   - Args: `--state-file <path> --docs-dir <path>`
   - Exit: 0=complete, 1=incomplete

2. **`reconcile-state.sh`** (#28) — Compare state file to git reality
   - Validates: worktrees listed in state actually exist, branches listed exist, task statuses match git evidence
   - Args: `--state-file <path> --repo-root <path>`
   - Exit: 0=consistent, 1=discrepancies found
   - Output: Discrepancy list (state says X, git says Y)

3. **`validate-dotnet-standards.sh`** (#20) — Check .NET project structure compliance
   - Validates: `Directory.Build.props` exists, `Directory.Packages.props` has CPM enabled, `.editorconfig` present, required XML elements exist
   - Args: `--project-root <path>`
   - Exit: 0=compliant, 1=violations found
   - Output: Compliance checklist with pass/fail per check

**TDD Steps:**

1. [RED] Write test files with mock state files, design docs, and .NET project structures
   - Run: all tests MUST FAIL

2. [GREEN] Implement scripts

3. [REFACTOR] Update skills:
   - `skills/brainstorming/SKILL.md` — Replace completion criteria prose with `verify-ideate-artifacts.sh` invocation
   - `skills/workflow-state/SKILL.md` — Add `reconcile-state.sh` to reconciliation section
   - `skills/dotnet-standards/SKILL.md` — Replace validation rules prose with `validate-dotnet-standards.sh` invocation

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 8: Skill Integration Tests

**Branch:** `prose-scripts/skill-tests`

**Tests to create** (following `validate-synthesis-skill.test.sh` pattern):

1. `scripts/validate-delegation-skill.test.sh` — Assert delegation SKILL.md references `setup-worktree.sh`, `post-delegation-check.sh`, `extract-fix-tasks.sh`, `needs-schema-sync.sh`; prose checklists removed
2. `scripts/validate-worktree-skill.test.sh` — Assert git-worktrees SKILL.md references `verify-worktree.sh`, `verify-worktree-baseline.sh`
3. `scripts/validate-quality-review-skill.test.sh` — Assert quality-review SKILL.md references `review-verdict.sh`, `static-analysis-gate.sh`, `security-scan.sh`
4. `scripts/validate-planning-skill.test.sh` — Assert implementation-planning SKILL.md references `verify-plan-coverage.sh`, `spec-coverage-check.sh`, etc.
5. `scripts/validate-refactor-skill.test.sh` — Assert refactor SKILL.md references `assess-refactor-scope.sh`, `check-polish-scope.sh`, `validate-refactor.sh`
6. `scripts/validate-debug-skill.test.sh` — Assert debug skill references `investigation-timer.sh`, `select-debug-track.sh`, `debug-review-gate.sh`
7. `scripts/validate-misc-skills.test.sh` — Assert brainstorming, workflow-state, dotnet-standards SKILL.md files reference their scripts

**TDD Steps:**

1. [RED] Write all 7 test files asserting script references and prose removal
   - Run: tests MUST FAIL (prose not yet removed from skills, or scripts not yet referenced — depends on Tasks 1-7 completion)

2. [GREEN] If any assertions still fail, fix SKILL.md references (missed during Tasks 1-7)

3. [REFACTOR] Ensure test assertions are comprehensive and consistent across all skill tests

**Verification:**
- [ ] Every updated SKILL.md has a corresponding integration test
- [ ] Every script created in Tasks 1-7 is asserted in an integration test
- [ ] No prose checklists remain in updated SKILL.md files

**Dependencies:** Tasks 1, 2, 3, 4, 5, 6, 7
**Parallelizable:** No (depends on all previous tasks)

---

### Task 9: Documentation Updates

**Branch:** `prose-scripts/docs`

**Files to update:**

1. **`CLAUDE.md`** — Add/update scripts section listing all new validation scripts with one-line descriptions
2. **`docs/designs/2026-02-13-skills-content-modernization.md`** — Update §6 "Validation Scripts" phase status to reflect Phases 2-5 completion

**TDD Steps:**

1. [RED] No formal tests — documentation-only task
2. [GREEN] Update both files with accurate script inventory and phase status
3. [REFACTOR] Verify all cross-references and links

**Dependencies:** Task 8
**Parallelizable:** No (final task)

---

## Parallelization Strategy

### Parallel Group 1 (Tasks 1-7)

All 7 tasks operate on different skills and create different scripts — fully parallelizable in separate worktrees.

```text
Task 1 (delegation)  ──┐
Task 2 (git-worktrees) ─┤
Task 3 (quality-review) ┤
Task 4 (planning)  ─────┤──→ Task 8 (integration tests) ──→ Task 9 (docs)
Task 5 (refactor)  ─────┤
Task 6 (debug)  ────────┤
Task 7 (misc skills)  ──┘
```

### Worktree Assignments

| Task | Worktree | Files Modified |
|------|----------|----------------|
| 1 | `.worktrees/prose-scripts-delegation` | `scripts/setup-worktree.*`, `scripts/post-delegation-check.*`, `scripts/extract-fix-tasks.*`, `scripts/needs-schema-sync.*`, `skills/delegation/SKILL.md` |
| 2 | `.worktrees/prose-scripts-git-worktrees` | `scripts/verify-worktree.*`, `scripts/verify-worktree-baseline.*`, `skills/git-worktrees/SKILL.md` |
| 3 | `.worktrees/prose-scripts-quality-review` | `scripts/review-verdict.*`, `scripts/static-analysis-gate.*`, `scripts/security-scan.*`, `skills/quality-review/SKILL.md` |
| 4 | `.worktrees/prose-scripts-planning` | `scripts/spec-coverage-check.*`, `scripts/verify-plan-coverage.*`, `scripts/generate-traceability.*`, `scripts/check-tdd-compliance.*`, `scripts/check-coverage-thresholds.*`, `skills/implementation-planning/SKILL.md` |
| 5 | `.worktrees/prose-scripts-refactor` | `scripts/assess-refactor-scope.*`, `scripts/check-polish-scope.*`, `scripts/validate-refactor.*`, `scripts/verify-doc-links.*`, `skills/refactor/SKILL.md` |
| 6 | `.worktrees/prose-scripts-debug` | `scripts/investigation-timer.*`, `scripts/select-debug-track.*`, `scripts/debug-review-gate.*`, debug skill file |
| 7 | `.worktrees/prose-scripts-misc` | `scripts/verify-ideate-artifacts.*`, `scripts/reconcile-state.*`, `scripts/validate-dotnet-standards.*`, `skills/brainstorming/SKILL.md`, `skills/workflow-state/SKILL.md`, `skills/dotnet-standards/SKILL.md` |
| 8 | `.worktrees/prose-scripts-skill-tests` | `scripts/validate-*-skill.test.sh` |
| 9 | main (or integration branch) | `CLAUDE.md`, `docs/designs/2026-02-13-skills-content-modernization.md` |

## Deferred Items

| Finding | Script | Reason |
|---------|--------|--------|
| #24 | `code-metrics.sh` | Requires external AST tooling (jscpd or equivalent); LOW risk; low ROI for current workflows |
| #25 | `check-duplication.sh` | Same as #24 — requires clone detection tooling not currently in the project |

## Completion Checklist
- [ ] All 21+ scripts created with `.test.sh` counterparts
- [ ] All tests pass (scripts + integration)
- [ ] 8 SKILL.md files updated to invoke scripts instead of prose checklists
- [ ] Integration tests verify script references and prose removal
- [ ] CLAUDE.md updated with script inventory
- [ ] Design doc updated with phase completion status
- [ ] Issue #275 Phases 2-5 acceptance criteria met
