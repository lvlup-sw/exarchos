# Repository Rename & GitHub Project Management

**Date:** 2026-01-06
**Status:** Draft
**Author:** Claude + Reed

## Overview

This design covers two integrated goals:

1. **Rename local repository** from `claude-config` to `lvlup-claude` to match the remote
2. **Implement GitHub project management automation** using a unified GitHub Actions + Projects v2 approach

## Goal 1: Repository Rename

### Current State

| Location | Current | Target |
|----------|---------|--------|
| Local directory | `~/Documents/code/claude-config` | `~/Documents/code/lvlup-claude` |
| Remote repository | `lvlup-sw/lvlup-claude` | (no change) |
| Symlinks | `~/.claude/*` → `claude-config/*` | `~/.claude/*` → `lvlup-claude/*` |

### Files Requiring Updates

| File | Change |
|------|--------|
| `README.md` | Update clone path, directory references |
| `scripts/workflow-state.sh` | Update comment referencing `claude-config` |
| `plugins/jules/README.md` | Update reference to global config |
| `docs/plans/2026-01-05-cicd-phase0-completion.md` | Update directory tree |

### Migration Script

New script: `scripts/migrate-to-lvlup-claude.sh`

```bash
#!/usr/bin/env bash
# Migrate from claude-config to lvlup-claude directory name
#
# This script:
# 1. Validates current state
# 2. Updates symlinks to point to new location
# 3. Provides instructions for directory rename

set -euo pipefail

OLD_DIR="$HOME/Documents/code/claude-config"
NEW_DIR="$HOME/Documents/code/lvlup-claude"
CLAUDE_DIR="$HOME/.claude"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Validate we're running from the right place
if [[ ! -f "$OLD_DIR/scripts/migrate-to-lvlup-claude.sh" ]] && \
   [[ ! -f "$NEW_DIR/scripts/migrate-to-lvlup-claude.sh" ]]; then
    error "Must run from claude-config or lvlup-claude directory"
fi

# Determine current directory name
if [[ -d "$NEW_DIR" ]]; then
    CURRENT_DIR="$NEW_DIR"
    info "Already using lvlup-claude directory"
elif [[ -d "$OLD_DIR" ]]; then
    CURRENT_DIR="$OLD_DIR"
    info "Found claude-config directory, will migrate"
else
    error "Neither claude-config nor lvlup-claude directory found"
fi

# Update symlinks
update_symlinks() {
    local target_dir="$1"
    local links=(commands rules skills settings.json hooks.json scripts)

    for link in "${links[@]}"; do
        local link_path="$CLAUDE_DIR/$link"
        local target_path="$target_dir/$link"

        if [[ -L "$link_path" ]]; then
            rm "$link_path"
            ln -s "$target_path" "$link_path"
            info "Updated symlink: $link -> $target_path"
        elif [[ -e "$target_path" ]]; then
            ln -s "$target_path" "$link_path"
            info "Created symlink: $link -> $target_path"
        fi
    done
}

# Main migration
if [[ "$CURRENT_DIR" == "$OLD_DIR" ]]; then
    echo ""
    warn "Directory rename required. Run these commands:"
    echo ""
    echo "  cd ~"
    echo "  mv '$OLD_DIR' '$NEW_DIR'"
    echo "  cd '$NEW_DIR'"
    echo "  ./scripts/migrate-to-lvlup-claude.sh"
    echo ""
    exit 0
fi

# If we're already in lvlup-claude, just update symlinks
update_symlinks "$NEW_DIR"

info "Migration complete!"
echo ""
echo "Symlinks now point to: $NEW_DIR"
```

### Install Script Updates

Update `scripts/install.sh` to:
1. Detect if running from `lvlup-claude` or `claude-config`
2. Use the actual directory name (not hardcoded)
3. Add migration hint if running from old name

```bash
# At top of install.sh, detect directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
REPO_NAME="$(basename "$REPO_DIR")"

# Warn if using old name
if [[ "$REPO_NAME" == "claude-config" ]]; then
    warn "Consider renaming to 'lvlup-claude' to match remote"
    warn "Run: ./scripts/migrate-to-lvlup-claude.sh"
fi
```

---

## Goal 2: GitHub Project Management

### Label Taxonomy

Organized into categories with color coding:

#### Type Labels (What kind of work)

| Label | Color | Description |
|-------|-------|-------------|
| `type:bug` | `#d73a4a` | Something isn't working |
| `type:feature` | `#a2eeef` | New feature or enhancement |
| `type:docs` | `#0075ca` | Documentation improvements |
| `type:chore` | `#fef2c0` | Maintenance, dependencies, CI |
| `type:question` | `#d876e3` | Question or discussion |

