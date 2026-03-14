#!/usr/bin/env bash
# Validate Phase Names
# Ensures skill docs use HSM-authoritative phase IDs (not display names or legacy action strings).
#
# Usage: validate-phase-names.sh --repo-root <path>
#
# Exit codes:
#   0 = all phase names valid
#   1 = mismatches found
#   2 = usage error
set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

REPO_ROOT=""

usage() {
    cat << 'USAGE'
Usage: validate-phase-names.sh --repo-root <path>

Validate that skill docs use HSM-authoritative phase IDs.

Required:
  --repo-root <path>    Repository root (must contain dist/ and skills/)

Exit codes:
  0  All phase names valid
  1  Mismatches found
  2  Usage error
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo-root)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --repo-root requires a path argument" >&2
                exit 2
            fi
            REPO_ROOT="$2"
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

if [[ -z "$REPO_ROOT" ]]; then
    echo "Error: --repo-root is required" >&2
    usage >&2
    exit 2
fi

if [[ ! -d "$REPO_ROOT/skills" ]]; then
    echo "Error: No skills/ directory found at $REPO_ROOT" >&2
    exit 2
fi

# ============================================================
# EXTRACT VALID PHASE IDS FROM HSM
# ============================================================

# Skip gracefully if dist doesn't exist (e.g. in worktrees)
MCP_DIST="$REPO_ROOT/servers/exarchos-mcp/dist"
if [[ ! -d "$MCP_DIST" ]]; then
    echo "## Phase Name Validation Report"
    echo ""
    echo "Skipped: MCP server not built (dist/ not found). Run 'npm run build' first."
    echo ""
    echo "**Result: SKIP**"
    exit 0
fi

# Extract phase IDs from HSM definitions via Node
VALID_PHASES_JSON="$(node -e '
  const { createFeatureHSM } = require("'"$MCP_DIST"'/workflow/hsm-definitions.js");
  const { createDebugHSM } = require("'"$MCP_DIST"'/workflow/hsm-definitions.js");
  const { createRefactorHSM } = require("'"$MCP_DIST"'/workflow/hsm-definitions.js");
  const result = {
    feature: Object.keys(createFeatureHSM().states),
    debug: Object.keys(createDebugHSM().states),
    refactor: Object.keys(createRefactorHSM().states),
  };
  // Add compound parent IDs as valid (they are real HSM states even if not leaf phases)
  console.log(JSON.stringify(result));
' 2>&1)" || {
    echo "Error: Failed to extract HSM phase IDs" >&2
    echo "$VALID_PHASES_JSON" >&2
    exit 2
}

# Build a flat set of all valid phase IDs across all workflow types
ALL_VALID_PHASES="$(echo "$VALID_PHASES_JSON" | node -e '
  const input = require("fs").readFileSync(0, "utf-8");
  const data = JSON.parse(input);
  const all = new Set();
  for (const phases of Object.values(data)) {
    for (const p of phases) all.add(p);
  }
  for (const p of all) console.log(p);
')"

# ============================================================
# COLLECT AND VALIDATE PHASE-AFFINITY FROM SKILL FRONTMATTER
# ============================================================

ERRORS=()

# Parse phase-affinity from SKILL.md frontmatter
for skill_md in "$REPO_ROOT"/skills/*/SKILL.md; do
    [[ ! -f "$skill_md" ]] && continue

    # Skip test fixtures
    if [[ "$skill_md" == *"/test-fixtures/"* ]]; then
        continue
    fi

    skill_name="$(basename "$(dirname "$skill_md")")"

    # Extract frontmatter (between --- fences)
    in_frontmatter=false
    in_affinity=false
    line_num=0
    while IFS= read -r line; do
        line_num=$((line_num + 1))
        if [[ "$line" == "---" ]]; then
            if [[ "$in_frontmatter" == true ]]; then
                break  # End of frontmatter
            else
                in_frontmatter=true
                continue
            fi
        fi

        if [[ "$in_frontmatter" != true ]]; then
            continue
        fi

        # Detect phase-affinity key
        if [[ "$line" =~ ^[[:space:]]*phase-affinity: ]]; then
            # Check for inline value (single string)
            value="${line#*phase-affinity:}"
            value="${value#"${value%%[![:space:]]*}"}"  # trim leading whitespace
            if [[ -n "$value" ]]; then
                # Single-value phase-affinity
                if ! echo "$ALL_VALID_PHASES" | grep -qx "$value"; then
                    ERRORS+=("$skill_md:$line_num: phase-affinity '$value' is not a valid HSM phase ID")
                fi
                continue
            fi
            in_affinity=true
            continue
        fi

        # Parse list items under phase-affinity
        if [[ "$in_affinity" == true ]]; then
            if [[ "$line" =~ ^[[:space:]]*-[[:space:]]+(.*) ]]; then
                phase_value="${BASH_REMATCH[1]}"
                phase_value="${phase_value#"${phase_value%%[![:space:]]*}"}"  # trim
                if ! echo "$ALL_VALID_PHASES" | grep -qx "$phase_value"; then
                    ERRORS+=("$skill_md:$line_num: phase-affinity '$phase_value' is not a valid HSM phase ID")
                fi
            else
                in_affinity=false  # End of list
            fi
        fi
    done < "$skill_md"
done

# ============================================================
# OUTPUT
# ============================================================

echo "## Phase Name Validation Report"
echo ""

if [[ ${#ERRORS[@]} -eq 0 ]]; then
    echo "All phase-affinity values match HSM phase IDs."
    echo ""
    echo "**Result: PASS**"
    exit 0
else
    echo "**Issues found: ${#ERRORS[@]}**"
    echo ""
    for err in "${ERRORS[@]}"; do
        echo "- $err"
    done
    echo ""
    echo "**Result: FAIL**"
    exit 1
fi
