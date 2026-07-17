# Design: Content Hardening & Trigger Test Harness

## Problem Statement

The skills-content-modernization design shipped YAML frontmatter, monolithic skill splitting, and references/ directories in the repo. But three gaps remain when measured against Anthropic's [Complete Guide to Building Skills for Claude](docs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf):

1. **Inconsistent descriptions** — Not all 12 skills include negative triggers in their `description` field. The guide explicitly recommends "Add negative triggers" to prevent over-firing (p. 25). Skills like brainstorming include `Do NOT use for implementation planning or code review`, but most don't.

2. **No trigger testing** — The guide identifies triggering tests as the first priority (p. 15): "Triggers on obvious tasks, Triggers on paraphrased requests, Doesn't trigger on unrelated topics." We have structural validation (`validate-frontmatter.sh`) but no trigger assertion infrastructure.

3. **No model laziness mitigation** — The guide recommends explicit performance notes (p. 26): "Take your time to do this thoroughly. Quality is more important than speed." Skills that coordinate MCP calls (delegation, synthesis, debug) are most vulnerable to lazy shortcuts but lack systematic performance directives.

Additionally, the modernized skills in the repo aren't deployed to `~/.claude/skills/` because the installer hasn't been re-run since content modernization shipped. The installer overhaul design's `copyDirectory` already handles recursive subdirectories — this is a deployment gap, not an infrastructure gap.

### Relationship to Existing Designs

| Design | Status | Relationship |
|---|---|---|
| Skills Content Modernization | Completed (repo) | This design hardens and validates what it produced |
| Installer Overhaul | In progress | Re-install deploys all modernized content |
| SDLC Eval Framework | Planned | Trigger harness graduates into its regression layer |
| Progressive Disclosure & Hooks | Completed | Phase guardrails complement trigger accuracy |

---

## Chosen Approach

**Three-part hardening pass:**

1. **Consistency sweep** — Update all 12 skill descriptions with negative triggers, add performance notes to MCP-heavy skills, verify all cross-references resolve.

2. **Trigger test harness** — Fixture-based shell tests that validate skill descriptions contain expected trigger phrases and exclude ambiguous terms. Designed to integrate with the eval framework as regression test cases.

3. **Post-install verification** — A validation script that runs after installation to confirm deployed skills match repo structure (frontmatter present, references/ intact, word limits respected).

---

## Technical Design

### 1. Consistency Sweep

#### 1.1 Negative Triggers for All Skills

Every `description` field gains a `Do NOT use for...` clause. The guide (p. 25) says: "Add negative triggers, be more specific" to prevent over-firing.

| Skill | Current Negative Trigger | Proposed Addition |
|---|---|---|
| brainstorming | `Do NOT use for implementation planning or code review.` | Already compliant |
| implementation-planning | None | `Do NOT use for brainstorming, debugging, or code review.` |
| delegation | None | `Do NOT use for single-file changes or polish-track refactors.` |
| quality-review | None | `Do NOT use for spec review (use spec-review) or brainstorming.` |
| spec-review | None | `Do NOT use for code quality review (use quality-review) or debugging.` |
| synthesis | None | `Do NOT use before review phase completes. Not for draft PRs.` |
| debug | None | `Do NOT use for feature development or planned refactoring.` |
| refactor | None | `Do NOT use for bug fixes (use debug) or new features (use ideate).` |
| workflow-state | None | `Do NOT use for workflow initialization (handled by ideate/debug/refactor commands).` |
| git-worktrees | None | `Do NOT use for branch creation without delegation context.` |
| dotnet-standards | None | `Do NOT use for TypeScript or non-.NET projects.` |
| sync-schemas | None | `Do NOT use for manual type definitions or non-OpenAPI schemas.` |

**Validation rule:** `validate-frontmatter.sh` gains a new check `check_negative_trigger` that verifies the description contains at least one `Do NOT` or `Not for` phrase.

#### 1.2 Performance Notes for MCP-Heavy Skills

The guide (p. 26) recommends explicit performance directives. Add a `## Performance Notes` section to skills that coordinate multiple MCP calls:

**Skills receiving performance notes:**