#### Scope Labels (What area)

| Label | Color | Description |
|-------|-------|-------------|
| `scope:workflow` | `#c5def5` | Workflow commands (/ideate, /plan, etc.) |
| `scope:jules` | `#bfdadc` | Jules MCP integration |
| `scope:templates` | `#d4c5f9` | CI/CD, Renovate, azd templates |
| `scope:rules` | `#fbca04` | TDD and coding standards |

#### Status Labels (Lifecycle)

| Label | Color | Description |
|-------|-------|-------------|
| `status:triage` | `#ededed` | Needs initial review |
| `status:blocked` | `#b60205` | Blocked by external factor |
| `status:stale` | `#ffffff` | No activity, will auto-close |

#### Priority Labels

| Label | Color | Description |
|-------|-------|-------------|
| `priority:high` | `#d93f0b` | Address soon |
| `priority:low` | `#0e8a16` | Nice to have |

### Label Configuration File

`.github/labels.yml`:

```yaml
# Type labels
- name: "type:bug"
  color: "d73a4a"
  description: "Something isn't working"

- name: "type:feature"
  color: "a2eeef"
  description: "New feature or enhancement"

- name: "type:docs"
  color: "0075ca"
  description: "Documentation improvements"

- name: "type:chore"
  color: "fef2c0"
  description: "Maintenance, dependencies, CI"

- name: "type:question"
  color: "d876e3"
  description: "Question or discussion"

# Scope labels
- name: "scope:workflow"
  color: "c5def5"
  description: "Workflow commands (/ideate, /plan, etc.)"

- name: "scope:jules"
  color: "bfdadc"
  description: "Jules MCP integration"

- name: "scope:templates"
  color: "d4c5f9"
  description: "CI/CD, Renovate, azd templates"

- name: "scope:rules"
  color: "fbca04"
  description: "TDD and coding standards"

# Status labels
- name: "status:triage"
  color: "ededed"
  description: "Needs initial review"

- name: "status:blocked"
  color: "b60205"
  description: "Blocked by external factor"

- name: "status:stale"
  color: "ffffff"
  description: "No activity, will auto-close"

# Priority labels
- name: "priority:high"
  color: "d93f0b"
  description: "Address soon"

- name: "priority:low"
  color: "0e8a16"
  description: "Nice to have"
```

### Label Sync Script

`scripts/sync-labels.sh`:

```bash
#!/usr/bin/env bash
# Sync labels from .github/labels.yml to GitHub
set -euo pipefail

REPO="lvlup-sw/lvlup-claude"

# Delete default labels we don't use
gh label delete "duplicate" -R "$REPO" --yes 2>/dev/null || true
gh label delete "enhancement" -R "$REPO" --yes 2>/dev/null || true
gh label delete "good first issue" -R "$REPO" --yes 2>/dev/null || true
gh label delete "help wanted" -R "$REPO" --yes 2>/dev/null || true
gh label delete "invalid" -R "$REPO" --yes 2>/dev/null || true
gh label delete "wontfix" -R "$REPO" --yes 2>/dev/null || true
gh label delete "bug" -R "$REPO" --yes 2>/dev/null || true
gh label delete "documentation" -R "$REPO" --yes 2>/dev/null || true
gh label delete "question" -R "$REPO" --yes 2>/dev/null || true

# Create/update labels from config
yq -r '.[] | "\(.name)|\(.color)|\(.description)"' .github/labels.yml | \
while IFS='|' read -r name color desc; do
    gh label create "$name" -R "$REPO" --color "$color" --description "$desc" --force
done

echo "Labels synced successfully"
```

---

### Project Board Structure

Create a GitHub Project (v2) named **"lvlup-claude Roadmap"**:

#### Views

| View | Type | Purpose |
|------|------|---------|
| **Backlog** | Table | All open items, grouped by type |
| **Current** | Board | Active work in Kanban columns |
| **Releases** | Table | Items grouped by milestone |

#### Custom Fields

| Field | Type | Options |
|-------|------|---------|
| Status | Single select | Backlog, Todo, In Progress, In Review, Done |
| Priority | Single select | High, Medium, Low |
| Effort | Single select | XS, S, M, L, XL |
| Sprint | Iteration | 2-week iterations |

#### Board Columns (Current view)

