# Implementation Plan: Release Hardening

## Source Design
Link: `docs/designs/2026-03-06-release-hardening.md`

## Scope
**Target:** Full design (DR-1 through DR-9)
**Excluded:** None

## Summary
- Total tasks: 12
- Parallel groups: 3
- Design coverage: 9 of 9 requirements covered

## Spec Traceability

| Design Requirement | Task(s) | Key Requirements |
|---|---|---|
| DR-1: Sensitive Document Removal | Task 1 | Port 7 files to basileus, delete from exarchos |
| DR-2: Basileus Reference Scrub | Task 2 | Replace `.local` URLs, verify code refs intact |
| DR-3: Design Document Audit | Task 3 | Scan 45 design docs for sensitive terms |
| DR-4: CI Governance Hardening | Task 6, Task 7 | Required status checks, CODEOWNERS |
| DR-5: Community Infrastructure | Task 8, Task 9 | SECURITY.md, CONTRIBUTING.md, discussion templates |
| DR-6: README Refresh | Task 4, Task 5 | Verify commands, update stale refs, add badges |
| DR-7: Version and Changelog Sync | Task 11 | Bridge changelog gap, create v2.4.2 tag |
| DR-8: Gitignore Hardening | Task 1 (included) | Add .env, .env.local, docs/marketing/ |
| DR-9: Self-Hosted Runner Risk Mitigation | Task 10 | Guard fork PRs on self-hosted runners |

## Task Breakdown

### Task 1: Port sensitive files and harden gitignore
**Implements:** DR-1, DR-8
**Phase:** EXECUTE → VERIFY

1. [EXECUTE] Port files to basileus repo
   - Create `../basileus/docs/market/exarchos/` directory
   - Copy all 5 files from `docs/marketing/` to basileus
   - Copy `docs/adrs/productization-roadmap.md` to basileus
   - Copy `docs/designs/2026-03-01-marketplace-positioning.md` to basileus
   - Delete `docs/marketing/` directory from exarchos
   - Delete `docs/adrs/productization-roadmap.md` from exarchos
   - Delete `docs/designs/2026-03-01-marketplace-positioning.md` from exarchos

2. [EXECUTE] Add entries to `.gitignore`:
   - `.env`
   - `.env.local`
   - `docs/marketing/`

3. [VERIFY] Run acceptance checks:
   - `ls ../basileus/docs/market/exarchos/` shows 7 files
   - `ls docs/marketing/` fails (directory removed)
   - `git check-ignore docs/marketing/test.md` returns match
   - `grep -r "validates demand for" docs/ --include="*.md"` returns empty

**Dependencies:** None
**Parallelizable:** No (must complete before Tasks 2, 3)

---

### Task 2: Scrub basileus references in docs
**Implements:** DR-2
**Phase:** EXECUTE → VERIFY

1. [EXECUTE] In `docs/designs/2026-02-05-exarchos.md`:
   - Replace `https://basileus.local/api` with `https://your-remote-server.example.com/api`

2. [EXECUTE] Scan remaining docs for strategic basileus language:
   - Search: `grep -ri "basileus" docs/ --include="*.md"` (after Task 1 removals)
   - For each hit: determine if strategic/funnel (redact) or technical (keep)

3. [VERIFY] Acceptance checks:
   - `grep -r "basileus.local" docs/` returns empty
   - `grep -ri "funnel\|paid offering\|validates demand" docs/ --include="*.md"` returns empty
   - `npm run test:run` passes (code refs to `basileusConnected` still functional)

**Dependencies:** Task 1
**Parallelizable:** Yes (with Task 3, after Task 1)

---

### Task 3: Audit design documents for sensitive content
**Implements:** DR-3
**Phase:** EXECUTE → VERIFY

1. [EXECUTE] Scan all files in `docs/designs/` for sensitive terms:
   - Search terms: `basileus` (non-code context), `SaaS`, `paid offering`, `revenue`, `pricing`, `funnel`, `acquisition`, `Superpowers`, `competitive`
   - For each hit: categorize as keep/redact/port
   - Redact in-place where needed (replace strategic language with neutral)
   - Port to basileus if entire file is sensitive

