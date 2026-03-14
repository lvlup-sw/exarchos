# Implementation Plan: Extract Axiom Plugin to Standalone Repository

## Source Design
Link: `docs/designs/2026-03-13-backend-quality-plugin.md` (Phase 2: Delegation)
Issue: #1025

## Scope
**Target:** Phase 2 extraction — move axiom/ to standalone `lvlup-sw/axiom` repo, clean up exarchos references
**Excluded:** Phase 3 (full integration / feature-audit deprecation), axiom content changes, exarchos MCP tool changes

## Summary
- Total tasks: 6
- Parallel groups: 2 (A: repo bootstrap, B: exarchos cleanup)
- Estimated test count: 0 new (45 existing axiom tests must pass in new repo, exarchos tests must pass after removal)
- Design coverage: Phase 2 requirements from axiom-integration.md

## Spec Traceability

### Scope Declaration
**Target:** Phase 2 of migration plan in `skills/quality-review/references/axiom-integration.md`
**Excluded:** Phase 3 (full integration)

### Traceability Matrix

| Requirement | Key Criteria | Task ID(s) | Status |
|---|---|---|---|
| Create lvlup-sw/axiom repository | Repo exists, contents at root, proper git history | 001 | Covered |
| Set up CI | GitHub Actions with vitest, self-hosted runner | 002 | Covered |
| Verify CI green | All 45 structural validation tests pass | 003 | Covered |
| Remove axiom/ from exarchos | git rm -r axiom/, no orphan references | 004 | Covered |
| Update exarchos references | axiom-integration.md, feature-audit, design/plan docs | 005 | Covered |
| Verify exarchos works without axiom | Root and MCP tests pass, no broken references | 006 | Covered |

## Task Breakdown

### Task 001: Create Standalone Repository and Push Contents

**Phase:** Operational (repo creation + content migration)

**Steps:**
1. Create `lvlup-sw/axiom` GitHub repository via `gh repo create`
   - Public, MIT license, description from plugin.json
2. Clone new repo to local workspace
3. Copy axiom/ contents to repo root (excluding node_modules/)
4. Add `.gitignore` (node_modules/, coverage/, dist/, .DS_Store)
5. Initial commit with all content
6. Push to origin

**Verification:**
- Repository exists at `github.com/lvlup-sw/axiom`
- All 31 tracked files present at repo root
- `npm install && npm run test:run` passes locally (45 tests)

**Dependencies:** None
**Parallelizable:** No (foundation — everything depends on this)

---

### Task 002: Add GitHub Actions CI Workflow

**Phase:** RED → GREEN

**Steps:**
1. [RED] Create `.github/workflows/ci.yml` in axiom repo:
   ```yaml
   name: CI
   on:
     pull_request:
     push:
       branches: [main]
   jobs:
     test:
       runs-on: self-hosted
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v6
           with:
             node-version: '24'
             cache: npm
         - run: npm ci
         - run: npm run test:run
   ```
2. [GREEN] Commit and push — verify CI triggers and passes

**Verification:**
- CI workflow runs on push to main
- All 45 tests pass in CI
- CI status badge available

**Dependencies:** 001
**Parallelizable:** No (sequential with 001)

---

### Task 003: Verify CI and Marketplace Readiness

**Phase:** Verification

**Steps:**
1. Verify CI run passes (all 45 tests green)
2. Verify plugin.json homepage URL resolves to the actual repo
3. Verify package.json has correct metadata for marketplace distribution
4. Tag initial release: `git tag v0.1.0 && git push --tags`

**Verification:**
- [ ] CI green on main branch
- [ ] `gh repo view lvlup-sw/axiom` returns valid repo info
- [ ] v0.1.0 tag exists

**Dependencies:** 002
**Parallelizable:** No (sequential with 002)

---

### Task 004: Remove axiom/ Directory from Exarchos

**Phase:** Operational (git rm)

**Steps:**
1. Create feature branch: `git checkout -b chore/extract-axiom-to-standalone`
2. Remove axiom directory: `git rm -r axiom/`
3. Commit: `git commit -m "chore: remove axiom/ — extracted to lvlup-sw/axiom (#1025)"`

**Verification:**
- `axiom/` no longer exists in working tree
- No references to `axiom/` paths remain broken (checked in Task 005)

**Dependencies:** 003 (new repo must be live before removing from exarchos)
**Parallelizable:** No (must happen before Task 005)

---

### Task 005: Update Exarchos Documentation References

**Phase:** Content update

**Files to update:**

1. **`skills/quality-review/references/axiom-integration.md`**
   - Phase 2 section: mark as "Current" (was "Next")
   - Update location references from `axiom/` to `github.com/lvlup-sw/axiom`
   - Note: axiom is now an external plugin dependency

2. **`.claude/skills/feature-audit/SKILL.md`**
   - Update deprecation notice: axiom is now standalone at `lvlup-sw/axiom`
   - Update reference from `axiom/CLAUDE.md` to external repo URL

3. **`docs/designs/2026-03-13-backend-quality-plugin.md`**
   - Add Phase 2 completion note at top of document
   - Update any inline references to `axiom/` paths

4. **`docs/plans/2026-03-13-backend-quality-plugin.md`**
   - Add completion note: Phase 1 tasks done, plugin extracted to standalone repo
   - Move "Extraction to standalone repo" from Deferred Items to Completed

**Verification:**
- No remaining references to `axiom/` as a local path (grep -r "axiom/" should only return external URLs)
- All documentation references point to `github.com/lvlup-sw/axiom` or `lvlup-sw/axiom`

**Dependencies:** 004
**Parallelizable:** No (same branch as 004)

---

### Task 006: Verify Exarchos Tests Pass Without Axiom

**Phase:** Verification

**Steps:**
1. Run root package tests: `npm run test:run`
2. Run MCP server tests: `cd servers/exarchos-mcp && npm run test:run`
3. Run typecheck: `npm run typecheck`
4. Verify no broken cross-references in skills/docs
5. Push branch, create PR

**Verification:**
- [ ] Root tests pass
- [ ] MCP tests pass
- [ ] Typecheck passes
- [ ] No grep hits for `axiom/` as local path (excluding external URLs and git history)

**Dependencies:** 005
**Parallelizable:** No (final verification)

---

## Parallelization Strategy

```
Phase A — Standalone Repo Bootstrap (sequential, external):
  001 (create repo) → 002 (CI) → 003 (verify + tag)

Phase B — Exarchos Cleanup (sequential, branch):
  004 (git rm) → 005 (update docs) → 006 (verify + PR)
```

Phase B depends on Phase A completing (repo must exist before removing from exarchos).

**Agent allocation:** This extraction is primarily orchestrator-driven (operational commands: `gh`, `git`, file edits). No worktree delegation — tasks are sequential and the blast radius of each step is small. The orchestrator executes directly.

## Deferred Items

| Item | Rationale |
|---|---|
| Marketplace publication (npm publish) | Requires npm auth + lvlup-sw org setup; tracked separately |
| Phase 3: Full integration | Future work — deprecate feature-audit entirely, documented in axiom-integration.md |
| Renovate/Dependabot setup for axiom repo | Nice-to-have, not blocking extraction |

## Completion Checklist
- [ ] `lvlup-sw/axiom` repo exists with all content at root
- [ ] CI passing (45/45 tests green)
- [ ] v0.1.0 tagged
- [ ] `axiom/` removed from exarchos
- [ ] All exarchos doc references updated
- [ ] Exarchos tests pass without axiom/
- [ ] PR created for exarchos cleanup
