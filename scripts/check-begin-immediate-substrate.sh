#!/usr/bin/env bash
# check-begin-immediate-substrate.sh
#
# CI grep gate: enforce that the SQLite immediate-transaction primitive lives
# only inside the storage substrate — not in application code.
#
# Two patterns are scanned:
#
#   1. `.immediate(`     — the REAL primitive. `bun:sqlite` (and the
#      better-sqlite3 shim) expose `db.transaction(fn).immediate()` to open a
#      BEGIN IMMEDIATE write transaction. This is the call an application layer
#      would actually reach for, so it is the load-bearing check.
#      See servers/exarchos-mcp/src/storage/sqlite-backend.ts (allocateSequence).
#
#   2. `BEGIN IMMEDIATE` — the literal SQL string, for code that issues the
#      statement directly (e.g. `db.run("BEGIN IMMEDIATE")`) or raw *.sql.
#      Retained as a backstop. NOTE: on the current tree every occurrence of
#      this literal sits in a comment, so this check alone guards nothing —
#      which is precisely why check (1) exists. Do not treat a green literal
#      check as evidence the gate is working.
#
# Allowed paths (the substrate):
#   servers/exarchos-mcp/src/storage/**
#   servers/exarchos-mcp/src/event-store/**
#
# Exempt:
#   *.test.ts files (may reference the primitive in assertions/fixtures)
#   **/__tests__/** directories
#   comment lines (documentation mentioning the primitive is not a use of it)
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

# Violations, tagged by which pattern fired: "<tag>|<file>:<line>:<content>"
VIOLATIONS=()

# is_exempt <abs_filepath> <content-line>
# Returns 0 (true) when this match is an allowed use of the primitive.
is_exempt() {
    local abs_filepath="$1"
    local content="$2"

    # Allow: storage substrate
    [[ "$abs_filepath" == */servers/exarchos-mcp/src/storage/* ]] && return 0

    # Allow: event-store substrate
    [[ "$abs_filepath" == */servers/exarchos-mcp/src/event-store/* ]] && return 0

    # Allow: test files (*.test.ts)
    [[ "$abs_filepath" == *.test.ts ]] && return 0

    # Allow: __tests__ directories
    [[ "$abs_filepath" == */__tests__/* ]] && return 0

    # Allow: comment lines — JSDoc/inline comments that mention the primitive
    # in documentation are not statements leaking through the abstraction.
    # Check if the content line is a comment (leading whitespace then *, //,
    # /*, or # before any non-whitespace). /* covers block-comment opener lines
    # like `/* ... BEGIN IMMEDIATE` so documentation snippets and disabled
    # examples don't trip the gate.
    # (CodeRabbit review #4278133032 on PR #1344.)
    local trimmed="${content#"${content%%[![:space:]]*}"}"  # ltrim whitespace
    if [[ "$trimmed" == \** || "$trimmed" == //* || "$trimmed" == \#* || "$trimmed" == /\** ]]; then
        return 0
    fi

    return 1
}

# scan <tag> <grep-extended-regex>
# Appends every non-exempt match to VIOLATIONS, tagged with <tag>.
scan() {
    local tag="$1"
    local pattern="$2"
    local matches=()

    # grep exits 0 if matches found, 1 if no matches, 2+ on error.
    # Exclude generated/dependency dirs that rg would skip via .gitignore.
    mapfile -t matches < <(
        grep -rnE "$pattern" "$SCAN_ROOT" \
            --include="*.ts" \
            --include="*.sql" \
            --exclude-dir=node_modules \
            --exclude-dir=.git \
            --exclude-dir=dist \
            --exclude-dir=".claude" \
            2>/dev/null || true
    )

    local match filepath abs_filepath content
    for match in "${matches[@]}"; do
        # match format: <filepath>:<lineno>:<content>
        filepath="${match%%:*}"

        # Resolve to absolute path for reliable prefix matching
        abs_filepath="$(cd "$(dirname "$filepath")" && pwd)/$(basename "$filepath")"

        content="${match#*:}"    # strip filepath
        content="${content#*:}"  # strip lineno

        if is_exempt "$abs_filepath" "$content"; then
            continue
        fi

        VIOLATIONS+=("${tag}|${match}")
    done
}

# The real primitive: `.immediate(` — tolerate `.immediate ()` spacing.
scan "immediate-call" '\.immediate[[:space:]]*\('

# Backstop: the literal SQL statement.
scan "begin-immediate-literal" 'BEGIN IMMEDIATE'

if [[ ${#VIOLATIONS[@]} -eq 0 ]]; then
    echo "OK: no immediate-transaction substrate leaks found in $SCAN_ROOT"
    exit 0
fi

echo "ERROR: SQLite immediate-transaction primitive found outside the storage"
echo "substrate — layering violation(s):"
for v in "${VIOLATIONS[@]}"; do
    tag="${v%%|*}"
    match="${v#*|}"
    echo "  [$tag] $match"
done
echo ""
echo "\`.immediate()\` / \`BEGIN IMMEDIATE\` are SQLite WAL substrate primitives."
echo "They must only appear under:"
echo "  servers/exarchos-mcp/src/storage/"
echo "  servers/exarchos-mcp/src/event-store/"
echo "Application code should use the withSession() abstraction instead."
exit 1
