#!/usr/bin/env bash
# check-begin-immediate-substrate.sh
#
# CI grep gate: enforce that the SQLite "BEGIN IMMEDIATE" transaction primitive
# lives only inside the storage substrate — not in application code.
#
# Allowed paths:
#   servers/exarchos-mcp/src/storage/**
#   servers/exarchos-mcp/src/event-store/**
#
# Exempt:
#   *.test.ts files (may reference the string in assertions/fixtures)
#   **/__tests__/** directories
#
# Usage:
#   check-begin-immediate-substrate.sh [<scan-root>]
#
# <scan-root> defaults to the current working directory.
# Exits non-zero and prints offending file:line on any violation.
#
# Uses grep -rn (POSIX) so it works in non-interactive bash contexts
# where rg may not be available as a standalone binary.

set -euo pipefail

SCAN_ROOT="${1:-.}"

# Normalise to absolute path for reliable prefix matching
SCAN_ROOT="$(cd "$SCAN_ROOT" && pwd)"

VIOLATIONS=()

# Search recursively for the literal string "BEGIN IMMEDIATE".
# Exclude common generated/dependency directories that rg would skip via
# .gitignore: node_modules, .git, dist, .claude/worktrees.
#
# grep exits 0 if matches found, 1 if no matches, 2+ on error.
# We capture the output into an array and handle each match.

mapfile -t ALL_MATCHES < <(
    grep -rn "BEGIN IMMEDIATE" "$SCAN_ROOT" \
        --include="*.ts" \
        --include="*.sql" \
        --exclude-dir=node_modules \
        --exclude-dir=.git \
        --exclude-dir=dist \
        --exclude-dir=".claude" \
        2>/dev/null || true
)

for match in "${ALL_MATCHES[@]}"; do
    # match format: <filepath>:<lineno>:<content>
    filepath="${match%%:*}"

    # Resolve to absolute path for reliable prefix matching
    abs_filepath="$(cd "$(dirname "$filepath")" && pwd)/$(basename "$filepath")"

    # Allow: storage substrate
    if [[ "$abs_filepath" == */servers/exarchos-mcp/src/storage/* ]]; then
        continue
    fi

    # Allow: event-store substrate
    if [[ "$abs_filepath" == */servers/exarchos-mcp/src/event-store/* ]]; then
        continue
    fi

    # Allow: test files (*.test.ts)
    if [[ "$abs_filepath" == *.test.ts ]]; then
        continue
    fi

    # Allow: __tests__ directories
    if [[ "$abs_filepath" == */__tests__/* ]]; then
        continue
    fi

    # Allow: comment lines — JSDoc/inline comments that mention the primitive
    # in documentation are not SQL statements leaking through the abstraction.
    # Strip the "filepath:lineno:" prefix and check if the content line is a
    # comment (leading whitespace then *, //, or # before any non-whitespace).
    content="${match#*:}"          # strip filepath
    content="${content#*:}"        # strip lineno
    trimmed="${content#"${content%%[![:space:]]*}"}"  # ltrim whitespace
    if [[ "$trimmed" == \** || "$trimmed" == //* || "$trimmed" == \#* ]]; then
        continue
    fi

    # Everything else is a violation
    VIOLATIONS+=("$match")
done

if [[ ${#VIOLATIONS[@]} -eq 0 ]]; then
    echo "OK: no BEGIN IMMEDIATE substrate leaks found in $SCAN_ROOT"
    exit 0
fi

echo "ERROR: BEGIN IMMEDIATE found outside storage substrate — layering violation(s):"
for v in "${VIOLATIONS[@]}"; do
    echo "  $v"
done
echo ""
echo "BEGIN IMMEDIATE is a SQLite WAL substrate primitive. It must only appear under:"
echo "  servers/exarchos-mcp/src/storage/"
echo "  servers/exarchos-mcp/src/event-store/"
echo "Application code should use the withSession() abstraction instead."
exit 1
