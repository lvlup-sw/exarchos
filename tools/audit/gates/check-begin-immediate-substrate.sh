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
#      See src/storage/sqlite-backend.ts (allocateSequence).
#
#   2. `BEGIN IMMEDIATE` — the literal SQL string, for code that issues the
#      statement directly (e.g. `db.run("BEGIN IMMEDIATE")`) or raw *.sql.
#      Retained as a backstop. NOTE: on the current tree every occurrence of
#      this literal sits in a comment, so this check alone guards nothing —
#      which is precisely why check (1) exists. Do not treat a green literal
#      check as evidence the gate is working.
#
# Allowed paths (the substrate):
#   src/storage/**
#   src/event-store/**
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

# strip_comments <content-line>
# Echoes <content-line> with comment text removed, so the caller can ask whether
# the PATTERN survives in real CODE rather than whether the LINE merely looks
# commented. Line-local by design — the gate greps line by line.
strip_comments() {
    local line="$1"

    # 1. Remove every CLOSED `/* ... */` span. These can sit before real code on
    #    the same line, which is the whole bypass this exists to close.
    while [[ "$line" =~ ^(.*)/\*.*\*/(.*)$ ]]; do
        line="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
    done

    # 2. If what remains BEGINS with a comment marker, the line is comment-only.
    #    `*` covers JSDoc continuation lines (` * BEGIN IMMEDIATE …`) — the most
    #    common documentation shape in this tree by far.
    local trimmed="${line#"${line%%[![:space:]]*}"}"
    if [[ "$trimmed" == \** || "$trimmed" == //* || "$trimmed" == \#* || "$trimmed" == /\** ]]; then
        printf ''
        return
    fi

    # 3. Otherwise drop a TRAILING comment: an unterminated block opener, or a
    #    line comment. `#` is deliberately NOT cut here — it is only a comment as
    #    a line prefix (step 2). Cutting it mid-line would eat TypeScript private
    #    fields, so `this.#db.immediate()` would vanish from the scan entirely.
    line="${line%%/\**}"
    line="${line%%//*}"
    printf '%s' "$line"
}

# is_exempt <abs_filepath> <content-line> <pattern>
# Returns 0 (true) when this match is an allowed use of the primitive.
is_exempt() {
    local abs_filepath="$1"
    local content="$2"
    local pattern="$3"

    # Allow: storage substrate
    [[ "$abs_filepath" == */src/storage/* ]] && return 0

    # Allow: event-store substrate
    [[ "$abs_filepath" == */src/event-store/* ]] && return 0

    # Allow: test files (*.test.ts)
    [[ "$abs_filepath" == *.test.ts ]] && return 0

    # Allow: __tests__ directories
    [[ "$abs_filepath" == */__tests__/* ]] && return 0

    # Allow: comments — documentation mentioning the primitive is not a use of
    # it. The question is whether the TOKEN is inside a comment, NOT whether the
    # line begins with one. Testing the line prefix (the original approach) let
    # real code hide behind a comment that merely came first:
    #
    #     /* rationale */ txn.immediate();   <- line starts with /*, so exempt
    #
    # A gate a comment prefix disarms is not a gate. So strip the comment text
    # and re-ask whether the pattern still matches what is left; if it does, the
    # token is live code regardless of what preceded it.
    # (Original prefix rule: CodeRabbit review #4278133032 on PR #1344.)
    local code
    code="$(strip_comments "$content")"
    if ! printf '%s' "$code" | grep -qE "$pattern"; then
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
    #
    # FAIL CLOSED on 2+. The original `2>/dev/null || true` collapsed all three
    # into "no matches", so an unreadable path — a permissions problem, a broken
    # symlink, a mount hiccup on a runner — silently turned a red gate green and
    # reported "OK: no leaks found". A scan that could not look is not a scan
    # that found nothing; only status 1 means that.
    #
    # stderr is captured separately from stdout: folding it into `matches` with
    # `2>&1` would feed grep's own error text back through the match parser.
    #
    # grep's status is captured via a temp file rather than `mapfile < <(grep …)`.
    # Process substitution reports MAPFILE's status, not grep's, so the earlier
    # `|| status=$?` form silently always saw 0 and this guard never fired — the
    # fail-open it was written to close survived it verbatim.
    local status=0
    local outfile errfile
    outfile="$(mktemp)"
    errfile="$(mktemp)"
    grep -rnE "$pattern" "$SCAN_ROOT" \
        --include="*.ts" \
        --include="*.sql" \
        --exclude-dir=node_modules \
        --exclude-dir=.git \
        --exclude-dir=dist \
        --exclude-dir=".claude" \
        >"$outfile" 2>"$errfile" || status=$?

    mapfile -t matches <"$outfile"
    rm -f "$outfile"

    if [[ $status -gt 1 ]]; then
        echo "ERROR: scan for '${tag}' failed (grep exit ${status}) — refusing to report a" >&2
        echo "green gate from an incomplete scan. grep said:" >&2
        sed 's/^/  /' "$errfile" >&2
        rm -f "$errfile"
        exit 2
    fi
    rm -f "$errfile"

    local match filepath abs_filepath content
    for match in "${matches[@]}"; do
        # match format: <filepath>:<lineno>:<content>
        filepath="${match%%:*}"

        # Resolve to absolute path for reliable prefix matching
        abs_filepath="$(cd "$(dirname "$filepath")" && pwd)/$(basename "$filepath")"

        content="${match#*:}"    # strip filepath
        content="${content#*:}"  # strip lineno

        if is_exempt "$abs_filepath" "$content" "$pattern"; then
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
echo "  src/storage/"
echo "  src/event-store/"
echo "Application code should use the withSession() abstraction instead."
exit 1
