#!/usr/bin/env bash
# Verify Doc Links
# Checks that internal markdown links resolve to existing files.
# Replaces manual documentation link verification with deterministic validation.
#
# Usage: verify-doc-links.sh --doc-file <path> | --docs-dir <path>
#
# Exit codes:
#   0 = all links valid
#   1 = broken links found
#   2 = usage error (missing required args)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ============================================================
# ARGUMENT PARSING
# ============================================================

DOC_FILE=""
DOCS_DIR=""

usage() {
    cat << 'USAGE'
Usage: verify-doc-links.sh --doc-file <path> | --docs-dir <path>

Required (one of):
  --doc-file <path>    Single markdown file to check
  --docs-dir <path>    Directory to check recursively (all .md files)

Optional:
  --help               Show this help message

Exit codes:
  0  All internal links resolve to existing files
  1  One or more broken links found
  2  Usage error (missing required args)

Notes:
  - External URLs (http://, https://) are skipped
  - Anchor-only links (#section) are skipped
  - Links with anchors (file.md#section) check the file part only
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --doc-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --doc-file requires a path argument" >&2
                exit 2
            fi
            DOC_FILE="$2"
            shift 2
            ;;
        --docs-dir)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --docs-dir requires a path argument" >&2
                exit 2
            fi
            DOCS_DIR="$2"
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

if [[ -z "$DOC_FILE" && -z "$DOCS_DIR" ]]; then
    echo "Error: --doc-file or --docs-dir is required" >&2
    usage >&2
    exit 2
fi

# ============================================================
# LINK CHECKING
# ============================================================

BROKEN_COUNT=0
CHECKED_COUNT=0
SKIPPED_COUNT=0
BROKEN_LINKS=()

check_file() {
    local file="$1"
    local file_dir
    file_dir="$(dirname "$file")"
    local line_num=0

    while IFS= read -r line; do
        line_num=$((line_num + 1))

        # Extract markdown links: [text](target)
        # Use grep to find all link targets on this line
        while IFS= read -r target; do
            [[ -z "$target" ]] && continue

            # Skip external URLs
            if [[ "$target" == http://* || "$target" == https://* ]]; then
                SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
                continue
            fi

            # Skip anchor-only links
            if [[ "$target" == \#* ]]; then
                SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
                continue
            fi

            # Strip anchor from target (file.md#section -> file.md)
            local file_target="${target%%#*}"

            # Skip if empty after stripping anchor
            if [[ -z "$file_target" ]]; then
                SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
                continue
            fi

            CHECKED_COUNT=$((CHECKED_COUNT + 1))

            # Resolve relative to the file's directory
            local resolved_path="$file_dir/$file_target"

            if [[ ! -e "$resolved_path" ]]; then
                BROKEN_COUNT=$((BROKEN_COUNT + 1))
                BROKEN_LINKS+=("$file:$line_num -> $target (resolved: $resolved_path)")
            fi
        done < <(echo "$line" | grep -oE '\[[^]]*\]\([^)]+\)' | sed -E 's/\[[^]]*\]\(([^)]+)\)/\1/g' || true)
    done < "$file"
}

# ============================================================
# COLLECT FILES TO CHECK
# ============================================================

FILES_TO_CHECK=()

if [[ -n "$DOC_FILE" ]]; then
    if [[ ! -f "$DOC_FILE" ]]; then
        echo "Error: File not found: $DOC_FILE" >&2
        exit 2
    fi
    FILES_TO_CHECK+=("$DOC_FILE")
elif [[ -n "$DOCS_DIR" ]]; then
    if [[ ! -d "$DOCS_DIR" ]]; then
        echo "Error: Directory not found: $DOCS_DIR" >&2
        exit 2
    fi
    while IFS= read -r f; do
        FILES_TO_CHECK+=("$f")
    done < <(find "$DOCS_DIR" -name "*.md" -type f 2>/dev/null | sort)
fi

# ============================================================
# EXECUTE CHECKS
# ============================================================

for f in "${FILES_TO_CHECK[@]}"; do
    check_file "$f"
done

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Documentation Link Verification Report"
echo ""
echo "**Files checked:** ${#FILES_TO_CHECK[@]}"
echo "**Links checked:** $CHECKED_COUNT"
echo "**Links skipped:** $SKIPPED_COUNT (external URLs, anchors)"
echo "**Broken links:** $BROKEN_COUNT"
echo ""

if [[ $BROKEN_COUNT -gt 0 ]]; then
    echo "### Broken Links"
    echo ""
    for link in "${BROKEN_LINKS[@]}"; do
        echo "- \`$link\`"
    done
    echo ""
fi

echo "---"
echo ""

if [[ $BROKEN_COUNT -eq 0 ]]; then
    echo "**Result: PASS** — All internal links resolve to existing files"
    exit 0
else
    echo "**Result: FAIL** — $BROKEN_COUNT broken link(s) found"
    exit 1
fi
