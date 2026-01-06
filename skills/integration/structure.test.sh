#!/usr/bin/env bash
set -euo pipefail

# Test 1: Directory exists
if [[ ! -d "skills/integration" ]]; then
    echo "FAIL: skills/integration/ directory does not exist"
    exit 1
fi

# Test 2: SKILL.md exists
if [[ ! -f "skills/integration/SKILL.md" ]]; then
    echo "FAIL: skills/integration/SKILL.md does not exist"
    exit 1
fi

# Test 3: references/ directory exists
if [[ ! -d "skills/integration/references" ]]; then
    echo "FAIL: skills/integration/references/ directory does not exist"
    exit 1
fi

# Test 4: SKILL.md has basic structure (at least a title)
if ! grep -q "# Integration Skill" "skills/integration/SKILL.md"; then
    echo "FAIL: SKILL.md missing '# Integration Skill' title"
    exit 1
fi

echo "PASS: All tests passed"
