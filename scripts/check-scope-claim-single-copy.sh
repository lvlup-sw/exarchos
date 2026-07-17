#!/usr/bin/env bash
# check-scope-claim-single-copy.sh — CI grep gate (#1696, DR-6)
#
# The projection-scope guarantee has exactly ONE copy in code and ONE in
# prose; every other site must POINT at a home, never restate the argument.
# #1342's review took 4 cycles because the guarantee was restated in ~8
# places until the restatements outlived the code and contradicted each
# other. The one-copy rule is prose; this gate is its compiler.
#
# Homes (the only places allowed to STATE the rule):
#   servers/exarchos-mcp/src/projections/types.ts   (the `scope` docstring)
#   docs/architecture/projections.md                ("Reducer scope discipline")
#
# Phrase list — tuned against the real tree (v2-12-bundle task 005):
#   KEPT
#     `unauthorable`              2 hits, both legitimate (home + typecheck probe).
#     `cross-stream fold`         5 hits: homes ×4 + subscriptions.ts (own semantics).
#     `not representable`         0 hits; forward guard for the obvious rephrasing.
#     `cannot be authored`        0 hits; forward guard.
#     `lives entirely in the type`, `type is the guard`   0 hits; forward guards.
#     `unrepresentable` (contextualized)  bare form has 14 hits, almost all
#       INV-11 posture/worktree claims (capabilities/, prepare-delegation,
#       runtime.md) plus zod's `unrepresentable:` option in json-schema tests —
#       none about projection scope. Requiring a projection-context word
#       (scope|fold|cross-stream|reducer) on the same line yields ZERO current
#       hits while still catching e.g. "a globally-scoped reducer fold is
#       unrepresentable".
#   DROPPED (from the #1696 candidate list)
#     `only scope`   12/12 hits are false positives: `readonly scope:` field
#       declarations contain it as a substring, plus unrelated English ("ps-only
#       scopes", "the only scope where `probe: true` is valid"). The restatement
#       space it covered is already caught by the kept phrases.
#     `can carry`    3/3 hits unrelated (posture overlays, HSM event fields);
#       adding a scope-context requirement leaves zero hits and zero guard value.
#
# NO comment exemption — deliberately. The claim LIVES in comments/docstrings;
# a restatement in a comment is exactly the #1342 violation class. (The
# begin-immediate sibling strips comments because there the primitive is code;
# here the target is prose, so stripping would blind the gate.)
#
# Empty-selection discipline (#1694, inherited from task 004): this gate scans
# a fixed phrase list over a fixed tree, so
#   - missing/empty scan dirs        -> exit 2 (a scan that could not look is
#     not a scan that found nothing);
#   - zero phrase hits in EITHER home -> exit 1 (the phrase list no longer
#     matches the claim's own homes, so the gate guards nothing — retune it
#     against the reworded home). This anchor is what keeps the gate from ever
#     going vacuously green, so it needs no --declared-dormant escape hatch.
#
# Usage:  check-scope-claim-single-copy.sh [<repo-root>]   (defaults to cwd)
# Exit:   0 clean · 1 violation or unanchored phrase list · 2 scan error

set -euo pipefail

SCAN_ROOT="${1:-.}"
if [[ ! -d "$SCAN_ROOT" ]]; then
    echo "ERROR: scan root does not exist: $SCAN_ROOT" >&2
    exit 2
fi
SCAN_ROOT="$(cd "$SCAN_ROOT" && pwd)"

SRC_DIR="$SCAN_ROOT/servers/exarchos-mcp/src"
DOCS_DIR="$SCAN_ROOT/docs/architecture"

HOME_CODE="servers/exarchos-mcp/src/projections/types.ts"
HOME_PROSE="docs/architecture/projections.md"

# Allowlist — by FILE, each with the reason it may say what it says.
ALLOWLIST=(
    # HOME (code): the one copy in code — the `scope` docstring.
    "$HOME_CODE"
    # HOME (prose): the one copy in prose — "Reducer scope discipline".
    "$HOME_PROSE"
    # Typecheck probe for the claim: names "unauthorable in typechecked code"
    # only to scope its own assertion to the narrow claim, and points at the
    # home rather than restating the argument.
    "servers/exarchos-mcp/src/projections/types.test.ts"
    # "cross-stream fold" here describes SubscriptionFilter's OWN semantics
    # (omitted streamId => the subscription observes every stream) — the
    # subscription mechanism, not the projection-scope guarantee.
    "servers/exarchos-mcp/src/event-store/subscriptions.ts"
)
# Deliberately NOT allowlisted: #1696 named event-store/aggregate-stream.test.ts
# (probe/tombstone) and event-store/atomic-appender.ts (local-safety prose), but
# on the current tree both only POINT at the home — zero phrase hits. A dead
# allowlist entry would silently pre-exempt a future restatement, so each stays
# out until it produces a verified-legitimate hit.

