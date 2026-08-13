#!/usr/bin/env bash
# check-withsession-idempotency.sh — CI gate
#
# Enforces the .withSession({...}) idempotency contract: every call site
# in production TypeScript files must include, within the call expression,
# either:
#   - operationId: <value>
#   - allowNonIdempotent: true
#
# Exempt paths (never flagged):
#   - **/*.test.ts          (test files exercise the contract, not implement callers)
#   - **/__tests__/**       (test utility directories)
#   - src/event-store/atomic-appender.ts  (substrate impl)
#
# Usage:
#   check-withsession-idempotency.sh [<scan-dir>]
#
# Arguments:
#   <scan-dir>   Directory to scan. Defaults to current working directory.
#
# Exit codes:
#   0   All .withSession( call sites are compliant (or no call sites found).
#   1   One or more non-compliant call sites detected.

set -euo pipefail

# ─── Argument handling ───────────────────────────────────────────────────────

SCAN_DIR="${1:-.}"

if [[ ! -d "$SCAN_DIR" ]]; then
    echo "ERROR: scan directory does not exist: $SCAN_DIR" >&2
    exit 1
fi

# Resolve to absolute path so output messages are unambiguous.
SCAN_DIR="$(cd "$SCAN_DIR" && pwd)"

# ─── Tool selection: rg preferred, grep fallback ─────────────────────────────

USE_RG=false
if command -v rg &>/dev/null; then
    USE_RG=true
fi

# ─── Constants ───────────────────────────────────────────────────────────────

# Number of lines after the .withSession( line to look for idempotency markers.
# A typical call spans: opening paren, streamId, reducerId, closure, opts —
# usually 6–12 lines. 15 is conservative and avoids false negatives on
# multi-line options objects while staying well within one call expression.
CONTEXT_LINES=15

# Relative path suffix of the exempt substrate implementation.
EXEMPT_SUBSTRATE="src/event-store/atomic-appender.ts"

# ─── File discovery ──────────────────────────────────────────────────────────

# Collect the list of candidate .ts files (excluding .test.ts and __tests__).
# rg is used when available (respects .gitignore, faster). Otherwise grep -r.

find_matching_files() {
    if [[ "$USE_RG" == "true" ]]; then
        rg \
            --type ts \
            -l \
            --glob '!*.test.ts' \
            --glob '!**/__tests__/**' \
            '\.withSession\(' \
            "$SCAN_DIR" 2>/dev/null || true
    else
        # grep fallback: explicit exclusions for standard ignored dirs.
        grep -rl \
            --include='*.ts' \
            --exclude='*.test.ts' \
            --exclude-dir='__tests__' \
            --exclude-dir='node_modules' \
            --exclude-dir='dist' \
            --exclude-dir='.git' \
            --exclude-dir='.claude' \
            '\.withSession(' \
            "$SCAN_DIR" 2>/dev/null || true
    fi
}

# ─── Context extraction ───────────────────────────────────────────────────────

# For a given file, return all .withSession( matches with CONTEXT_LINES of
# trailing context. Output uses rg/grep -A format.

get_match_context() {
    local file="$1"
    if [[ "$USE_RG" == "true" ]]; then
        rg -n --no-heading -A "$CONTEXT_LINES" '\.withSession\(' "$file" 2>/dev/null || true
    else
        grep -n -A "$CONTEXT_LINES" '\.withSession(' "$file" 2>/dev/null || true
    fi
}

# ─── Main scan ───────────────────────────────────────────────────────────────

VIOLATIONS=0

while IFS= read -r file; do
    # Skip the exempt substrate implementation.
    if [[ "$file" == *"$EXEMPT_SUBSTRATE" ]]; then
        continue
    fi

    match_output="$(get_match_context "$file")"

    if [[ -z "$match_output" ]]; then
        continue
    fi

    # Process each match block. Both rg -A and grep -A output interleave
    # match lines and context lines. Match lines: "<lineno>:<content>".
    # Context lines: "<lineno>-<content>".  Blocks separated by "--".
    #
    # Strategy: iterate line by line. When we see a line that contains
    # ".withSession(", record its line number and start accumulating a
    # context window. On "--" (block separator) or another match line,
    # evaluate the accumulated window.

    match_lineno=""
    window=""

    check_window() {
        local ln="$1"
        local ctx="$2"
        if echo "$ctx" | grep -qE 'operationId\s*:'; then
            return 0
        fi
        if echo "$ctx" | grep -qE 'allowNonIdempotent\s*:\s*true'; then
            return 0
        fi
        echo "VIOLATION: $file:$ln — .withSession( missing operationId or allowNonIdempotent: true"
        VIOLATIONS=$((VIOLATIONS + 1))
    }

    while IFS= read -r line; do
        if [[ "$line" == "--" ]]; then
            # End of context block — evaluate.
            if [[ -n "$match_lineno" ]]; then
                check_window "$match_lineno" "$window"
            fi
            match_lineno=""
            window=""
            continue
        fi

        # Detect anchor match line: "digits:<content-with-.withSession(>"
        # The line number separator is ":" for match lines, "-" for context.
        #
        # Comment guard: skip anchors where the match is inside a line
        # comment (`//.*\.withSession(`) or a multi-line-comment
        # continuation line (leading `* `). Without this guard, every
        # documentation or commented-out reference to `.withSession(`
        # ingests as a fresh anchor and the surrounding window is
        # evaluated against a comment block that almost never contains
        # `operationId:`, producing a false-positive CI failure.
        if echo "$line" | grep -qE '^[0-9]+[:-].*\.withSession\('; then
            content="${line#*[:-]}"
            # Trim leading whitespace so block-comment opener lines like
            # `    /* example .withSession(...)` are recognised. The
            # third regex branch (`/\*`) was added to stop docstring
            # examples from being mis-classified as real call sites.
            # (CodeRabbit review #4278133032 on PR #1344.)
            trimmed="${content#"${content%%[![:space:]]*}"}"
            if [[ "$trimmed" =~ ^(\*|//|/\*) ]] || [[ "$content" =~ //.*\.withSession\( ]]; then
                continue
            fi
            if [[ -n "$match_lineno" ]]; then
                # Previous block had no "--" — evaluate before starting new.
                check_window "$match_lineno" "$window"
            fi
            match_lineno="$(echo "$line" | grep -oE '^[0-9]+')"
            window="$line"
        elif [[ -n "$match_lineno" ]]; then
            window="${window}"$'\n'"${line}"
        fi
    done <<< "$match_output"

    # Handle the final block (no trailing "--").
    if [[ -n "$match_lineno" ]]; then
        check_window "$match_lineno" "$window"
    fi

done < <(find_matching_files)

# ─── Result ──────────────────────────────────────────────────────────────────

if [[ $VIOLATIONS -gt 0 ]]; then
    echo ""
    echo "check-withsession-idempotency: $VIOLATIONS violation(s) found." \
         "Each .withSession( call must include operationId: or allowNonIdempotent: true."
    exit 1
else
    echo "check-withsession-idempotency: OK (all .withSession( call sites are compliant)"
    exit 0
fi