2. [VERIFY] Produce disposition checklist:
   - Every `docs/designs/*.md` file listed with disposition
   - No remaining sensitive terms in strategic context

**Dependencies:** Task 1
**Parallelizable:** Yes (with Task 2, after Task 1)

---

### Task 4: Update issue templates (remove Jules)
**Implements:** DR-6
**Phase:** EXECUTE → VERIFY

1. [EXECUTE] Edit `.github/ISSUE_TEMPLATE/bug.yml`:
   - Replace "Jules integration" dropdown option with "MCP server" (or remove)
   - Review other options for accuracy

2. [VERIFY] YAML is valid: `python3 -c "import yaml; yaml.safe_load(open('.github/ISSUE_TEMPLATE/bug.yml'))"`

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 5: README refresh and badge addition
**Implements:** DR-6
**Phase:** EXECUTE → VERIFY

1. [EXECUTE] Audit README.md:
   - Cross-reference each listed command against `commands/` and `skills/` directories
   - Verify install instructions for all 3 paths
   - Search for "Jules" references and remove
   - Search for internal jargon or unreleased product references
   - Add badges: CI status, npm version, license

2. [VERIFY] Acceptance checks:
   - `grep -i "jules" README.md` returns empty
   - README contains `[![CI]`, `[![npm]`, `[![License]` badge patterns
   - Every command name in README maps to a real file

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 6: Create CODEOWNERS
**Implements:** DR-4
**Phase:** EXECUTE → VERIFY

1. [EXECUTE] Create `.github/CODEOWNERS`:
   ```
   # Default owner
   * @reedsalus

   # MCP server
   servers/exarchos-mcp/ @reedsalus

   # Validation scripts
   scripts/ @reedsalus

   # Skills and commands
   skills/ @reedsalus
   commands/ @reedsalus
   ```

2. [VERIFY] File exists and syntax is valid:
   - `test -f .github/CODEOWNERS`

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 7: Configure branch protection / rulesets
**Implements:** DR-4
**Phase:** EXECUTE → VERIFY

1. [EXECUTE] Configure required status checks on `main`:
   - Use `gh api` or GitHub UI to require CI Gate job
   - Enable require CODEOWNER review
   - Verify dismiss stale reviews is enabled

2. [VERIFY] Acceptance checks:
   - `gh api repos/lvlup-sw/exarchos/branches/main/protection` shows required checks
   - `gh api repos/lvlup-sw/exarchos/rules` shows active ruleset (if using rulesets)

**Dependencies:** Task 6 (CODEOWNERS must exist first)
**Parallelizable:** No (sequential after Task 6)

---

### Task 8: Create SECURITY.md
**Implements:** DR-5
**Phase:** EXECUTE → VERIFY

1. [EXECUTE] Create `SECURITY.md` at repo root:
   - Supported versions table
   - Reporting mechanism (GitHub Security Advisories or email)
   - Response timeline expectations
   - Disclosure policy

2. [VERIFY] `test -f SECURITY.md && grep -q "Security" SECURITY.md`

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 9: Create CONTRIBUTING.md and discussion templates
**Implements:** DR-5
**Phase:** EXECUTE → VERIFY

1. [EXECUTE] Create `CONTRIBUTING.md` at repo root:
   - Dev setup: `git clone`, `npm install`, `npm run build`, `npm run test:run`
   - Branch naming conventions
   - PR process and template usage
   - Commit message conventions (conventional commits)
   - Exarchos workflow overview for contributors

2. [EXECUTE] Create `.github/DISCUSSION_TEMPLATE/`:
   - `questions.yml` — Q&A template
   - `ideas.yml` — Feature ideas template

