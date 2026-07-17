# Implementation Plan: Repository Rename & GitHub Project Management

**Design:** [2026-01-06-repo-management.md](../designs/2026-01-06-repo-management.md)
**Date:** 2026-01-06
**Tasks:** 12
**Estimated Parallelization:** 3 parallel tracks

---

## Task Overview

| ID | Task | Dependencies | Parallel Track |
|----|------|--------------|----------------|
| 001 | Create migration script test | None | A |
| 002 | Implement migration script | 001 | A |
| 003 | Update install.sh with path detection | 001 | A |
| 004 | Update documentation references | None | B |
| 005 | Create labels.yml configuration | None | B |
| 006 | Create sync-labels.sh script | 005 | B |
| 007 | Create issue templates | None | C |
| 008 | Create project-automation workflow | 005 | C |
| 009 | Create cliff.toml changelog config | None | C |
| 010 | Create workflow test script | 007, 008, 009 | - |
| 011 | Enable GitHub Discussions | None | Manual |
| 012 | Create GitHub Project board | None | Manual |

---

## Parallel Tracks

```
Track A (Scripts)          Track B (Labels/Docs)      Track C (GitHub Config)
─────────────────          ─────────────────────      ─────────────────────
001: Migration test        004: Update docs           007: Issue templates
     │                          │                          │
     ▼                          ▼                          │
002: Migration script      005: labels.yml            009: cliff.toml
     │                          │                          │
     ▼                          ▼                          ▼
003: Install.sh update     006: sync-labels.sh        008: project-automation
                                                           │
                                ─────────────────────────────
                                           │
                                           ▼
                                    010: Workflow tests
                                           │
                                           ▼
                                    011-012: Manual setup
```

---

## Task Details

### Task 001: Create migration script test
**Phase:** RED
**Branch:** `feature/001-migration-test`
**Parallel Track:** A

1. **[RED]** Write test: `scripts/migrate-to-lvlup-claude.test.sh`
   - Test file exists and is executable
   - Test validates directory detection logic
   - Test symlink update function
   - Expected failure: Script doesn't exist yet

```bash
# Test cases to implement:
# - Script exists and is executable
# - Detects claude-config directory correctly
# - Detects lvlup-claude directory correctly
# - Errors when neither directory exists
# - update_symlinks function creates correct links
```

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 002: Implement migration script
**Phase:** GREEN → REFACTOR
**Branch:** `feature/002-migration-script`
**Parallel Track:** A

1. **[GREEN]** Create `scripts/migrate-to-lvlup-claude.sh`
   - Implement directory detection
   - Implement symlink update function
   - Add color output helpers
   - Make executable

2. **[REFACTOR]** Clean up if needed
   - Ensure consistent error handling
   - Add usage documentation in header

**Dependencies:** 001
**Parallelizable:** No (depends on 001)

---

### Task 003: Update install.sh with path detection
**Phase:** GREEN → REFACTOR
**Branch:** `feature/003-install-path-detection`
**Parallel Track:** A

1. **[GREEN]** Update `scripts/install.sh`
   - Add REPO_NAME detection: `REPO_NAME="$(basename "$REPO_ROOT")"`
   - Add warning when using `claude-config` name
   - Suggest migration script

2. **[REFACTOR]** Ensure backward compatibility
   - Script works from either directory name

**Dependencies:** 001 (for testing context)
**Parallelizable:** No (depends on 001)

---

### Task 004: Update documentation references
**Phase:** GREEN
**Branch:** `feature/004-update-docs`
**Parallel Track:** B

1. **[GREEN]** Update files with `claude-config` references:
   - `README.md`: Update clone path to `lvlup-claude`
   - `README.md`: Update directory tree
   - `scripts/workflow-state.sh`: Update comment
   - `plugins/jules/README.md`: Update reference
   - `docs/plans/2026-01-05-cicd-phase0-completion.md`: Update tree

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 005: Create labels.yml configuration
**Phase:** RED → GREEN
**Branch:** `feature/005-labels-config`
**Parallel Track:** B

1. **[RED]** Define expected structure
   - 14 labels across 4 categories
   - Valid YAML syntax

2. **[GREEN]** Create `.github/labels.yml`
   - Type labels (5): bug, feature, docs, chore, question
   - Scope labels (4): workflow, jules, templates, rules
   - Status labels (3): triage, blocked, stale
   - Priority labels (2): high, low

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 006: Create sync-labels.sh script
**Phase:** RED → GREEN
**Branch:** `feature/006-sync-labels`
**Parallel Track:** B