| Skill | MCP Coordination Complexity | Performance Note |
|---|---|---|
| delegation | High (team_spawn, task_claim/complete, workflow_set) | Verify each task dispatch before proceeding to next. Do not batch dispatches without confirming worktree readiness. |
| quality-review | Medium (workflow_get, event_append) | Read each checklist file completely before scoring. Do not skip security or SOLID checks even for small changes. |
| synthesis | High (stack_place, workflow_set, event_append) | Verify all tests pass before creating PR. Do not skip the pre-submit validation step. |
| debug | Medium (workflow_set, event_append) | Complete each investigation step before concluding root cause. Do not jump to fix without evidence. |
| implementation-planning | Medium (workflow_set) | Trace every design section to at least one task. Do not leave uncovered sections without explicit rationale. |

**Format:**

```markdown
## Performance Notes

- Complete each step fully before advancing — quality over speed
- Do not skip validation checks even when the change appears trivial
- [Skill-specific directive from table above]
```

#### 1.3 Cross-Reference Verification

The existing `check_references_exist` function in `validate-frontmatter.sh` already validates that `references/*.md` patterns in the body point to real files. Extend to also check:

- `references/` directory exists if any reference is mentioned
- No orphan files in `references/` (files present but not referenced from SKILL.md)

**New check: `check_no_orphan_references`**

```bash
check_no_orphan_references() {
  local skill_dir
  skill_dir=$(dirname "$SKILL_FILE")
  local refs_dir="${skill_dir}/references"

  if [[ ! -d "$refs_dir" ]]; then
    return  # No references directory — nothing to check
  fi

  for ref_file in "$refs_dir"/*.md; do
    [[ -f "$ref_file" ]] || continue
    local ref_name="references/$(basename "$ref_file")"
    if ! echo "$BODY" | grep -qF "$ref_name"; then
      ERRORS+=("check_no_orphan_references: File '${ref_name}' exists but is not referenced in SKILL.md")
    fi
  done
}
```

---

### 2. Trigger Test Harness

#### 2.1 Architecture

A fixture-based test suite that validates skill descriptions against expected trigger/non-trigger phrases. This runs as shell tests today and graduates to the eval framework's regression layer when it ships.

**Location:** `skills/trigger-tests/`

```
skills/trigger-tests/
├── run-trigger-tests.sh     # Test runner
├── fixtures.jsonl           # Trigger test cases (one per line)
└── README.md                # Developer guide for adding test cases
```

#### 2.2 Fixture Format

Each line in `fixtures.jsonl` defines a trigger test case:

```jsonl
{"skill": "brainstorming", "phrase": "let's brainstorm", "expected": "trigger", "tags": ["obvious"]}
{"skill": "brainstorming", "phrase": "explore design options for auth", "expected": "trigger", "tags": ["paraphrased"]}
{"skill": "brainstorming", "phrase": "fix the login bug", "expected": "no-trigger", "tags": ["unrelated"]}
{"skill": "delegation", "phrase": "delegate tasks to agents", "expected": "trigger", "tags": ["obvious"]}
{"skill": "delegation", "phrase": "dispatch implementation work", "expected": "trigger", "tags": ["paraphrased"]}
{"skill": "delegation", "phrase": "review the code quality", "expected": "no-trigger", "tags": ["unrelated"]}
{"skill": "debug", "phrase": "debug this issue", "expected": "trigger", "tags": ["obvious"]}
{"skill": "debug", "phrase": "investigate the regression", "expected": "trigger", "tags": ["paraphrased"]}
{"skill": "debug", "phrase": "refactor the module", "expected": "no-trigger", "tags": ["unrelated"]}
```

**Test case taxonomy** (from the guide, p. 15):
- `obvious` — Direct match on trigger phrases in the description
- `paraphrased` — Semantically equivalent but different wording
- `unrelated` — Should NOT trigger; validates negative triggers work

#### 2.3 Static Trigger Validation

The test runner performs **static analysis** of skill descriptions — no LLM calls required. It validates:

1. **Obvious triggers:** Each `trigger` phrase (tagged `obvious`) must appear as a substring (case-insensitive) in the skill's `description` field.

2. **Negative triggers:** Each `no-trigger` phrase must NOT appear as a substring in the skill's description, OR the skill's description must contain a negative trigger (`Do NOT`, `Not for`) that covers the unrelated domain.

3. **Coverage:** Every skill must have at least 2 `trigger` (one obvious, one paraphrased) and 1 `no-trigger` test case.