# "<tag>|<grep -iE pattern>" — split on the FIRST pipe only.
PATTERNS=(
    "unauthorable|unauthorable"
    "cross-stream-fold|cross-stream fold"
    "not-representable|not representable"
    "cannot-be-authored|cannot be authored"
    "lives-entirely-in-the-type|lives entirely in the type"
    "type-is-the-guard|type is the guard"
    "unrepresentable-near-scope|(scope|fold|cross-stream|reducer).*unrepresentable|unrepresentable.*(scope|fold|cross-stream|reducer)"
)

# ─── Empty-selection guard: the fixed tree must actually be there (#1694) ────
for dir in "$SRC_DIR" "$DOCS_DIR"; do
    if [[ ! -d "$dir" ]]; then
        echo "ERROR: scan target dir missing: $dir — refusing to report a green" >&2
        echo "gate from a scan that never looked at its tree." >&2
        exit 2
    fi
    if [[ -z "$(find "$dir" \( -name '*.ts' -o -name '*.md' \) -print -quit)" ]]; then
        echo "ERROR: scan target dir has no *.ts/*.md files: $dir — empty" >&2
        echo "selection; this gate is not guarding anything." >&2
        exit 2
    fi
done

VIOLATIONS=()
CODE_HOME_HITS=0
PROSE_HOME_HITS=0

for entry in "${PATTERNS[@]}"; do
    tag="${entry%%|*}"
    pattern="${entry#*|}"

    # FAIL CLOSED on grep status 2+ (status 1 = clean, the only benign miss).
    # Status captured via temp files: process substitution would report
    # mapfile's status, not grep's, and 2>&1 would feed grep's own error text
    # back through the match parser.
    status=0
    outfile="$(mktemp)"
    errfile="$(mktemp)"
    grep -rniE "$pattern" "$SRC_DIR" "$DOCS_DIR" \
        --include="*.ts" --include="*.md" \
        --exclude-dir=node_modules --exclude-dir=.git \
        --exclude-dir=dist --exclude-dir=".claude" \
        >"$outfile" 2>"$errfile" || status=$?

    mapfile -t matches <"$outfile"
    rm -f "$outfile"
    if [[ $status -gt 1 ]]; then
        echo "ERROR: scan for '${tag}' failed (grep exit ${status}) — refusing to" >&2
        echo "report a green gate from an incomplete scan. grep said:" >&2
        sed 's/^/  /' "$errfile" >&2
        rm -f "$errfile"
        exit 2
    fi
    rm -f "$errfile"

    for match in "${matches[@]}"; do
        filepath="${match%%:*}"
        rel="${filepath#"$SCAN_ROOT"/}"

        [[ "$rel" == "$HOME_CODE" ]] && CODE_HOME_HITS=$((CODE_HOME_HITS + 1))
        [[ "$rel" == "$HOME_PROSE" ]] && PROSE_HOME_HITS=$((PROSE_HOME_HITS + 1))

        allowed=false
        for allow in "${ALLOWLIST[@]}"; do
            if [[ "$rel" == "$allow" ]]; then
                allowed=true
                break
            fi
        done
        [[ "$allowed" == "true" ]] && continue

        VIOLATIONS+=("${tag}|${match}")
    done
done

if [[ ${#VIOLATIONS[@]} -gt 0 ]]; then
    echo "ERROR: projection-scope claim restated outside its two homes (#1696):"
    for v in "${VIOLATIONS[@]}"; do
        echo "  [${v%%|*}] ${v#*|}"
    done
    echo ""
    echo "The scope guarantee has exactly two homes:"
    echo "  $HOME_CODE (the \`scope\` docstring)"
    echo "  $HOME_PROSE (\"Reducer scope discipline\")"
    echo "Link to a home instead of restating the rule. If a hit is genuinely"
    echo "about something else, tune the phrase or add a justified allowlist"
    echo "entry in scripts/check-scope-claim-single-copy.sh — never both homes' prose."
    exit 1
fi

# ─── Anchor: the phrase list must still match the claim's own homes ──────────
if [[ $CODE_HOME_HITS -eq 0 || $PROSE_HOME_HITS -eq 0 ]]; then
    echo "ERROR: phrase list matched nothing in one of the claim's homes" >&2
    echo "  $HOME_CODE: $CODE_HOME_HITS hit(s)" >&2
    echo "  $HOME_PROSE: $PROSE_HOME_HITS hit(s)" >&2
    echo "A phrase list that cannot find the claim where it definitely lives" >&2
    echo "cannot find a restatement of it either — the gate is guarding" >&2
    echo "nothing (#1694). Retune the phrase list against the reworded home." >&2
    exit 1
fi

echo "check-scope-claim-single-copy: OK — claim found only in its homes" \
     "(code home: $CODE_HOME_HITS hit(s), prose home: $PROSE_HOME_HITS hit(s))"
exit 0