1. **[RED]** Write test: `scripts/sync-labels.test.sh`
   - Test script exists and is executable
   - Test YAML parsing logic (mock mode)
   - Expected failure: Script doesn't exist

2. **[GREEN]** Create `scripts/sync-labels.sh`
   - Delete default GitHub labels
   - Parse labels.yml with yq
   - Create/update labels via gh CLI
   - Add --dry-run flag for testing

**Dependencies:** 005
**Parallelizable:** No (depends on 005)

---

### Task 007: Create issue templates
**Phase:** GREEN
**Branch:** `feature/007-issue-templates`
**Parallel Track:** C

1. **[GREEN]** Create issue templates:
   - `.github/ISSUE_TEMPLATE/bug.yml`
   - `.github/ISSUE_TEMPLATE/feature.yml`
   - `.github/ISSUE_TEMPLATE/config.yml`

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 008: Create project-automation workflow
**Phase:** RED → GREEN
**Branch:** `feature/008-project-automation`
**Parallel Track:** C

1. **[RED]** Define workflow structure
   - Valid YAML syntax
   - Correct trigger events
   - Required permissions

2. **[GREEN]** Create `.github/workflows/project-automation.yml`
   - auto-triage job: Label based on content
   - project-sync job: Add to project board
   - stale job: Mark/close inactive issues
   - auto-merge-renovate job: Auto-merge Renovate PRs
   - release job: Generate changelog on tag

**Dependencies:** 005 (needs labels to exist)
**Parallelizable:** Partially (can start, but needs 005 for label references)

---

### Task 009: Create cliff.toml changelog config
**Phase:** GREEN
**Branch:** `feature/009-changelog-config`
**Parallel Track:** C

1. **[GREEN]** Create `.github/cliff.toml`
   - Configure conventional commit parsing
   - Set up changelog body template
   - Define commit type groupings

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 010: Create workflow test script
**Phase:** RED → GREEN
**Branch:** `feature/010-workflow-tests`
**Parallel Track:** -

1. **[RED]** Write test: `scripts/github-config.test.sh`
   - Test all YAML files are valid
   - Test labels.yml has required labels
   - Test workflow has required jobs
   - Test issue templates have required fields

2. **[GREEN]** Implement tests
   - Use yamllint or python yaml validation
   - Use jq/yq for structure validation

**Dependencies:** 007, 008, 009
**Parallelizable:** No (integration test)

---

### Task 011: Enable GitHub Discussions (Manual)
**Phase:** MANUAL
**Branch:** N/A

1. Go to repo Settings → General → Features
2. Enable Discussions
3. Create categories:
   - Announcements (announcement format)
   - Ideas (open format)
   - Q&A (question format)
   - Show & Tell (open format)

**Dependencies:** None
**Parallelizable:** Yes (manual task)

---

### Task 012: Create GitHub Project board (Manual)
**Phase:** MANUAL
**Branch:** N/A

1. Create project: "lvlup-claude Roadmap"
2. Add custom fields:
   - Status: Backlog, Todo, In Progress, In Review, Done
   - Priority: High, Medium, Low
   - Effort: XS, S, M, L, XL
3. Create views:
   - Backlog (table, grouped by type)
   - Current (board)
   - Releases (table, grouped by milestone)
4. Note PROJECT_NUMBER for workflow config
5. Create PROJECT_TOKEN secret (PAT with project scope)

**Dependencies:** None
**Parallelizable:** Yes (manual task)

---

## Delegation Strategy

### Jules-Compatible Tasks (Async)
These tasks are self-contained and suitable for Jules:
- 004: Update documentation references
- 005: Create labels.yml configuration
- 007: Create issue templates
- 009: Create cliff.toml changelog config

### Claude Code Tasks (Sync)
These require iterative testing or complex logic:
- 001-003: Migration scripts (need local testing)
- 006: sync-labels.sh (needs gh CLI context)
- 008: project-automation workflow (complex YAML)
- 010: Integration tests

### Manual Tasks
- 011: Enable Discussions (GitHub UI)
- 012: Create Project board (GitHub UI)

---

## Success Criteria

- [ ] `./scripts/migrate-to-lvlup-claude.test.sh` passes
- [ ] `./scripts/github-config.test.sh` passes
- [ ] All documentation references updated to `lvlup-claude`
- [ ] Labels synced to repository (14 custom labels)
- [ ] Issue templates render correctly in GitHub UI
- [ ] Discussions enabled with 4 categories
- [ ] Project board created with 3 views
- [ ] PROJECT_NUMBER updated in workflow
