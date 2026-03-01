#!/usr/bin/env bash
# Check Design Completeness (Adversarial Gate: ideate → plan)
# Validates that a design document contains numbered requirements with
# acceptance criteria and error/edge case coverage.
#
# This is the D1 (spec fidelity) lightweight gate check at the ideate → plan
# boundary. Findings are advisory (MEDIUM severity) — they don't block the
# auto-chain to /plan, but are recorded as events.
#
# Usage: check-design-completeness.sh --design-file <path>
#
# Exit codes:
#   0 = all checks pass (design complete)
#   1 = one or more findings (advisory — design has gaps)
#   2 = usage error (missing required args, file not found)

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

DESIGN_FILE=""

usage() {
    cat << 'USAGE'
Usage: check-design-completeness.sh --design-file <path>

Required:
  --design-file <path>   Path to the design document (.md)

Optional:
  --help                 Show this help message

Checks:
  1. Design has numbered requirements (DR-N, REQ-N, or R-N pattern)
  2. Each requirement has acceptance criteria
  3. Design covers error/edge cases (not just happy path)

Exit codes:
  0  All checks pass (design complete)
  1  Findings detected (advisory — gaps in design)
  2  Usage error (missing args, file not found)

Findings are written to stderr in structured format.
Summary report is written to stdout.
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --design-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --design-file requires a path argument" >&2
                exit 2
            fi
            DESIGN_FILE="$2"
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

if [[ -z "$DESIGN_FILE" ]]; then
    echo "Error: --design-file is required" >&2
    usage >&2
    exit 2
fi

if [[ ! -f "$DESIGN_FILE" ]]; then
    echo "Error: Design file not found: $DESIGN_FILE" >&2
    exit 2
fi

# ============================================================
# STATE
# ============================================================

FINDINGS=()
CHECK_PASS=0
CHECK_FAIL=0

finding() {
    local criterion="$1"
    local evidence="$2"
    FINDINGS+=("FINDING [D1] [MEDIUM] criterion=\"$criterion\" evidence=\"$evidence\"")
    CHECK_FAIL=$((CHECK_FAIL + 1))
}

check_pass() {
    CHECK_PASS=$((CHECK_PASS + 1))
}

# ============================================================
# READ DESIGN DOCUMENT
# ============================================================

CONTENT="$(cat "$DESIGN_FILE")"

# ============================================================
# CHECK 1: Numbered requirements exist
# Accepts: DR-N, REQ-N, R-N (case-insensitive, in headings or inline)
# ============================================================

# Extract requirement IDs — match DR-N, REQ-N, or R-N patterns
REQ_IDS=()
while IFS= read -r req_id; do
    [[ -n "$req_id" ]] && REQ_IDS+=("$req_id")
done < <(echo "$CONTENT" | grep -oEi '(DR|REQ|R)-[0-9]+' | sort -u -t'-' -k1,1 -k2,2n)

if [[ ${#REQ_IDS[@]} -eq 0 ]]; then
    finding "Design must have numbered requirements (DR-N, REQ-N, or R-N pattern)" \
        "No structured requirement identifiers found in $DESIGN_FILE"
else
    check_pass
fi

# ============================================================
# CHECK 2: Each requirement has acceptance criteria
# For each DR-N/REQ-N found, verify its section contains
# "acceptance criteria" (case-insensitive)
# ============================================================

if [[ ${#REQ_IDS[@]} -gt 0 ]]; then
    MISSING_CRITERIA=()

    for req_id in "${REQ_IDS[@]}"; do
        # Extract the section for this requirement:
        # From the line containing the req_id to the next heading of same or higher level, or EOF
        # We use awk to extract the section
        SECTION="$(echo "$CONTENT" | awk -v id="$req_id" '
            BEGIN { found=0; printing=0 }
            $0 ~ id { found=1; printing=1; next }
            printing && /^##/ { printing=0 }
            printing { print }
        ')"

        # Check for structural acceptance criteria markers:
        # **Acceptance criteria:** or #### Acceptance criteria or - Acceptance criteria:
        # Plain text mentions (e.g., "has no acceptance criteria") don't count.
        if ! echo "$SECTION" | grep -qiE '^\*\*[Aa]cceptance [Cc]riteri|^#+\s*[Aa]cceptance [Cc]riteri|^-\s*\*\*[Aa]cceptance'; then
            MISSING_CRITERIA+=("$req_id")
        fi
    done

    if [[ ${#MISSING_CRITERIA[@]} -gt 0 ]]; then
        missing_list="$(IFS=', '; echo "${MISSING_CRITERIA[*]}")"
        finding "Each requirement must have acceptance criteria" \
            "Missing acceptance criteria for: $missing_list"
    else
        check_pass
    fi
fi

# ============================================================
# CHECK 3: Error/edge case coverage
# The design must address failure modes, not just happy path.
# Look for keywords indicating error/edge case awareness.
# ============================================================

ERROR_KEYWORDS='error|edge case|failure|invalid|boundary|timeout|reject|retry|exception|fault|fallback|abort|overflow|race condition|concurrent|malformed|unauthorized|forbidden|not found|rate limit|throttl'

if echo "$CONTENT" | grep -qiE "$ERROR_KEYWORDS"; then
    check_pass
else
    finding "Design must cover error/edge cases, not just happy path" \
        "No error handling, edge case, or failure mode keywords found in design"
fi

# ============================================================
# OUTPUT: Findings to stderr
# ============================================================

for f in "${FINDINGS[@]}"; do
    echo "$f" >&2
done

# ============================================================
# OUTPUT: Summary to stdout
# ============================================================

TOTAL=$((CHECK_PASS + CHECK_FAIL))

echo "## Design Completeness Report"
echo ""
echo "**Design file:** \`$DESIGN_FILE\`"
echo "**Requirements found:** ${#REQ_IDS[@]}"
if [[ ${#REQ_IDS[@]} -gt 0 ]]; then
    echo "**Requirement IDs:** $(IFS=', '; echo "${REQ_IDS[*]}")"
fi
echo ""

if [[ $CHECK_FAIL -eq 0 ]]; then
    echo "- **PASS**: Numbered requirements present (${#REQ_IDS[@]} found)"
    echo "- **PASS**: All requirements have acceptance criteria"
    echo "- **PASS**: Error/edge case coverage present"
    echo ""
    echo "---"
    echo ""
    echo "**Result: PASS** ($CHECK_PASS/$TOTAL checks passed)"
    exit 0
else
    for f in "${FINDINGS[@]}"; do
        echo "- **FINDING**: $f"
    done
    if [[ $CHECK_PASS -gt 0 ]]; then
        remaining=$((TOTAL - CHECK_FAIL))
        echo "- **PASS**: $remaining other check(s) passed"
    fi
    echo ""
    echo "---"
    echo ""
    echo "**Result: FINDINGS** ($CHECK_FAIL/$TOTAL checks have findings — advisory, does not block)"
    exit 1
fi
