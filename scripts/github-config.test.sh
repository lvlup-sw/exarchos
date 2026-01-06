#!/usr/bin/env bash
# GitHub Configuration Validation Test
# Validates all GitHub config files created for project management

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
GITHUB_DIR="$REPO_ROOT/.github"
PASS=0
FAIL=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Verify Python with yaml is available
if ! python3 -c "import yaml" 2>/dev/null; then
    echo -e "${RED}ERROR${NC}: Python yaml module is not installed."
    echo "  Install with: pip install pyyaml"
    exit 1
fi

pass() {
    echo -e "${GREEN}PASS${NC}: $1"
    PASS=$((PASS + 1))
}

fail() {
    echo -e "${RED}FAIL${NC}: $1"
    FAIL=$((FAIL + 1))
}

# Helper function to validate YAML syntax using Python
validate_yaml() {
    python3 -c "import yaml; yaml.safe_load(open('$1'))" 2>/dev/null
}

# Helper function to get YAML value using Python
yaml_get() {
    local file="$1"
    local expr="$2"
    python3 -c "
import yaml
with open('$file') as f:
    data = yaml.safe_load(f)
$expr
" 2>/dev/null
}

# ============================================================
# LABELS CONFIGURATION TESTS
# ============================================================
echo "=== Testing Labels Configuration ==="

# Test 1: labels.yml exists
if [[ -f "$GITHUB_DIR/labels.yml" ]]; then
    pass "labels.yml exists"
else
    fail "labels.yml does not exist"
fi

# Test 2: labels.yml is valid YAML
if [[ -f "$GITHUB_DIR/labels.yml" ]]; then
    if validate_yaml "$GITHUB_DIR/labels.yml"; then
        pass "labels.yml is valid YAML"
    else
        fail "labels.yml is not valid YAML"
    fi
fi

