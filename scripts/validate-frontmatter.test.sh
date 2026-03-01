#!/usr/bin/env bash
# validate-frontmatter.test.sh — Tests for validate-frontmatter.sh
#
# Pattern: create temp dirs with fixture skills/phases/templates, verify exit codes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/validate-frontmatter.sh"
PASS=0
FAIL=0
TMPDIRS=()
cleanup() { for d in "${TMPDIRS[@]}"; do rm -rf "$d"; done; }
trap cleanup EXIT

# Helper
assert_exit() {
  local label=$1; shift
  local expected=$1; shift
  if "$@" >/dev/null 2>&1; then actual=0; else actual=$?; fi
  if [[ "$actual" -eq "$expected" ]]; then
    PASS=$((PASS + 1))
    echo "- **PASS**: $label (expected $expected, got $actual)"
  else
    FAIL=$((FAIL + 1))
    echo "- **FAIL**: $label (expected $expected, got $actual)"
  fi
}

echo "## validate-frontmatter.sh Tests"
echo

# ============================================================
# Test 1: PhasesDir_OrphanedFile_ExitsOne
# A file in phases/ not referenced from references/ or SKILL.md
# ============================================================
TMPDIR1=$(mktemp -d)
TMPDIRS+=("$TMPDIR1")
mkdir -p "$TMPDIR1/skills/my-skill/phases" "$TMPDIR1/skills/my-skill/references"
cat > "$TMPDIR1/skills/my-skill/SKILL.md" << 'EOF'
---
name: my-skill
description: "A test skill"
---

# My Skill

This skill does things.
EOF
cat > "$TMPDIR1/skills/my-skill/references/guide.md" << 'EOF'
# Guide
Some content here.
EOF
cat > "$TMPDIR1/skills/my-skill/phases/orphan-phase.md" << 'EOF'
# Orphan Phase
This file is not referenced anywhere.
EOF
assert_exit "PhasesDir_OrphanedFile_ExitsOne" 1 bash "$SCRIPT" --repo-root "$TMPDIR1"

# ============================================================
# Test 2: TemplatesDir_OrphanedFile_ExitsOne
# A file in templates/ not referenced from references/ or SKILL.md
# ============================================================
TMPDIR2=$(mktemp -d)
TMPDIRS+=("$TMPDIR2")
mkdir -p "$TMPDIR2/skills/another-skill/templates" "$TMPDIR2/skills/another-skill/references"
cat > "$TMPDIR2/skills/another-skill/SKILL.md" << 'EOF'
---
name: another-skill
description: "Another test skill"
---

# Another Skill

This skill also does things.
EOF
cat > "$TMPDIR2/skills/another-skill/references/info.md" << 'EOF'
# Info
Some info here.
EOF
cat > "$TMPDIR2/skills/another-skill/templates/orphan-template.json" << 'EOF'
{ "key": "value" }
EOF
assert_exit "TemplatesDir_OrphanedFile_ExitsOne" 1 bash "$SCRIPT" --repo-root "$TMPDIR2"

# ============================================================
# Test 3: PhasesDir_AllLinked_ExitsZero
# All phase files referenced from SKILL.md or references/
# ============================================================
TMPDIR3=$(mktemp -d)
TMPDIRS+=("$TMPDIR3")
mkdir -p "$TMPDIR3/skills/linked-skill/phases" "$TMPDIR3/skills/linked-skill/references"
cat > "$TMPDIR3/skills/linked-skill/SKILL.md" << 'EOF'
---
name: linked-skill
description: "A skill with linked phases"
---

# Linked Skill

See phases/explore.md for the explore phase.
EOF
cat > "$TMPDIR3/skills/linked-skill/references/track.md" << 'EOF'
# Track
See phases/implement.md for implementation details.
EOF
cat > "$TMPDIR3/skills/linked-skill/phases/explore.md" << 'EOF'
# Explore Phase
Exploration steps.
EOF
cat > "$TMPDIR3/skills/linked-skill/phases/implement.md" << 'EOF'
# Implement Phase
Implementation steps.
EOF
assert_exit "PhasesDir_AllLinked_ExitsZero" 0 bash "$SCRIPT" --repo-root "$TMPDIR3"

# ============================================================
# Test 4: TemplatesDir_AllLinked_ExitsZero
# All template files referenced from SKILL.md or references/
# ============================================================
TMPDIR4=$(mktemp -d)
TMPDIRS+=("$TMPDIR4")
mkdir -p "$TMPDIR4/skills/tmpl-skill/templates" "$TMPDIR4/skills/tmpl-skill/references"
cat > "$TMPDIR4/skills/tmpl-skill/SKILL.md" << 'EOF'
---
name: tmpl-skill
description: "A skill with linked templates"
---

# Template Skill

Use the config.json template for setup.
EOF
cat > "$TMPDIR4/skills/tmpl-skill/references/usage.md" << 'EOF'
# Usage
Copy settings.yaml to your project root.
EOF
cat > "$TMPDIR4/skills/tmpl-skill/templates/config.json" << 'EOF'
{ "setting": true }
EOF
cat > "$TMPDIR4/skills/tmpl-skill/templates/settings.yaml" << 'EOF'
setting: true
EOF
assert_exit "TemplatesDir_AllLinked_ExitsZero" 0 bash "$SCRIPT" --repo-root "$TMPDIR4"

# ============================================================
# Test 5: NoNonStandardDirs_ExitsZero
# A skill with only references/ (no phases/ or templates/) should pass
# ============================================================
TMPDIR5=$(mktemp -d)
TMPDIRS+=("$TMPDIR5")
mkdir -p "$TMPDIR5/skills/simple-skill/references"
cat > "$TMPDIR5/skills/simple-skill/SKILL.md" << 'EOF'
---
name: simple-skill
description: "A simple skill"
---

# Simple Skill
EOF
cat > "$TMPDIR5/skills/simple-skill/references/guide.md" << 'EOF'
# Guide
EOF
assert_exit "NoNonStandardDirs_ExitsZero" 0 bash "$SCRIPT" --repo-root "$TMPDIR5"

# ============================================================
# Test 6: UsageError_ExitsTwo
# Missing value for --repo-root flag
# ============================================================
assert_exit "UsageError_ExitsTwo" 2 bash "$SCRIPT" --repo-root

echo
echo "---"
echo "**Results:** $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
