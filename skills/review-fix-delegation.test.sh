#!/usr/bin/env bash
set -euo pipefail

SPEC_FILE="skills/spec-review/SKILL.md"
QUALITY_FILE="skills/quality-review/SKILL.md"

# Test 1: Spec review file exists
if [[ ! -f "$SPEC_FILE" ]]; then
    echo "FAIL: $SPEC_FILE does not exist"
    exit 1
fi

# Test 2: Quality review file exists
if [[ ! -f "$QUALITY_FILE" ]]; then
    echo "FAIL: $QUALITY_FILE does not exist"
    exit 1
fi

# Test 3: Spec review transition mentions delegate --fixes
if ! grep -q 'delegate.*--fixes\|--fixes.*delegate' "$SPEC_FILE"; then
    echo "FAIL: Spec review missing 'delegate --fixes' in transition"
    exit 1
fi

# Test 4: Quality review transition mentions delegate --fixes
if ! grep -q 'delegate.*--fixes\|--fixes.*delegate' "$QUALITY_FILE"; then
    echo "FAIL: Quality review missing 'delegate --fixes' in transition"
    exit 1
fi

# Test 5: At least one skill mentions auto-invoke delegate on failure
if ! grep -q 'Auto-invoke.*delegate\|auto-continue.*delegate\|invoke.*delegate' "$SPEC_FILE" && \
   ! grep -q 'Auto-invoke.*delegate\|auto-continue.*delegate\|invoke.*delegate' "$QUALITY_FILE"; then
    echo "FAIL: No auto-invoke delegate reference found in review skills"
    exit 1
fi

echo "PASS: All tests passed"