**Test runner logic:**

```bash
#!/usr/bin/env bash
# run-trigger-tests.sh — Validate skill descriptions against trigger fixtures
set -euo pipefail

FIXTURES="${1:-skills/trigger-tests/fixtures.jsonl}"
SKILLS_DIR="${2:-skills}"
PASS=0; FAIL=0; SKIP=0

while IFS= read -r line; do
  skill=$(echo "$line" | jq -r '.skill')
  phrase=$(echo "$line" | jq -r '.phrase')
  expected=$(echo "$line" | jq -r '.expected')
  tag=$(echo "$line" | jq -r '.tags[0]')

  skill_file="${SKILLS_DIR}/${skill}/SKILL.md"
  if [[ ! -f "$skill_file" ]]; then
    SKIP=$((SKIP + 1)); continue
  fi

  # Extract description from frontmatter
  description=$(sed -n '/^---$/,/^---$/p' "$skill_file" | grep -A 100 '^description:' | head -20)

  case "$expected" in
    trigger)
      if [[ "$tag" == "obvious" ]]; then
        # Obvious triggers must appear literally in description
        if echo "$description" | grep -qi "$phrase"; then
          PASS=$((PASS + 1))
        else
          FAIL=$((FAIL + 1))
          echo "FAIL: ${skill} description missing obvious trigger: '${phrase}'"
        fi
      else
        # Paraphrased — just verify the skill has SOME related keyword
        PASS=$((PASS + 1))  # Advisory only in static mode
      fi
      ;;
    no-trigger)
      # Verify description has negative trigger covering this domain
      if echo "$description" | grep -qi "Do NOT\|Not for"; then
        PASS=$((PASS + 1))
      else
        FAIL=$((FAIL + 1))
        echo "FAIL: ${skill} has no negative triggers (needed to exclude: '${phrase}')"
      fi
      ;;
  esac
done < "$FIXTURES"

echo "=== Trigger Tests: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
```

#### 2.4 Eval Framework Integration Path

When the SDLC Eval Framework ships, the trigger test fixtures graduate:

1. `fixtures.jsonl` becomes the seed dataset for `skills/*/evals/datasets/regression.jsonl`
2. `obvious` and `paraphrased` test cases become **capability evals** — LLM-graded trigger accuracy
3. `no-trigger` cases become **regression evals** — deterministic assertions that over-firing doesn't recur
4. The static runner (`run-trigger-tests.sh`) continues as a fast pre-commit check; LLM-based trigger testing runs in CI

**Migration mapping:**

| Trigger Harness | Eval Framework Equivalent |
|---|---|
| `fixtures.jsonl` | `evals/datasets/trigger-regression.jsonl` |
| `run-trigger-tests.sh` | `cli.ts eval-run --layer regression --suite triggers` |
| `obvious` tag | Regression eval (must always pass) |
| `paraphrased` tag | Capability eval (measures improvement) |
| `no-trigger` tag | Regression eval (must never fire) |

---

### 3. Post-Install Verification

A validation script that runs after `copyDirectory` completes, confirming the deployed skills are structurally sound.

**Location:** `skills/validate-installation.sh`

**Checks:**
1. Run `validate-frontmatter.sh` against every installed skill in `~/.claude/skills/`
2. Verify each skill directory has a `SKILL.md` file
3. Verify `references/` directories were copied (compare file count: repo vs installed)
4. Report any skills with broken reference links

**Integration with installer overhaul:**

The installer's `verify` step (already designed in the overhaul) calls this script after copying skills:

```typescript
// In install.ts — after copyDirectory('skills', target)
const verifyResult = execSync(
  `bash "${repoRoot}/skills/validate-installation.sh" "${targetSkillsDir}"`,
  { encoding: 'utf-8' }
);
```

This ensures that every install — standard or dev mode — produces structurally valid skills.

---

## Changes Required

### Skill Files (12 SKILL.md updates)

| Skill | Changes |
|---|---|
| implementation-planning | Add negative trigger to description |
| delegation | Add negative trigger + performance notes section |
| quality-review | Add negative trigger + performance notes section |
| spec-review | Add negative trigger |
| synthesis | Add negative trigger + performance notes section |
| debug | Add negative trigger + performance notes section |
| refactor | Add negative trigger |
| workflow-state | Add negative trigger |
| git-worktrees | Add negative trigger |
| dotnet-standards | Add negative trigger |
| sync-schemas | Add negative trigger |
| brainstorming | Already compliant; add performance notes (optional) |