```
┌─────────────┬─────────────┬─────────────┬─────────────┬─────────────┐
│   Backlog   │    Todo     │ In Progress │  In Review  │    Done     │
├─────────────┼─────────────┼─────────────┼─────────────┼─────────────┤
│ Unprioritized│ Ready to   │ Actively    │ PR open,    │ Merged &    │
│ ideas       │ start      │ working     │ needs review│ closed      │
└─────────────┴─────────────┴─────────────┴─────────────┴─────────────┘
```

---

### Unified Automation Workflow

`.github/workflows/project-automation.yml`:

```yaml
name: Project Automation

on:
  issues:
    types: [opened, labeled, unlabeled, closed, reopened]
  pull_request:
    types: [opened, ready_for_review, closed]
  issue_comment:
    types: [created]
  schedule:
    - cron: '0 9 * * 1'  # Weekly stale check, Monday 9am UTC

env:
  PROJECT_NUMBER: 1  # Update after creating project

jobs:
  # ============================================================
  # AUTO-TRIAGE: Label new issues based on content
  # ============================================================
  auto-triage:
    if: github.event_name == 'issues' && github.event.action == 'opened'
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - name: Auto-label based on title/body
        uses: actions/github-script@v7
        with:
          script: |
            const issue = context.payload.issue;
            const text = `${issue.title} ${issue.body}`.toLowerCase();
            const labels = ['status:triage'];

            // Type detection
            if (text.match(/bug|error|fail|broken|crash|issue/)) {
              labels.push('type:bug');
            } else if (text.match(/feature|add|implement|support|enhance/)) {
              labels.push('type:feature');
            } else if (text.match(/doc|readme|typo|clarif/)) {
              labels.push('type:docs');
            } else if (text.match(/\?|how|what|why|question/)) {
              labels.push('type:question');
            }

            // Scope detection
            if (text.match(/jules|mcp|delegate/)) {
              labels.push('scope:jules');
            }
            if (text.match(/workflow|ideate|plan|review|synthesize/)) {
              labels.push('scope:workflow');
            }
            if (text.match(/renovate|ci|cd|template|terraform|azd/)) {
              labels.push('scope:templates');
            }
            if (text.match(/tdd|rule|standard|typescript|csharp/)) {
              labels.push('scope:rules');
            }

            await github.rest.issues.addLabels({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: issue.number,
              labels: labels
            });

  # ============================================================
  # PROJECT SYNC: Add issues/PRs to project board
  # ============================================================
  project-sync:
    if: |
      (github.event_name == 'issues' && github.event.action == 'opened') ||
      (github.event_name == 'pull_request' && github.event.action == 'opened')
    runs-on: ubuntu-latest
    steps:
      - name: Add to project
        uses: actions/add-to-project@v1.0.2
        with:
          project-url: https://github.com/orgs/lvlup-sw/projects/${{ env.PROJECT_NUMBER }}
          github-token: ${{ secrets.PROJECT_TOKEN }}

  project-status-update:
    if: |
      github.event_name == 'issues' ||
      github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - name: Update project status
        uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.PROJECT_TOKEN }}
          script: |
            // Map events to project status
            const statusMap = {
              'issues.closed': 'Done',
              'issues.reopened': 'Backlog',
              'pull_request.ready_for_review': 'In Review',
              'pull_request.closed': context.payload.pull_request?.merged ? 'Done' : 'Backlog'
            };

            const eventKey = `${context.eventName}.${context.payload.action}`;
            const newStatus = statusMap[eventKey];

            if (!newStatus) return;

            // GraphQL mutation to update project item status
            // (Implementation depends on project field IDs)
            console.log(`Would set status to: ${newStatus}`);

  # ============================================================
  # STALE MANAGEMENT: Mark and close inactive issues
  # ============================================================
  stale:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: actions/stale@v9
        with:
          stale-issue-message: |
            This issue has been automatically marked as stale because it has not had
            recent activity. It will be closed in 14 days if no further activity occurs.
          close-issue-message: |
            This issue was closed because it has been stale for 14 days with no activity.
            Feel free to reopen if this is still relevant.
          stale-issue-label: 'status:stale'
          exempt-issue-labels: 'priority:high,status:blocked'
          days-before-stale: 60
          days-before-close: 14
          operations-per-run: 30

  # ============================================================
  # PR AUTOMATION: Auto-merge Renovate PRs
  # ============================================================
  auto-merge-renovate:
    if: |
      github.event_name == 'pull_request' &&
      github.event.pull_request.user.login == 'renovate[bot]'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Enable auto-merge for Renovate PRs
        run: gh pr merge --auto --squash "$PR_URL"
        env:
          PR_URL: ${{ github.event.pull_request.html_url }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  # ============================================================
  # RELEASE AUTOMATION: Generate changelog and release
  # ============================================================
  release:
    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Generate changelog
        id: changelog
        uses: orhun/git-cliff-action@v3
        with:
          config: .github/cliff.toml
          args: --latest --strip header

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          body: ${{ steps.changelog.outputs.content }}
          generate_release_notes: false
```

