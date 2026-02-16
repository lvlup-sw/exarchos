#!/usr/bin/env bash
# Validate .NET Standards — Test Suite
# Validates all assertions for scripts/validate-dotnet-standards.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/validate-dotnet-standards.sh"
PASS=0
FAIL=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
    echo -e "${GREEN}PASS${NC}: $1"
    PASS=$((PASS + 1))
}

fail() {
    echo -e "${RED}FAIL${NC}: $1"
    FAIL=$((FAIL + 1))
}

# ============================================================
# TEST FIXTURES
# ============================================================

TMPDIR_ROOT=""

setup() {
    TMPDIR_ROOT="$(mktemp -d)"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Create a fully compliant .NET project structure
create_compliant_project() {
    local dir="$1"
    mkdir -p "$dir/src"

    # Directory.Build.props
    cat > "$dir/src/Directory.Build.props" << 'EOF'
<Project>
  <PropertyGroup>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Lvlup.Build" Version="1.0.0" PrivateAssets="All" />
  </ItemGroup>
</Project>
EOF

    # Directory.Packages.props with CPM enabled
    cat > "$dir/src/Directory.Packages.props" << 'EOF'
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
EOF

    # .editorconfig
    cat > "$dir/src/.editorconfig" << 'EOF'
root = true

[*]
end_of_line = crlf
indent_style = space
indent_size = 4
EOF

    # global.json
    cat > "$dir/src/global.json" << 'EOF'
{
  "sdk": {
    "version": "8.0.100",
    "rollForward": "latestMinor"
  }
}
EOF

    # A compliant .csproj (no inline Version on PackageReference)
    mkdir -p "$dir/src/MyProject.Core"
    cat > "$dir/src/MyProject.Core/MyProject.Core.csproj" << 'EOF'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" />
  </ItemGroup>
</Project>
EOF
}

# Create a project missing Directory.Build.props
create_missing_build_props() {
    local dir="$1"
    create_compliant_project "$dir"
    rm "$dir/src/Directory.Build.props"
}

# Create a project missing Directory.Packages.props
create_missing_packages_props() {
    local dir="$1"
    create_compliant_project "$dir"
    rm "$dir/src/Directory.Packages.props"
}

# Create a project where CPM is not enabled
create_cpm_not_enabled() {
    local dir="$1"
    create_compliant_project "$dir"
    cat > "$dir/src/Directory.Packages.props" << 'EOF'
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>
  </PropertyGroup>
</Project>
EOF
}

# Create a project with inline Version in csproj
create_inline_version() {
    local dir="$1"
    create_compliant_project "$dir"
    cat > "$dir/src/MyProject.Core/MyProject.Core.csproj" << 'EOF'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
EOF
}

# Create a project missing .editorconfig
create_missing_editorconfig() {
    local dir="$1"
    create_compliant_project "$dir"
    rm "$dir/src/.editorconfig"
}

# Create a project missing global.json
create_missing_global_json() {
    local dir="$1"
    create_compliant_project "$dir"
    rm "$dir/src/global.json"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Validate .NET Standards Tests ==="
echo ""

# --------------------------------------------------
# Test 1: FullyCompliant_ExitsZero
# --------------------------------------------------
setup
create_compliant_project "$TMPDIR_ROOT/project"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --project-root "$TMPDIR_ROOT/project" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "FullyCompliant_ExitsZero"
else
    fail "FullyCompliant_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: MissingBuildProps_ExitsOne
# --------------------------------------------------
setup
create_missing_build_props "$TMPDIR_ROOT/project"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --project-root "$TMPDIR_ROOT/project" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingBuildProps_ExitsOne"
else
    fail "MissingBuildProps_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions Directory.Build.props
if echo "$OUTPUT" | grep -qi "Directory.Build.props"; then
    pass "MissingBuildProps_MentionedInOutput"
else
    fail "MissingBuildProps_MentionedInOutput (expected 'Directory.Build.props' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: MissingPackagesProps_ExitsOne
# --------------------------------------------------
setup
create_missing_packages_props "$TMPDIR_ROOT/project"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --project-root "$TMPDIR_ROOT/project" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingPackagesProps_ExitsOne"
else
    fail "MissingPackagesProps_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions Directory.Packages.props
if echo "$OUTPUT" | grep -qi "Directory.Packages.props"; then
    pass "MissingPackagesProps_MentionedInOutput"
else
    fail "MissingPackagesProps_MentionedInOutput (expected 'Directory.Packages.props' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: CpmNotEnabled_ExitsOne
# --------------------------------------------------
setup
create_cpm_not_enabled "$TMPDIR_ROOT/project"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --project-root "$TMPDIR_ROOT/project" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "CpmNotEnabled_ExitsOne"
else
    fail "CpmNotEnabled_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions CPM
if echo "$OUTPUT" | grep -qi "ManagePackageVersionsCentrally\|CPM\|Central Package"; then
    pass "CpmNotEnabled_MentionedInOutput"
else
    fail "CpmNotEnabled_MentionedInOutput (expected CPM reference in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: InlineVersionInCsproj_ExitsOne
# --------------------------------------------------
setup
create_inline_version "$TMPDIR_ROOT/project"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --project-root "$TMPDIR_ROOT/project" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "InlineVersionInCsproj_ExitsOne"
else
    fail "InlineVersionInCsproj_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions inline version
if echo "$OUTPUT" | grep -qi "Version\|inline\|csproj"; then
    pass "InlineVersionInCsproj_MentionedInOutput"
else
    fail "InlineVersionInCsproj_MentionedInOutput (expected version/csproj reference in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: MissingEditorConfig_ExitsOne
# --------------------------------------------------
setup
create_missing_editorconfig "$TMPDIR_ROOT/project"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --project-root "$TMPDIR_ROOT/project" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingEditorConfig_ExitsOne"
else
    fail "MissingEditorConfig_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions .editorconfig
if echo "$OUTPUT" | grep -qi "editorconfig"; then
    pass "MissingEditorConfig_MentionedInOutput"
else
    fail "MissingEditorConfig_MentionedInOutput (expected 'editorconfig' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: MissingGlobalJson_ExitsOne
# --------------------------------------------------
setup
create_missing_global_json "$TMPDIR_ROOT/project"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --project-root "$TMPDIR_ROOT/project" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingGlobalJson_ExitsOne"
else
    fail "MissingGlobalJson_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions global.json
if echo "$OUTPUT" | grep -qi "global.json"; then
    pass "MissingGlobalJson_MentionedInOutput"
else
    fail "MissingGlobalJson_MentionedInOutput (expected 'global.json' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: UsageError_NoProjectRoot_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_NoProjectRoot_ExitsTwo"
else
    fail "UsageError_NoProjectRoot_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

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