3. [VERIFY] Acceptance checks:
   - `test -f CONTRIBUTING.md`
   - `ls .github/DISCUSSION_TEMPLATE/*.yml | wc -l` returns 2+
   - Dev setup instructions in CONTRIBUTING.md work: verify commands are accurate

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 10: Self-hosted runner fork guard
**Implements:** DR-9
**Phase:** EXECUTE → VERIFY

1. [EXECUTE] Add fork guard to CI workflows that use self-hosted runners:
   - In `.github/workflows/ci.yml`: Add condition to skip self-hosted runs on fork PRs
   - Pattern: `if: github.event.pull_request.head.repo.full_name == github.repository || github.event_name != 'pull_request'`
   - Apply same guard to `eval-gate.yml`, `benchmark-gate.yml`

2. [VERIFY] Acceptance checks:
   - `grep -l "self-hosted" .github/workflows/*.yml` lists affected files
   - Each affected file contains the fork guard condition

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 11: Changelog and version tag sync
**Implements:** DR-7
**Phase:** EXECUTE → VERIFY

1. [EXECUTE] Update `CHANGELOG.md`:
   - Generate entries from git history: `git log v2.0.6..HEAD --oneline`
   - Organize by conventional commit type (feat, fix, refactor, chore)
   - Cover v2.1.0 through v2.4.2 range

2. [EXECUTE] Create version tag:
   - `git tag v2.4.2`
   - Verify: `npm run version:check`

3. [VERIFY] Acceptance checks:
   - `CHANGELOG.md` contains v2.4.2 section
   - `git tag -l 'v2.4.*'` returns v2.4.2
   - `npm run version:check` exits 0

**Dependencies:** All other tasks (tag should be last)
**Parallelizable:** No (must be final)

---

### Task 12: Final validation sweep
**Implements:** All DRs
**Phase:** VERIFY

1. [VERIFY] Run comprehensive checks:
   - `npm run build` succeeds
   - `npm run test:run` passes
   - `npm run typecheck` passes
   - `grep -ri "basileus" docs/ --include="*.md"` returns only technical refs
   - `grep -ri "jules" . --include="*.md" --exclude-dir=node_modules --exclude-dir=dist` returns no stale refs
   - `git check-ignore docs/marketing/test.md` confirms gitignore works
   - All new files (SECURITY.md, CONTRIBUTING.md, CODEOWNERS, discussion templates) exist

**Dependencies:** All tasks
**Parallelizable:** No (must be final)

## Parallelization Strategy

```
Group A (sequential, highest priority):
  Task 1 → Task 2 (parallel with Task 3)
         → Task 3 (parallel with Task 2)

Group B (parallel, independent — can start immediately):
  Task 4: Update issue templates
  Task 5: README refresh
  Task 6: Create CODEOWNERS → Task 7: Branch protection (sequential)
  Task 8: Create SECURITY.md
  Task 9: Create CONTRIBUTING.md + discussion templates
  Task 10: Self-hosted runner fork guard

Group C (sequential, must be last):
  Task 11: Changelog + version tag (after all other tasks)
  Task 12: Final validation sweep (after Task 11)
```

Groups A and B can run concurrently. Group C runs after both complete.

## Deferred Items

- **Semantic-release / Changesets:** Deferred per design — manual tag workflow sufficient for now
- **Signed commits:** Deferred — low priority for initial release
- **FUNDING.yml / Code of Conduct:** Deferred — add when community grows
- **Coverage thresholds in CI:** Deferred — existing tests provide adequate coverage
- **GitHub-hosted runner migration:** Deferred — fork guard (DR-9) mitigates the immediate risk

## Completion Checklist
- [ ] All sensitive files ported to basileus and removed from exarchos
- [ ] Basileus references scrubbed from docs
- [ ] Design documents audited with disposition log
- [ ] CI governance configured (status checks, CODEOWNERS)
- [ ] SECURITY.md and CONTRIBUTING.md created
- [ ] Discussion templates created
- [ ] README refreshed with badges
- [ ] Issue templates updated (Jules removed)
- [ ] Self-hosted runner fork guards added
- [ ] Changelog updated and version tag created
- [ ] Final validation sweep passes
