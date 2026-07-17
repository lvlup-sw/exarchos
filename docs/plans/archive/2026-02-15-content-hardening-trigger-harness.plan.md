# Implementation Plan: Content Hardening & Trigger Test Harness

## Source Design
Link: `docs/designs/2026-02-15-content-hardening-trigger-harness.md`

## Scope
**Target:** Full design
**Excluded:** None — all three deliverables (consistency sweep, trigger harness, post-install verification) are in scope.

## Summary
- Total tasks: 10
- Parallel groups: 2 (Group A: validation infra + trigger harness, Group B: content updates)
- Estimated test count: 46+ (10 frontmatter fixture tests + 36 trigger fixture cases)
- Design coverage: All 8 Technical Design subsections covered

## Spec Traceability

| Design Section | Key Requirements | Task ID(s) | Status |
|---|---|---|---|
| 1.1 Negative Triggers | `check_negative_trigger` validation + 11 skill description updates | T1, T7 | Covered |
| 1.2 Performance Notes | `## Performance Notes` sections in 5 MCP-heavy skills | T8 | Covered |
| 1.3 Cross-Reference Verification | `check_no_orphan_references` + orphan fixture | T2, T3 | Covered |
| 2.1 Architecture | `skills/trigger-tests/` directory structure | T5 | Covered |
| 2.2 Fixture Format | `fixtures.jsonl` with 36+ cases (3/skill) | T4 | Covered |
| 2.3 Static Trigger Validation | `run-trigger-tests.sh` runner | T5 | Covered |
| 2.4 Eval Framework Integration | JSONL format compatible with eval datasets | T4 | Covered |
| 3 Post-Install Verification | `validate-installation.sh` | T9 | Covered |
| Changes > Test Fixtures | `no-negative-trigger` + `orphan-reference` fixtures | T1, T3 | Covered |
| Testing Strategy > Full Suite | Run all validators against repo skills | T10 | Covered |

---

## Task Breakdown

