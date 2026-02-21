#!/usr/bin/env bash
# Validate .NET Standards
# Checks .NET project structure compliance: required files, CPM configuration,
# editorconfig, global.json, and no inline package versions.
#
# Usage: validate-dotnet-standards.sh --project-root <path>
#
# Exit codes:
#   0 = project is compliant
#   1 = violations found
#   2 = usage error (missing required args)

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

PROJECT_ROOT=""

usage() {
    cat << 'USAGE'
Usage: validate-dotnet-standards.sh --project-root <path>

Required:
  --project-root <path>   Root directory of the .NET project

Optional:
  --help                  Show this help message

Exit codes:
  0  Project is compliant
  1  Violations found
  2  Usage error (missing required args)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project-root)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --project-root requires a path argument" >&2
                exit 2
            fi
            PROJECT_ROOT="$2"
            shift 2
            ;;
        --help)
            usage
            exit 0
            ;;
        *)
            echo "Error: Unknown argument '$1'" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [[ -z "$PROJECT_ROOT" ]]; then
    echo "Error: --project-root is required" >&2
    usage >&2
    exit 2
fi

# ============================================================
# CHECK FUNCTIONS
# ============================================================

CHECK_PASS=0
CHECK_FAIL=0
RESULTS=()

check_pass() {
    local name="$1"
    RESULTS+=("- **PASS**: $name")
    CHECK_PASS=$((CHECK_PASS + 1))
}

check_fail() {
    local name="$1"
    local detail="${2:-}"
    if [[ -n "$detail" ]]; then
        RESULTS+=("- **FAIL**: $name — $detail")
    else
        RESULTS+=("- **FAIL**: $name")
    fi
    CHECK_FAIL=$((CHECK_FAIL + 1))
}

# ============================================================
# CHECK 1: Directory.Build.props exists
# ============================================================

check_build_props() {
    local build_props="$PROJECT_ROOT/src/Directory.Build.props"
    if [[ -f "$build_props" ]]; then
        check_pass "Directory.Build.props exists"
        return 0
    else
        check_fail "Directory.Build.props exists" "Not found at $build_props"
        return 1
    fi
}

# ============================================================
# CHECK 2: Directory.Packages.props exists
# ============================================================

check_packages_props_exists() {
    local packages_props="$PROJECT_ROOT/src/Directory.Packages.props"
    if [[ -f "$packages_props" ]]; then
        check_pass "Directory.Packages.props exists"
        return 0
    else
        check_fail "Directory.Packages.props exists" "Not found at $packages_props"
        return 1
    fi
}

# ============================================================
# CHECK 3: CPM is enabled in Directory.Packages.props
# ============================================================

check_cpm_enabled() {
    local packages_props="$PROJECT_ROOT/src/Directory.Packages.props"

    if [[ ! -f "$packages_props" ]]; then
        # Already reported by check_packages_props_exists
        return 1
    fi

    if grep -qE '<ManagePackageVersionsCentrally>[[:space:]]*true[[:space:]]*</ManagePackageVersionsCentrally>' "$packages_props"; then
        check_pass "Central Package Management (CPM) enabled"
        return 0
    else
        check_fail "Central Package Management (CPM) enabled" "ManagePackageVersionsCentrally is not set to true in Directory.Packages.props"
        return 1
    fi
}

# ============================================================
# CHECK 4: .editorconfig exists
# ============================================================

check_editorconfig() {
    local editorconfig="$PROJECT_ROOT/src/.editorconfig"
    if [[ -f "$editorconfig" ]]; then
        check_pass ".editorconfig exists"
        return 0
    else
        check_fail ".editorconfig exists" "Not found at $editorconfig"
        return 1
    fi
}

# ============================================================
# CHECK 5: global.json exists with SDK version
# ============================================================

check_global_json() {
    local global_json="$PROJECT_ROOT/src/global.json"

    if [[ ! -f "$global_json" ]]; then
        check_fail "global.json exists" "Not found at $global_json"
        return 1
    fi

    # Check for sdk.version field
    if command -v jq &>/dev/null; then
        local sdk_version
        if ! sdk_version="$(jq -r '.sdk.version // empty' "$global_json" 2>/dev/null)"; then
            check_fail "global.json valid" "Invalid JSON in $global_json"
            return 1
        fi
        if [[ -n "$sdk_version" ]]; then
            check_pass "global.json exists (SDK $sdk_version)"
            return 0
        else
            check_fail "global.json exists" "File exists but sdk.version is not specified"
            return 1
        fi
    else
        # Fallback: just check file contains "version"
        if grep -q '"version"' "$global_json"; then
            check_pass "global.json exists (with version)"
            return 0
        else
            check_fail "global.json exists" "File exists but no version field found"
            return 1
        fi
    fi
}

# ============================================================
# CHECK 6: No inline PackageReference with Version in .csproj
# ============================================================

check_no_inline_versions() {
    # Find all .csproj files under src/
    local src_dir="$PROJECT_ROOT/src"
    if [[ ! -d "$src_dir" ]]; then
        check_pass "No inline package versions (no src/ directory)"
        return 0
    fi

    local violations=()
    while IFS= read -r csproj_file; do
        [[ -z "$csproj_file" ]] && continue
        # Check for PackageReference with Version attribute (but not in Directory.Build.props)
        local basename
        basename="$(basename "$csproj_file")"
        if [[ "$basename" == "Directory.Build.props" || "$basename" == "Directory.Packages.props" ]]; then
            continue
        fi
        if grep -qE '<PackageReference\s+[^>]*Version\s*=' "$csproj_file"; then
            violations+=("$csproj_file")
        fi
    done < <(find "$src_dir" -name '*.csproj' -type f 2>/dev/null)

    if [[ -z "${violations+x}" ]] || [[ ${#violations[@]} -eq 0 ]]; then
        check_pass "No inline package versions in .csproj files"
        return 0
    else
        local violation_list
        violation_list="$(printf '%s\n' "${violations[@]}" | sed "s|$PROJECT_ROOT/||g" | tr '\n' ', ' | sed 's/, $//')"
        check_fail "No inline package versions in .csproj files" "Inline Version found in: $violation_list"
        return 1
    fi
}

# ============================================================
# EXECUTE CHECKS
# ============================================================

check_build_props || true
check_packages_props_exists || true
check_cpm_enabled || true
check_editorconfig || true
check_global_json || true
check_no_inline_versions || true

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## .NET Standards Compliance Report"
echo ""
echo "**Project root:** \`$PROJECT_ROOT\`"
echo ""

for result in "${RESULTS[@]}"; do
    echo "$result"
done

echo ""
TOTAL=$((CHECK_PASS + CHECK_FAIL))
echo "---"
echo ""

if [[ $CHECK_FAIL -eq 0 ]]; then
    echo "**Result: PASS** ($CHECK_PASS/$TOTAL checks passed)"
    exit 0
else
    echo "**Result: FAIL** ($CHECK_FAIL/$TOTAL checks failed)"
    exit 1
fi