### Validation Scripts (2 new, 1 extended)

| File | Type | Purpose |
|---|---|---|
| `skills/validate-frontmatter.sh` | Extended | Add `check_negative_trigger`, `check_no_orphan_references` |
| `skills/trigger-tests/run-trigger-tests.sh` | New | Static trigger validation against fixtures |
| `skills/trigger-tests/fixtures.jsonl` | New | Trigger test cases (36+ cases: 3 per skill x 12 skills) |
| `skills/validate-installation.sh` | New | Post-install structural validation |

### Test Fixtures (2 new)

| File | Purpose |
|---|---|
| `skills/test-fixtures/no-negative-trigger/SKILL.md` | Fixture for negative trigger validation |
| `skills/test-fixtures/orphan-reference/SKILL.md` + `references/orphan.md` | Fixture for orphan detection |

---

## Testing Strategy

### Unit Tests (validate-frontmatter.sh)

Existing fixture-based tests extended with 2 new cases:
- `no-negative-trigger` — Description lacks `Do NOT` / `Not for` phrase
- `orphan-reference` — File exists in `references/` but isn't mentioned in SKILL.md

### Trigger Tests (run-trigger-tests.sh)

- 36+ test cases covering all 12 skills (3 per skill minimum)
- Each skill gets: 1 obvious trigger, 1 paraphrased trigger, 1 unrelated non-trigger
- CI runs as part of the existing content validation workflow

### Integration Test

- Run `validate-installation.sh` against a fresh copy-based install in a temp directory
- Verify all 12 skills pass frontmatter validation
- Verify reference file counts match between repo and installed copy

### Manual Verification

After the consistency sweep:
1. Re-run the installer (`bunx exarchos --yes`)
2. Start a Claude session
3. Test each primary workflow trigger phrase and verify the correct skill loads
4. Test 2-3 unrelated prompts and verify skills don't over-fire

---

## Implementation Order

| Step | Task | Dependencies |
|---|---|---|
| 1 | Extend `validate-frontmatter.sh` with negative trigger + orphan reference checks | None |
| 2 | Add test fixtures for new validation checks | Step 1 |
| 3 | Create `trigger-tests/fixtures.jsonl` with 36+ test cases | None |
| 4 | Create `trigger-tests/run-trigger-tests.sh` runner | Step 3 |
| 5 | Update all 12 SKILL.md descriptions with negative triggers | Steps 1-2 (validation catches mistakes) |
| 6 | Add performance notes sections to 5 MCP-heavy skills | None |
| 7 | Add `check_no_orphan_references` to validator | Step 1 |
| 8 | Create `validate-installation.sh` | Steps 1, 7 |
| 9 | Run full validation suite against repo skills | Steps 1-8 |
| 10 | Re-run installer to deploy | Step 9 |

Steps 1-4 and 5-6 can run in parallel (two worktrees).

---

## Open Questions

1. **Paraphrased trigger testing depth** — Static analysis can only verify obvious triggers (substring match). Should paraphrased triggers be advisory-only until the eval framework ships, or should we add a lightweight keyword-proximity heuristic? **Recommendation:** Advisory-only. The eval framework's LLM-graded trigger testing is the right tool for paraphrased accuracy.

2. **Performance notes placement** — The guide notes (p. 26): "Adding this to user prompts is more effective than in SKILL.md." Should performance notes go in SKILL.md, the command .md, or the user's rules/? **Recommendation:** SKILL.md for skill-specific directives, rules/ for universal directives. Commands inherit from skills.

3. **Orphan reference strictness** — Should orphan `.test.sh` files in `references/` directories trigger a warning? They aren't referenced from SKILL.md but serve a purpose. **Recommendation:** Only check `.md` files. Exclude `.sh`, `.json`, and other non-content files from the orphan check.

4. **Trigger fixture sourcing** — Should we extract trigger phrases from the existing `## Triggers` sections of SKILL.md files, or write them independently? **Recommendation:** Extract from `## Triggers` as the baseline, then add paraphrased variants manually. This ensures fixtures match what's actually documented.