### Task T1: Add `check_negative_trigger` to validator + fixture

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**
1. [RED] Create test fixture that lacks negative triggers
   - File: `skills/test-fixtures/no-negative-trigger/SKILL.md`
   - Content: Valid frontmatter with description that has no `Do NOT` / `Not for` phrase
   - Run: `bash skills/validate-frontmatter.sh skills/test-fixtures/no-negative-trigger/SKILL.md no-negative-trigger`
   - Expected: Exit 0 (passes — check doesn't exist yet, this is the gap)

2. [GREEN] Add `check_negative_trigger` function to validator
   - File: `skills/validate-frontmatter.sh`
   - Add function that greps description for `Do NOT` or `Not for` (case-insensitive)
   - Call it from main block
   - Run: `bash skills/validate-frontmatter.sh skills/test-fixtures/no-negative-trigger/SKILL.md no-negative-trigger`
   - Expected: Exit 1 (correctly catches missing negative trigger)

3. [GREEN] Add test case to fixture runner
   - File: `skills/validate-frontmatter.test.sh`
   - Add: `run_test "MissingNegativeTrigger_NoDoNot_Fails" 1 "${FIXTURES}/no-negative-trigger"`
   - Run: `bash skills/validate-frontmatter.test.sh`
   - Expected: All tests pass (including new case)

4. [GREEN] Verify existing valid fixture still passes
   - Run: `bash skills/validate-frontmatter.sh skills/test-fixtures/valid-skill/SKILL.md valid-skill`
   - Expected: Exit 0 — but only if valid-skill fixture has a negative trigger
   - If not, update `skills/test-fixtures/valid-skill/SKILL.md` to include one

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task T2: Update valid-skill fixture for negative trigger compliance

**Phase:** GREEN

**TDD Steps:**
1. [GREEN] Add negative trigger to the valid-skill fixture
   - File: `skills/test-fixtures/valid-skill/SKILL.md`
   - Add `Do NOT use for unrelated tasks.` to the description field
   - Run: `bash skills/validate-frontmatter.test.sh`
   - Expected: All 9 tests pass (8 existing + 1 new from T1)

**Dependencies:** T1
**Parallelizable:** No (sequential after T1)

---

### Task T3: Add `check_no_orphan_references` to validator + fixture

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**
1. [RED] Create test fixture with orphan reference file
   - File: `skills/test-fixtures/orphan-reference/SKILL.md`
   - Content: Valid frontmatter, body mentions `references/used.md` but not `references/orphan.md`
   - File: `skills/test-fixtures/orphan-reference/references/used.md` (empty content file)
   - File: `skills/test-fixtures/orphan-reference/references/orphan.md` (unreferenced file)
   - Run: `bash skills/validate-frontmatter.sh skills/test-fixtures/orphan-reference/SKILL.md orphan-reference`
   - Expected: Exit 0 (passes — orphan check doesn't exist yet)

2. [GREEN] Add `check_no_orphan_references` function to validator
   - File: `skills/validate-frontmatter.sh`
   - Iterate `references/*.md` files, grep BODY for each filename
   - Only check `.md` files (exclude `.sh`, `.json` per design open question #3)
   - Call from main block
   - Run: `bash skills/validate-frontmatter.sh skills/test-fixtures/orphan-reference/SKILL.md orphan-reference`
   - Expected: Exit 1 (correctly catches orphan `references/orphan.md`)

3. [GREEN] Add test case to fixture runner
   - File: `skills/validate-frontmatter.test.sh`
   - Add: `run_test "OrphanReference_UnreferencedFile_Fails" 1 "${FIXTURES}/orphan-reference"`
   - Run: `bash skills/validate-frontmatter.test.sh`
   - Expected: All 10 tests pass

**Dependencies:** None
**Parallelizable:** Yes (Group A, parallel with T1)

---

### Task T4: Create trigger test fixtures

**Phase:** RED -> GREEN

**TDD Steps:**
1. [RED] Create `fixtures.jsonl` with 36 test cases (3 per skill x 12 skills)
   - File: `skills/trigger-tests/fixtures.jsonl`
   - Each skill gets: 1 `obvious` trigger, 1 `paraphrased` trigger, 1 `no-trigger` (unrelated)
   - Source obvious triggers from each skill's `## Triggers` section and `description` field
   - Write paraphrased variants manually
   - Write unrelated prompts that should NOT trigger each skill
   - Format: `{"skill": "...", "phrase": "...", "expected": "trigger|no-trigger", "tags": ["obvious|paraphrased|unrelated"]}`

2. [GREEN] Validate JSONL format
   - Run: `jq -e '.' skills/trigger-tests/fixtures.jsonl > /dev/null` (each line must be valid JSON)
   - Run: `jq -r '.skill' skills/trigger-tests/fixtures.jsonl | sort -u | wc -l` (should be 12 — all skills)
   - Expected: 12 unique skills, 36+ valid JSON lines

**Fixture cases by skill (sourced from `## Triggers` sections):**

| Skill | Obvious Trigger | Paraphrased | Unrelated (no-trigger) |
|---|---|---|---|
| brainstorming | `let's brainstorm` | `explore design options` | `fix the login bug` |
| implementation-planning | `plan implementation` | `break down the design` | `review code quality` |
| delegation | `delegate tasks` | `dispatch implementation work` | `create a worktree` |
| quality-review | `review code` | `check code quality` | `brainstorm a feature` |
| spec-review | `review plan` | `check spec coverage` | `debug the crash` |
| synthesis | `create PR` | `synthesize the branch` | `plan the sprint` |
| debug | `debug this issue` | `investigate the regression` | `refactor the module` |
| refactor | `refactor this code` | `clean up the module` | `add a new feature` |
| workflow-state | `save progress` | `checkpoint the workflow` | `review the PR` |
| git-worktrees | `create worktree` | `set up parallel workspace` | `sync schemas` |
| dotnet-standards | `check .NET standards` | `validate C# conventions` | `write TypeScript tests` |
| sync-schemas | `sync schemas` | `update types from API` | `deploy to staging` |

**Dependencies:** None
**Parallelizable:** Yes (Group A, parallel with T1/T3)

---

### Task T5: Create trigger test runner

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**
1. [RED] Create runner script skeleton
   - File: `skills/trigger-tests/run-trigger-tests.sh`
   - Implement the runner per design section 2.3
   - Reads `fixtures.jsonl`, extracts descriptions from SKILL.md frontmatter, validates matches
   - Run: `bash skills/trigger-tests/run-trigger-tests.sh`
   - Expected: Failures — most skills currently lack negative triggers

2. [GREEN] Verify runner correctly identifies passing cases
   - Run against brainstorming (already has negative trigger): should pass its 3 cases
   - Run against implementation-planning (already has negative trigger per repo): should pass
   - Expected: At least 2 skills fully pass, others fail on `no-trigger` check

3. [REFACTOR] Add coverage check
   - Runner verifies every skill in the fixtures has at least 2 `trigger` and 1 `no-trigger` case
   - If a skill is missing minimum coverage, report as WARN (not FAIL)

**Dependencies:** T4 (needs fixtures)
**Parallelizable:** No (sequential after T4)

---

### Task T6: Run trigger tests — baseline failure snapshot

**Phase:** RED (intentional — establishes the baseline)

**TDD Steps:**
1. [RED] Run trigger tests against current repo skills
   - Run: `bash skills/trigger-tests/run-trigger-tests.sh skills/trigger-tests/fixtures.jsonl skills`
   - Expected: Failures for skills missing negative triggers
   - Record baseline: which skills pass, which fail, and why
   - This snapshot becomes the "before" measurement for the consistency sweep

**Dependencies:** T5
**Parallelizable:** No (sequential after T5)

---

### Task T7: Add negative triggers to 11 skill descriptions

**Phase:** RED -> GREEN

**TDD Steps:**
1. [RED] Verify current skills fail the negative trigger check
   - Run: `for skill in skills/*/SKILL.md; do bash skills/validate-frontmatter.sh "$skill" "$(basename "$(dirname "$skill")")"; done`
   - Expected: Multiple failures for `check_negative_trigger`

2. [GREEN] Update each skill's `description` field with negative trigger
   - Files (11 skills — brainstorming already compliant):
     - `skills/implementation-planning/SKILL.md` — (verify; may already have one from repo)
     - `skills/delegation/SKILL.md`
     - `skills/quality-review/SKILL.md`
     - `skills/spec-review/SKILL.md`
     - `skills/synthesis/SKILL.md`
     - `skills/debug/SKILL.md`
     - `skills/refactor/SKILL.md`
     - `skills/workflow-state/SKILL.md`
     - `skills/git-worktrees/SKILL.md`
     - `skills/dotnet-standards/SKILL.md`
     - `skills/sync-schemas/SKILL.md`
   - Use exact negative triggers from design section 1.1 table
   - Ensure description stays under 1,024 characters

3. [GREEN] Verify all skills pass frontmatter validation
   - Run: `for skill in skills/*/SKILL.md; do bash skills/validate-frontmatter.sh "$skill" "$(basename "$(dirname "$skill")")"; done`
   - Expected: All exit 0

4. [GREEN] Re-run trigger tests
   - Run: `bash skills/trigger-tests/run-trigger-tests.sh`
   - Expected: All `no-trigger` cases now pass (negative triggers present)

**Dependencies:** T1, T2 (validator must have `check_negative_trigger`), T5 (trigger runner must exist)
**Parallelizable:** Yes (Group B — content updates)

---

### Task T8: Add performance notes to 5 MCP-heavy skills

**Phase:** GREEN

**TDD Steps:**
1. [GREEN] Add `## Performance Notes` section to each skill
   - Files:
     - `skills/delegation/SKILL.md` — "Verify each task dispatch before proceeding to next. Do not batch dispatches without confirming worktree readiness."
     - `skills/quality-review/SKILL.md` — "Read each checklist file completely before scoring. Do not skip security or SOLID checks even for small changes."
     - `skills/synthesis/SKILL.md` — "Verify all tests pass before creating PR. Do not skip the pre-submit validation step."
     - `skills/debug/SKILL.md` — "Complete each investigation step before concluding root cause. Do not jump to fix without evidence."
     - `skills/implementation-planning/SKILL.md` — "Trace every design section to at least one task. Do not leave uncovered sections without explicit rationale."
   - Each section follows the format from design section 1.2:
     ```markdown
     ## Performance Notes

     - Complete each step fully before advancing — quality over speed
     - Do not skip validation checks even when the change appears trivial
     - [Skill-specific directive]
     ```

2. [GREEN] Verify word counts still within limit
   - Run: `for skill in delegation quality-review synthesis debug implementation-planning; do bash skills/validate-frontmatter.sh "skills/${skill}/SKILL.md" "$skill"; done`
   - Expected: All exit 0 (body <= 2,000 words)

**Dependencies:** None (can run in parallel with T7)
**Parallelizable:** Yes (Group B — content updates, parallel with T7)

---

### Task T9: Create post-install verification script

**Phase:** RED -> GREEN

**TDD Steps:**
1. [RED] Create `validate-installation.sh`
   - File: `skills/validate-installation.sh`
   - Accepts target skills directory as argument (default: `~/.claude/skills`)
   - For each skill subdirectory:
     - Verify `SKILL.md` exists
     - Run `validate-frontmatter.sh` against it
     - If repo skills have `references/`, verify installed copy also has `references/` with matching file count
   - Exit 0 if all pass, exit 1 with error list otherwise

2. [GREEN] Run against repo skills directory (should pass)
   - Run: `bash skills/validate-installation.sh skills`
   - Expected: Exit 0 — repo skills are the source of truth

3. [GREEN] Run against installed skills (expect failures until re-install)
   - Run: `bash skills/validate-installation.sh ~/.claude/skills`
   - Expected: Exit 1 — installed versions are stale (no frontmatter, missing references/)
   - This confirms the deployment gap documented in the design

**Dependencies:** T1, T3 (validator must have all checks)
**Parallelizable:** No (needs all validator changes)

---

### Task T10: Full validation suite run + commit

**Phase:** GREEN -> REFACTOR

**TDD Steps:**
1. [GREEN] Run all validation tests
   - Run: `bash skills/validate-frontmatter.test.sh` — all 10 fixture tests pass
   - Run: `bash skills/trigger-tests/run-trigger-tests.sh` — all 36+ trigger tests pass
   - Run: `bash skills/validate-installation.sh skills` — repo validation passes
   - Expected: Zero failures across all three suites

2. [REFACTOR] Review all changes holistically
   - Verify no skill's description exceeds 1,024 characters
   - Verify no skill's body exceeds 2,000 words
   - Verify negative triggers are specific (not generic "Do NOT use inappropriately")
   - Verify performance notes are actionable (not vague platitudes)

3. [GREEN] Commit all changes
   - Stage: all modified SKILL.md files, validation scripts, test fixtures, trigger tests
   - Message describes the content hardening pass

**Dependencies:** T1-T9 (everything must pass)
**Parallelizable:** No (final integration)

---

## Parallelization Strategy

```
Group A (validation + trigger infra)          Group B (content updates)
──────────────────────────────────            ────────────────────────
T1: check_negative_trigger ──┐
T2: update valid fixture ────┤
T3: check_no_orphan_refs ────┤
T4: trigger fixtures ────────┤                T7: negative triggers (11 skills) ─┐
T5: trigger runner ──────────┤                T8: performance notes (5 skills) ──┤
T6: baseline snapshot ───────┘                                                   │
         │                                              │
         └──────────── T9: validate-installation.sh ────┘
                              │
                         T10: full suite run
```

**Group A** (T1-T6): Validation infrastructure and trigger harness. Sequential within group (each builds on prior). No content changes — safe for one worktree.

**Group B** (T7-T8): Content updates to SKILL.md files. Parallel within group (negative triggers and performance notes are independent sections). Depends on Group A for validation but can start once T1 and T5 are complete.

**Recommended execution:** Two worktrees.
- Worktree 1: T1 -> T2 -> T3 -> T4 -> T5 -> T6
- Worktree 2: T7 + T8 (start after T1 and T5 complete in worktree 1)
- Main: T9 -> T10 (after both worktrees merge)

---

## Deferred Items

| Item | Rationale |
|---|---|
| `allowed-tools` frontmatter field | Per user decision — skipping Gap 3 |
| LLM-based paraphrased trigger testing | Deferred to SDLC Eval Framework (design §2.4) |
| Installer re-run to deploy | Operational step after code changes merge — not a code task |
| CI workflow for trigger tests | Deferred to eval framework CI pipeline (design §2.4) |

---

## Completion Checklist
- [ ] `validate-frontmatter.sh` extended with 2 new checks
- [ ] 2 new test fixtures created and passing
- [ ] `trigger-tests/fixtures.jsonl` with 36+ cases
- [ ] `trigger-tests/run-trigger-tests.sh` runner passing
- [ ] All 12 skills have negative triggers in description
- [ ] 5 MCP-heavy skills have `## Performance Notes` sections
- [ ] `validate-installation.sh` passes against repo skills
- [ ] All test suites green
- [ ] Ready for review
