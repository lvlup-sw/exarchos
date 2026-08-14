#!/usr/bin/env bash
# Renovate Configuration Validation Test
# Validates JSON syntax and required fields for Renovate configuration

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Verify jq is available
if ! command -v jq &> /dev/null; then
    echo -e "${RED}ERROR${NC}: jq is not installed. Please install jq to run these tests."
    echo "  macOS: brew install jq"
    echo "  Ubuntu/Debian: apt-get install jq"
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

# Test 1: renovate.json exists
echo "=== Testing renovate.json ==="
if [[ -f "$SCRIPT_DIR/renovate.json" ]]; then
    pass "renovate.json exists"
else
    fail "renovate.json does not exist"
fi

# Test 2: renovate.json is valid JSON
if [[ -f "$SCRIPT_DIR/renovate.json" ]]; then
    if jq empty "$SCRIPT_DIR/renovate.json" 2>/dev/null; then
        pass "renovate.json is valid JSON"
    else
        fail "renovate.json is not valid JSON"
    fi
fi

# Test 3: renovate.json extends config:recommended
if [[ -f "$SCRIPT_DIR/renovate.json" ]]; then
    if jq -e '.extends | index("config:recommended")' "$SCRIPT_DIR/renovate.json" >/dev/null 2>&1; then
        pass "renovate.json extends config:recommended"
    else
        fail "renovate.json does not extend config:recommended"
    fi
fi

# Test 4: Auto-merge enabled for patch updates only
if [[ -f "$SCRIPT_DIR/renovate.json" ]]; then
    # Verify automerge is enabled for patch and NOT for minor/major
    PATCH_AUTOMERGE=$(jq '[.packageRules[] | select((.updateTypes == ["patch"] or .matchUpdateTypes == ["patch"]) and .automerge == true)] | length' "$SCRIPT_DIR/renovate.json" 2>/dev/null)
    NON_PATCH_AUTOMERGE=$(jq '[.packageRules[] | select((.updateTypes // .matchUpdateTypes) as $types | ($types != ["patch"] and ($types | length) > 0) and .automerge == true)] | length' "$SCRIPT_DIR/renovate.json" 2>/dev/null)
    
    if [[ "$PATCH_AUTOMERGE" -gt 0 && "$NON_PATCH_AUTOMERGE" -eq 0 ]]; then
        pass "Auto-merge enabled for patch updates only"
    else
        fail "Auto-merge not properly configured for patch updates"
    fi
fi

# Test 5: Schedule set to weekends (case-insensitive check)
if [[ -f "$SCRIPT_DIR/renovate.json" ]]; then
    if jq -e '.schedule | map(ascii_downcase) | any(contains("weekend") or contains("saturday") or contains("sunday"))' "$SCRIPT_DIR/renovate.json" >/dev/null 2>&1; then
        pass "Schedule includes weekends"
    else
        fail "Schedule does not include weekends"
    fi
fi

# Test 6: Timezone set to America/Denver
if [[ -f "$SCRIPT_DIR/renovate.json" ]]; then
    if jq -e '.timezone == "America/Denver"' "$SCRIPT_DIR/renovate.json" >/dev/null 2>&1; then
        pass "Timezone set to America/Denver"
    else
        fail "Timezone not set to America/Denver"
    fi
fi

# Test 7: Rate limiting configured
if [[ -f "$SCRIPT_DIR/renovate.json" ]]; then
    if jq -e '.prConcurrentLimit == 10 and .prHourlyLimit == 2' "$SCRIPT_DIR/renovate.json" >/dev/null 2>&1; then
        pass "Rate limiting configured (10 concurrent, 2 per hour)"
    else
        fail "Rate limiting not properly configured"
    fi
fi

# Test 8: presets/dotnet.json exists
echo ""
echo "=== Testing presets/dotnet.json ==="
if [[ -f "$SCRIPT_DIR/presets/dotnet.json" ]]; then
    pass "presets/dotnet.json exists"
else
    fail "presets/dotnet.json does not exist"
fi

# Test 9: presets/dotnet.json is valid JSON
if [[ -f "$SCRIPT_DIR/presets/dotnet.json" ]]; then
    if jq empty "$SCRIPT_DIR/presets/dotnet.json" 2>/dev/null; then
        pass "presets/dotnet.json is valid JSON"
    else
        fail "presets/dotnet.json is not valid JSON"
    fi
fi

# Test 10: dotnet.json contains package groupings
if [[ -f "$SCRIPT_DIR/presets/dotnet.json" ]]; then
    GROUPS_FOUND=0

    # Check for aspire group
    if jq -e '.packageRules[] | select(.groupName | test("aspire"; "i"))' "$SCRIPT_DIR/presets/dotnet.json" >/dev/null 2>&1; then
        GROUPS_FOUND=$((GROUPS_FOUND + 1))
    fi

    # Check for Wolverine group
    if jq -e '.packageRules[] | select(.groupName | test("wolverine"; "i"))' "$SCRIPT_DIR/presets/dotnet.json" >/dev/null 2>&1; then
        GROUPS_FOUND=$((GROUPS_FOUND + 1))
    fi

    # Check for OpenTelemetry group
    if jq -e '.packageRules[] | select(.groupName | test("opentelemetry"; "i"))' "$SCRIPT_DIR/presets/dotnet.json" >/dev/null 2>&1; then
        GROUPS_FOUND=$((GROUPS_FOUND + 1))
    fi

    # Check for xunit group
    if jq -e '.packageRules[] | select(.groupName | test("xunit"; "i"))' "$SCRIPT_DIR/presets/dotnet.json" >/dev/null 2>&1; then
        GROUPS_FOUND=$((GROUPS_FOUND + 1))
    fi

    # Check for Microsoft.Extensions group
    if jq -e '.packageRules[] | select(.groupName | test("microsoft.*extensions"; "i"))' "$SCRIPT_DIR/presets/dotnet.json" >/dev/null 2>&1; then
        GROUPS_FOUND=$((GROUPS_FOUND + 1))
    fi

    if [[ $GROUPS_FOUND -ge 5 ]]; then
        pass "All 5 package groups configured"
    else
        fail "Only $GROUPS_FOUND/5 package groups found"
    fi
fi

# Test 11: .NET SDK updates enabled
if [[ -f "$SCRIPT_DIR/presets/dotnet.json" ]]; then
    if jq -e '.enabledManagers | index("nuget")' "$SCRIPT_DIR/presets/dotnet.json" >/dev/null 2>&1 || \
       jq -e '.nuget' "$SCRIPT_DIR/presets/dotnet.json" >/dev/null 2>&1; then
        pass ".NET/NuGet support configured"
    else
        fail ".NET/NuGet support not configured"
    fi
fi

# Summary
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