# Test 3: Contains all 14 required labels
if [[ -f "$GITHUB_DIR/labels.yml" ]]; then
    LABEL_COUNT=$(python3 -c "
import yaml
with open('$GITHUB_DIR/labels.yml') as f:
    data = yaml.safe_load(f)
print(len(data) if data else 0)
" 2>/dev/null || echo "0")
    if [[ "$LABEL_COUNT" -ge 14 ]]; then
        pass "labels.yml contains $LABEL_COUNT labels (expected >= 14)"
    else
        fail "labels.yml contains only $LABEL_COUNT labels (expected >= 14)"
    fi
fi

# Test 4: Each label has name, color, description
if [[ -f "$GITHUB_DIR/labels.yml" ]]; then
    INVALID_COUNT=$(python3 -c "
import yaml
with open('$GITHUB_DIR/labels.yml') as f:
    data = yaml.safe_load(f)
invalid = 0
for label in data or []:
    if not label.get('name') or not label.get('color') or not label.get('description'):
        invalid += 1
print(invalid)
" 2>/dev/null || echo "0")

    if [[ "$INVALID_COUNT" -eq 0 ]]; then
        pass "All labels have name, color, and description"
    else
        fail "$INVALID_COUNT labels missing required fields (name, color, or description)"
    fi
fi

# Test 5: Required label categories exist
if [[ -f "$GITHUB_DIR/labels.yml" ]]; then
    MISSING=$(python3 -c "
import yaml
with open('$GITHUB_DIR/labels.yml') as f:
    data = yaml.safe_load(f)
required = [
    'type:bug', 'type:feature', 'type:docs', 'type:chore', 'type:question',
    'scope:workflow', 'scope:jules', 'scope:templates', 'scope:rules',
    'status:triage', 'status:blocked', 'status:stale',
    'priority:high', 'priority:low'
]
present = {label.get('name') for label in data or []}
missing = [r for r in required if r not in present]
print(' '.join(missing) if missing else '')
" 2>/dev/null)

    if [[ -z "$MISSING" ]]; then
        pass "All 14 required labels present"
    else
        fail "Missing labels: $MISSING"
    fi
fi

# ============================================================
# ISSUE TEMPLATES TESTS
# ============================================================
echo ""
echo "=== Testing Issue Templates ==="

# Test 6: bug.yml exists
if [[ -f "$GITHUB_DIR/ISSUE_TEMPLATE/bug.yml" ]]; then
    pass "ISSUE_TEMPLATE/bug.yml exists"
else
    fail "ISSUE_TEMPLATE/bug.yml does not exist"
fi

# Test 7: bug.yml is valid YAML
if [[ -f "$GITHUB_DIR/ISSUE_TEMPLATE/bug.yml" ]]; then
    if validate_yaml "$GITHUB_DIR/ISSUE_TEMPLATE/bug.yml"; then
        pass "bug.yml is valid YAML"
    else
        fail "bug.yml is not valid YAML"
    fi
fi

# Test 8: bug.yml has required fields
if [[ -f "$GITHUB_DIR/ISSUE_TEMPLATE/bug.yml" ]]; then
    VALID=$(python3 -c "
import yaml
with open('$GITHUB_DIR/ISSUE_TEMPLATE/bug.yml') as f:
    data = yaml.safe_load(f)
valid = data.get('name') and data.get('description') and data.get('body')
print('yes' if valid else 'no')
" 2>/dev/null)

    if [[ "$VALID" == "yes" ]]; then
        pass "bug.yml has required fields (name, description, body)"
    else
        fail "bug.yml missing required fields"
    fi
fi

# Test 9: feature.yml exists
if [[ -f "$GITHUB_DIR/ISSUE_TEMPLATE/feature.yml" ]]; then
    pass "ISSUE_TEMPLATE/feature.yml exists"
else
    fail "ISSUE_TEMPLATE/feature.yml does not exist"
fi

# Test 10: feature.yml is valid YAML
if [[ -f "$GITHUB_DIR/ISSUE_TEMPLATE/feature.yml" ]]; then
    if validate_yaml "$GITHUB_DIR/ISSUE_TEMPLATE/feature.yml"; then
        pass "feature.yml is valid YAML"
    else
        fail "feature.yml is not valid YAML"
    fi
fi

# Test 11: feature.yml has required fields
if [[ -f "$GITHUB_DIR/ISSUE_TEMPLATE/feature.yml" ]]; then
    VALID=$(python3 -c "
import yaml
with open('$GITHUB_DIR/ISSUE_TEMPLATE/feature.yml') as f:
    data = yaml.safe_load(f)
valid = data.get('name') and data.get('description') and data.get('body')
print('yes' if valid else 'no')
" 2>/dev/null)

    if [[ "$VALID" == "yes" ]]; then
        pass "feature.yml has required fields (name, description, body)"
    else
        fail "feature.yml missing required fields"
    fi
fi

# Test 12: config.yml exists
if [[ -f "$GITHUB_DIR/ISSUE_TEMPLATE/config.yml" ]]; then
    pass "ISSUE_TEMPLATE/config.yml exists"
else
    fail "ISSUE_TEMPLATE/config.yml does not exist"
fi

# Test 13: config.yml is valid YAML
if [[ -f "$GITHUB_DIR/ISSUE_TEMPLATE/config.yml" ]]; then
    if validate_yaml "$GITHUB_DIR/ISSUE_TEMPLATE/config.yml"; then
        pass "config.yml is valid YAML"
    else
        fail "config.yml is not valid YAML"
    fi
fi

# ============================================================
# WORKFLOW FILE TESTS
# ============================================================
echo ""
echo "=== Testing Workflow File ==="

# Test 14: project-automation.yml exists
if [[ -f "$GITHUB_DIR/workflows/project-automation.yml" ]]; then
    pass "workflows/project-automation.yml exists"
else
    fail "workflows/project-automation.yml does not exist"
fi

# Test 15: project-automation.yml is valid YAML
if [[ -f "$GITHUB_DIR/workflows/project-automation.yml" ]]; then
    if validate_yaml "$GITHUB_DIR/workflows/project-automation.yml"; then
        pass "project-automation.yml is valid YAML"
    else
        fail "project-automation.yml is not valid YAML"
    fi
fi

# Test 16: Contains auto-triage job
if [[ -f "$GITHUB_DIR/workflows/project-automation.yml" ]]; then
    HAS_JOB=$(python3 -c "
import yaml
with open('$GITHUB_DIR/workflows/project-automation.yml') as f:
    data = yaml.safe_load(f)
jobs = data.get('jobs', {})
print('yes' if 'auto-triage' in jobs else 'no')
" 2>/dev/null)

    if [[ "$HAS_JOB" == "yes" ]]; then
        pass "project-automation.yml contains auto-triage job"
    else
        fail "project-automation.yml missing auto-triage job"
    fi
fi

# Test 17: Contains stale job
if [[ -f "$GITHUB_DIR/workflows/project-automation.yml" ]]; then
    HAS_JOB=$(python3 -c "
import yaml
with open('$GITHUB_DIR/workflows/project-automation.yml') as f:
    data = yaml.safe_load(f)
jobs = data.get('jobs', {})
print('yes' if 'stale' in jobs else 'no')
" 2>/dev/null)

    if [[ "$HAS_JOB" == "yes" ]]; then
        pass "project-automation.yml contains stale job"
    else
        fail "project-automation.yml missing stale job"
    fi
fi

# Test 18: Contains auto-merge-renovate job
if [[ -f "$GITHUB_DIR/workflows/project-automation.yml" ]]; then
    HAS_JOB=$(python3 -c "
import yaml
with open('$GITHUB_DIR/workflows/project-automation.yml') as f:
    data = yaml.safe_load(f)
jobs = data.get('jobs', {})
print('yes' if 'auto-merge-renovate' in jobs else 'no')
" 2>/dev/null)

    if [[ "$HAS_JOB" == "yes" ]]; then
        pass "project-automation.yml contains auto-merge-renovate job"
    else
        fail "project-automation.yml missing auto-merge-renovate job"
    fi
fi

# Test 19: Contains release job
if [[ -f "$GITHUB_DIR/workflows/project-automation.yml" ]]; then
    HAS_JOB=$(python3 -c "
import yaml
with open('$GITHUB_DIR/workflows/project-automation.yml') as f:
    data = yaml.safe_load(f)
jobs = data.get('jobs', {})
print('yes' if 'release' in jobs else 'no')
" 2>/dev/null)

    if [[ "$HAS_JOB" == "yes" ]]; then
        pass "project-automation.yml contains release job"
    else
        fail "project-automation.yml missing release job"
    fi
fi

# ============================================================
# CHANGELOG CONFIG TESTS
# ============================================================
echo ""
echo "=== Testing Changelog Configuration ==="

# Test 20: cliff.toml exists
if [[ -f "$GITHUB_DIR/cliff.toml" ]]; then
    pass "cliff.toml exists"
else
    fail "cliff.toml does not exist"
fi

# Test 21: cliff.toml contains [changelog] section
if [[ -f "$GITHUB_DIR/cliff.toml" ]]; then
    if grep -q '\[changelog\]' "$GITHUB_DIR/cliff.toml"; then
        pass "cliff.toml contains [changelog] section"
    else
        fail "cliff.toml missing [changelog] section"
    fi
fi

# Test 22: cliff.toml contains [git] section
if [[ -f "$GITHUB_DIR/cliff.toml" ]]; then
    if grep -q '\[git\]' "$GITHUB_DIR/cliff.toml"; then
        pass "cliff.toml contains [git] section"
    else
        fail "cliff.toml missing [git] section"
    fi
fi

# Test 23: cliff.toml contains commit_parsers
if [[ -f "$GITHUB_DIR/cliff.toml" ]]; then
    if grep -q 'commit_parsers' "$GITHUB_DIR/cliff.toml"; then
        pass "cliff.toml contains commit_parsers"
    else
        fail "cliff.toml missing commit_parsers"
    fi
fi

# ============================================================
# SUMMARY
# ============================================================
echo ""
echo "=== Test Summary ==="
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"

if [[ $FAIL -gt 0 ]]; then
    echo ""
    echo -e "${RED}Tests failed!${NC}"
    exit 1
else
    echo ""
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
fi
