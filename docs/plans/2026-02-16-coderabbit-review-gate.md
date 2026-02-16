# Implementation Plan: CodeRabbit Review Gate

## Source Design

Link: `docs/designs/2026-02-16-coderabbit-review-gate.md`

## Scope

**Target:** Full design
**Excluded:** None

## Summary

- Total tasks: 8
- Parallel groups: 3
- Estimated test count: ~22 assertions
- Design coverage: 8/8 sections covered

## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Technical Design > Decision Logic | Round counting, thread classification, action decision | 2, 3, 5 | Covered |
| Technical Design > Severity Detection | Parse severity markers from thread bodies | 3 | Covered |
| Technical Design > Components > Script | Argument parsing, usage, exit codes | 1 | Covered |
| Technical Design > Components > Script | GraphQL queries (reviews, threads) | 2, 3 | Covered |
| Technical Design > Components > Script | Auto-resolve outdated threads | 4 | Covered |
| Technical Design > Components > Script | Comment on PR (approve/escalate) | 6 | Covered |
| Technical Design > Components > Test | Mock gh CLI, full decision matrix | 1-6 | Covered |
| Technical Design > Components > Workflow | GitHub Actions workflow YAML | 7 | Covered |
| Integration Points > Synthesis Skill | Update synthesis references | 8 | Covered |
| Testing Strategy > Unit Tests | 9-row decision matrix | 5 | Covered |
| Testing Strategy > Integration Test | Workflow references script | 7, 8 | Covered |
| Edge Cases | Restacking, rate limiting, false positives | 5 (cap test) | Covered |
| Open Questions | Q1-Q3 deferred to implementation | — | Deferred: verified during implementation |

## Task Breakdown

### Task 1: Script skeleton and argument parsing

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests for argument parsing
   - File: `scripts/coderabbit-review-gate.test.sh`
   - Tests:
     - `MissingOwner_ExitsTwo` — no --owner flag
     - `MissingRepo_ExitsTwo` — no --repo flag
     - `MissingPR_ExitsTwo` — no --pr flag
     - `HelpFlag_ShowsUsage` — --help exits 0 with usage text
     - `ValidArgs_ExitsZero` — all required args with mock, exits 0
     - `DryRun_NoComment` — --dry-run flag suppresses PR comments
   - Expected failure: script does not exist
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST FAIL

2. [GREEN] Implement script skeleton
   - File: `scripts/coderabbit-review-gate.sh`
   - Changes: shebang, `set -euo pipefail`, argument parsing for `--owner`, `--repo`, `--pr`, `--dry-run`, `--max-rounds`, `--help`, usage function, dependency checks (gh, jq), mock-compatible `gh api graphql` wrapper, stub functions for each phase
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST PASS

3. [REFACTOR] Extract validation helpers
   - Apply: Reuse `validate_github_name` pattern from `check-coderabbit.sh`
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST STAY GREEN

**Dependencies:** None
**Parallelizable:** No (foundation for all others)

---

### Task 2: Review round counting

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests for round counting
   - File: `scripts/coderabbit-review-gate.test.sh`
   - Tests:
     - `CountRounds_OneReview_ReturnsOne` — single coderabbitai review
     - `CountRounds_ThreeReviews_ReturnsThree` — multiple reviews
     - `CountRounds_MixedReviewers_OnlyCountsCodeRabbit` — ignores non-CodeRabbit reviews
   - Expected failure: count function not implemented
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST FAIL

2. [GREEN] Implement `count_review_rounds`
   - File: `scripts/coderabbit-review-gate.sh`
   - Changes: GraphQL query for PR reviews, filter by `coderabbitai[bot]` author login, count with jq
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST PASS

3. [REFACTOR] n/a

**Dependencies:** Task 1
**Parallelizable:** Yes (with Tasks 3, 4 after Task 1)

---

### Task 3: Thread querying and severity classification

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests for thread querying and severity
   - File: `scripts/coderabbit-review-gate.test.sh`
   - Tests:
     - `GetThreads_NoThreads_ReturnsEmpty` — no review threads
     - `GetThreads_ResolvedExcluded` — resolved threads filtered out
     - `ClassifySeverity_CriticalMarker_ReturnsCritical` — `🔴 Critical` detected
     - `ClassifySeverity_MajorMarker_ReturnsMajor` — `🟠 Major` detected
     - `ClassifySeverity_MinorOnly_NoBlockers` — `🟡 Minor` does not block
   - Expected failure: thread/severity functions not implemented
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST FAIL