### Release Changelog Configuration

`.github/cliff.toml`:

```toml
[changelog]
header = ""
body = """
{% for group, commits in commits | group_by(attribute="group") %}
## {{ group | upper_first }}
{% for commit in commits %}
- {{ commit.message | split(pat="\n") | first | trim }} \
  ([{{ commit.id | truncate(length=7, end="") }}](https://github.com/lvlup-sw/lvlup-claude/commit/{{ commit.id }}))
{% endfor %}
{% endfor %}
"""
footer = ""
trim = true

[git]
conventional_commits = true
filter_unconventional = true
commit_parsers = [
  { message = "^feat", group = "Features" },
  { message = "^fix", group = "Bug Fixes" },
  { message = "^doc", group = "Documentation" },
  { message = "^perf", group = "Performance" },
  { message = "^refactor", group = "Refactoring" },
  { message = "^test", group = "Testing" },
  { message = "^chore", group = "Miscellaneous" },
]
filter_commits = false
tag_pattern = "v[0-9].*"
```

---

### Issue Templates

`.github/ISSUE_TEMPLATE/bug.yml`:

```yaml
name: Bug Report
description: Report something that isn't working
labels: ["type:bug", "status:triage"]
body:
  - type: textarea
    id: description
    attributes:
      label: What happened?
      description: Clear description of the bug
    validations:
      required: true

  - type: textarea
    id: expected
    attributes:
      label: Expected behavior
      description: What should have happened?
    validations:
      required: true

  - type: textarea
    id: reproduce
    attributes:
      label: Steps to reproduce
      description: How can we reproduce this?
      placeholder: |
        1. Run command X
        2. See error Y

  - type: dropdown
    id: area
    attributes:
      label: Area
      options:
        - Workflow commands (/ideate, /plan, etc.)
        - Jules integration
        - Templates (CI/CD, Renovate, azd)
        - Rules (TDD, coding standards)
        - Other
```

`.github/ISSUE_TEMPLATE/feature.yml`:

```yaml
name: Feature Request
description: Suggest a new feature or enhancement
labels: ["type:feature", "status:triage"]
body:
  - type: textarea
    id: problem
    attributes:
      label: Problem or motivation
      description: What problem does this solve?
    validations:
      required: true

  - type: textarea
    id: solution
    attributes:
      label: Proposed solution
      description: How would you like this to work?
    validations:
      required: true

  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives considered
      description: Any other approaches you've thought about?
```

`.github/ISSUE_TEMPLATE/config.yml`:

```yaml
blank_issues_enabled: true
contact_links:
  - name: Discussions
    url: https://github.com/lvlup-sw/lvlup-claude/discussions
    about: Ask questions or share ideas
```

---

### Discussion Categories

Enable GitHub Discussions with these categories:

| Category | Description | Format |
|----------|-------------|--------|
| **Announcements** | Release notes and updates | Announcement |
| **Ideas** | Feature brainstorming | Open |
| **Q&A** | How-to questions | Question |
| **Show & Tell** | Share your workflows | Open |

---

## Implementation Summary

### Phase 1: Repository Rename
1. Update file references (README, scripts, docs)
2. Create migration script
3. Update install.sh to be path-agnostic
4. Test migration on fresh system

### Phase 2: GitHub Configuration
1. Enable Discussions in repo settings
2. Create labels via sync script
3. Create project board with custom fields
4. Add issue templates

### Phase 3: Automation
1. Deploy project-automation workflow
2. Add cliff.toml for changelog generation
3. Create PROJECT_TOKEN secret (PAT with project scope)
4. Test each automation trigger

### Required Secrets

| Secret | Purpose | Scope |
|--------|---------|-------|
| `PROJECT_TOKEN` | Add items to org project | `project`, `repo` |

Note: `GITHUB_TOKEN` is sufficient for most operations, but org-level projects require a PAT.

---

## Success Criteria

- [ ] Local directory renamed to `lvlup-claude`
- [ ] All symlinks point to new location
- [ ] Labels synced to repository
- [ ] Project board created with views
- [ ] New issues auto-labeled and added to project
- [ ] Renovate PRs auto-merge when green
- [ ] Stale issues marked after 60 days
- [ ] Releases auto-generate changelog