2. [GREEN] Implement `get_review_threads` and `has_blocking_findings`
   - File: `scripts/coderabbit-review-gate.sh`
   - Changes: GraphQL query for reviewThreads (id, isResolved, isOutdated, first comment body), jq filter for unresolved non-outdated threads, severity marker detection via jq string matching (`contains("🔴")` or `contains("🟠")`)
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST PASS

3. [REFACTOR] Extract severity patterns to variables
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST STAY GREEN

**Dependencies:** Task 1
**Parallelizable:** Yes (with Tasks 2, 4 after Task 1)

---

### Task 4: Auto-resolve outdated threads

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests for outdated thread resolution
   - File: `scripts/coderabbit-review-gate.test.sh`
   - Tests:
     - `ResolveOutdated_OutdatedThreads_CallsMutation` — outdated threads trigger resolve
     - `ResolveOutdated_NoOutdated_NoMutation` — no outdated threads, no mutation calls
   - Expected failure: resolve function not implemented
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST FAIL

2. [GREEN] Implement `resolve_outdated_threads`
   - File: `scripts/coderabbit-review-gate.sh`
   - Changes: Extract outdated thread IDs from thread query response, call `resolveReviewThread` GraphQL mutation for each, handle mutation errors gracefully (warn but don't fail)
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST PASS

3. [REFACTOR] n/a

**Dependencies:** Task 1
**Parallelizable:** Yes (with Tasks 2, 3 after Task 1)

---

### Task 5: Decision logic

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests for full decision matrix
   - File: `scripts/coderabbit-review-gate.test.sh`
   - Tests (from design matrix):
     - `Decision_Round1_NoThreads_Approve`
     - `Decision_Round1_HasFindings_Wait`
     - `Decision_Round1_MinorOnly_Wait`
     - `Decision_Round2_NoBlockers_Approve`
     - `Decision_Round2_MinorOnly_Approve`
     - `Decision_Round2_HasCritical_Wait`
     - `Decision_Round3_Clean_Approve`
     - `Decision_Round4_HasCritical_Escalate`
     - `Decision_Round4_Clean_Approve`
   - Expected failure: decision function not wired
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST FAIL

2. [GREEN] Implement `decide_action`
   - File: `scripts/coderabbit-review-gate.sh`
   - Changes: Function taking round count, active thread count, has-blockers flag. Returns `approve`, `wait`, or `escalate`. Wire into main flow: count rounds → get threads → resolve outdated → classify severity → decide
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST PASS

3. [REFACTOR] Simplify conditional chains
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST STAY GREEN

**Verification:**
- [ ] All 9 decision matrix rows pass
- [ ] Round 4 cap correctly escalates
- [ ] No false approvals on critical findings

**Dependencies:** Tasks 2, 3, 4
**Parallelizable:** No (integrates outputs of 2, 3, 4)

---

### Task 6: PR commenting and main orchestration

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests for comment posting
   - File: `scripts/coderabbit-review-gate.test.sh`
   - Tests:
     - `Comment_Approve_PostsApprovalRequest` — approve action posts correct comment
     - `Comment_Escalate_PostsHumanReviewNeeded` — escalate action posts escalation comment
     - `Comment_Wait_NoComment` — wait action posts nothing
     - `DryRun_Approve_NoComment` — --dry-run suppresses comment even on approve
   - Expected failure: comment function not implemented
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST FAIL

2. [GREEN] Implement `post_action_comment` and wire main flow
   - File: `scripts/coderabbit-review-gate.sh`
   - Changes: Function that posts appropriate comment via `gh api` REST (not GraphQL) based on decided action. Main function orchestrates: parse args → count rounds → get/resolve threads → classify → decide → comment. Structured markdown output to stdout showing round, action, and thread summary
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST PASS

3. [REFACTOR] Clean up output formatting
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST STAY GREEN

**Dependencies:** Task 5
**Parallelizable:** No (final script assembly)

---

### Task 7: GitHub Actions workflow

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write integration test for workflow file
   - File: `scripts/coderabbit-review-gate.test.sh` (append)
   - Tests:
     - `Workflow_FileExists` — `.github/workflows/coderabbit-review-gate.yml` exists
     - `Workflow_ReferencesScript` — YAML contains `scripts/coderabbit-review-gate.sh`
     - `Workflow_TriggersOnReview` — YAML contains `pull_request_review`
   - Expected failure: workflow file does not exist
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST FAIL

2. [GREEN] Create workflow file
   - File: `.github/workflows/coderabbit-review-gate.yml`
   - Changes: Trigger on `pull_request_review: [submitted]`, conditional on `coderabbitai[bot]`, checkout + run script with owner/repo/pr from event context, `permissions: pull-requests: write`
   - Run: `bash scripts/coderabbit-review-gate.test.sh` — MUST PASS

3. [REFACTOR] n/a

**Dependencies:** None (independent of script implementation)
**Parallelizable:** Yes (with Tasks 2, 3, 4)

---

### Task 8: Documentation and integration tests

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write integration tests
   - File: `scripts/validate-synthesis-skill.test.sh` (append)
   - Tests:
     - `ReviewGate_ScriptExists` — `scripts/coderabbit-review-gate.sh` is executable
     - `ReviewGate_TestExists` — `scripts/coderabbit-review-gate.test.sh` exists
     - `ReviewGate_WorkflowExists` — `.github/workflows/coderabbit-review-gate.yml` exists
   - Expected failure: tests reference non-existent integration checks
   - Run: `bash scripts/validate-synthesis-skill.test.sh` — MUST FAIL

2. [GREEN] Update documentation
   - File: `CLAUDE.md` — add review gate to scripts inventory
   - File: `docs/designs/2026-02-16-coderabbit-review-gate.md` — mark open questions resolved
   - Run: `bash scripts/validate-synthesis-skill.test.sh` — MUST PASS

3. [REFACTOR] n/a

**Dependencies:** Tasks 1-7
**Parallelizable:** No (final integration)

## Parallelization Strategy

```text
 Task 1 (skeleton + args)
   │
   ├──────────┬──────────┬──────────┐
   ▼          ▼          ▼          ▼
 Task 2    Task 3    Task 4    Task 7
 (rounds)  (threads) (resolve) (workflow)
   │          │          │
   └──────────┴──────────┘
              │
              ▼
          Task 5 (decision logic)
              │
              ▼
          Task 6 (commenting + main)
              │
              ▼
          Task 8 (docs + integration)
```

### Parallel Groups

- **Group A:** Task 1 (sequential first)
- **Group B:** Tasks 2, 3, 4, 7 (parallelizable after Task 1, separate worktrees)
- **Group C:** Tasks 5, 6, 8 (sequential, after Group B)

### Delegation Strategy

Given the dependency structure:

| Delegation | Tasks | Worktree |
|------------|-------|----------|
| Round 1 | Task 1 | Single worktree (foundation) |
| Round 2 | Tasks 2, 3, 4, 7 | 4 parallel worktrees |
| Round 3 | Tasks 5, 6, 8 | Sequential in single worktree |

## Deferred Items

| Item | Rationale |
|------|-----------|
| Open Q1: Approval comment format | Verify `@coderabbitai approve` vs `@coderabbitai review` during Task 6 implementation. Fall back to `@coderabbitai review` with approval text if approve command doesn't exist |
| Open Q2: GITHUB_TOKEN vs PAT | Test `resolveReviewThread` mutation with GITHUB_TOKEN during Task 4. If it fails, add documentation for PAT setup |
| Open Q3: Debouncing | Monitor after deployment. No implementation needed — 32 API calls is well within limits |

## Completion Checklist

- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Full decision matrix verified (9 rows)
- [ ] --dry-run mode works correctly
- [ ] GitHub Actions workflow triggers on CodeRabbit reviews
- [ ] Outdated threads auto-resolved
- [ ] Round 4 cap escalates to human
- [ ] Documentation updated
- [ ] Ready for review
