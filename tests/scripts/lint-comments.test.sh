#!/usr/bin/env bash
# Self-test for tools/audit/gates/lint-comments.mjs. It drives the real gate over seeded fixtures:
# a clean file, a new violation, a baselined block, a swap, a duplicate, a stale entry, a comment
# inside a function, a description that breaks an STE rule, a shell comment after a heredoc, a
# hand-grown baseline entry, a missing config, and a pull request run without its base branch.
# The trap restores every changed file.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || { echo "cannot cd to repo root: $ROOT" >&2; exit 1; }

GATE="tools/audit/gates/lint-comments.mjs"
BASELINE="tools/audit/comment-quality/baseline.tsv"
FX_DIR="src/__lint_comments_selftest__"
TMP="$(mktemp -d)"
cp "$BASELINE" "$TMP/baseline.tsv"
: > "$TMP/empty.tsv"

cleanup() {
  cp "$TMP/baseline.tsv" "$BASELINE"
  rm -rf "$FX_DIR" "$TMP"
}
trap cleanup EXIT

pass=0
fail=0
check() { # <name> <expected-exit> <actual-exit>
  if [[ "$2" == "$3" ]]; then
    echo "  ok: $1"
    pass=$((pass + 1))
  else
    echo "  FAIL: $1 (expected exit $2, got $3)"
    cat "$TMP/out"
    fail=$((fail + 1))
  fi
}
gate() { node "$GATE" "$@" >"$TMP/out" 2>&1; echo $?; }
expect_output() { # <name> <extended-regex>
  if grep -qE "$2" "$TMP/out"; then
    echo "  ok: $1"
    pass=$((pass + 1))
  else
    echo "  FAIL: $1 (output does not match: $2)"
    cat "$TMP/out"
    fail=$((fail + 1))
  fi
}

mkdir -p "$FX_DIR"
FX="$FX_DIR/fixture.ts"
OFFENDER='/** Fsync the parent first. DR-7 requires it. */'
OWN="$TMP/fixture-baseline.tsv"

printf '/** The retry budget is three attempts. */\nexport const a = 1;\n' > "$FX"
check "LintComments_CleanFile_ExitsZero" 0 "$(gate --files "$FX" --no-admission --baseline "$TMP/empty.tsv")"

printf '%s\nexport const a = 1;\n' "$OFFENDER" > "$FX"
check "LintComments_NewViolation_ExitsOne" 1 "$(gate --files "$FX" --no-admission --baseline "$TMP/empty.tsv")"

HASH="$(node --input-type=module -e "import { fingerprint } from './tools/audit/lib/comment-baseline.mjs'; process.stdout.write(fingerprint(process.argv[1]))" "$OFFENDER")"
printf '%s\t%s\t1\n' "$FX" "$HASH" > "$OWN"
check "LintComments_BaselinedBlock_ExitsZero" 0 "$(gate --files "$FX" --no-admission --baseline "$OWN")"

printf '/** Fsync the parent first. DR-8 requires it. */\nexport const a = 1;\n' > "$FX"
check "LintComments_SwapInBaselinedFile_ExitsOne" 1 "$(gate --files "$FX" --no-admission --baseline "$OWN")"

printf '%s\nexport const a = 1;\n%s\nexport const b = 2;\n' "$OFFENDER" "$OFFENDER" > "$FX"
check "LintComments_DuplicateOfBaselinedBlock_ExitsOne" 1 "$(gate --files "$FX" --no-admission --baseline "$OWN")"

printf '/** Fsync the parent first. */\nexport const a = 1;\n' > "$FX"
check "LintComments_FixedButNotPruned_ExitsOne" 1 "$(gate --files "$FX" --no-admission --baseline "$OWN")"
expect_output "LintComments_FixedButNotPruned_NamesTheStaleEntry" "baseline lists 1 block\\(s\\) with hash $HASH"

printf '/** Count to one. */\nexport function one() {\n  // step one\n  return 1;\n}\n' > "$FX"
check "LintComments_CommentInsideAFunction_ExitsOne" 1 "$(gate --files "$FX" --no-admission --baseline "$TMP/empty.tsv")"
expect_output "LintComments_CommentInsideAFunction_NamesThePlacementRule" "comments/comment-placement"

printf '/** The retry budget should be three; the caller reads it. */\nexport const a = 1;\n' > "$FX"
check "LintComments_DescriptionBreaksAnSteRule_ExitsOne" 1 "$(gate --files "$FX" --no-admission --baseline "$TMP/empty.tsv")"
expect_output "LintComments_DescriptionBreaksAnSteRule_NamesTheProseRule" "comments/comment-prose"

printf '#!/usr/bin/env bash\ncat <<EOF\nit'"'"'s a body\nEOF\n# wave 3 cleanup\necho done\n' > "$FX_DIR/fixture.sh"
check "LintComments_ShellCommentAfterHeredoc_ExitsOne" 1 "$(gate --files "$FX_DIR/fixture.sh" --no-admission --baseline "$TMP/empty.tsv")"
rm -f "$FX_DIR/fixture.sh"

if git cat-file -e "HEAD:$BASELINE" 2>/dev/null; then
  LINE="$(git show "HEAD:$BASELINE" | head -1)"
  FILE="$(cut -f1 <<<"$LINE")"
  ENTRY="$(cut -f2 <<<"$LINE")"
  COUNT="$(cut -f3 <<<"$LINE")"
  awk -F'\t' -v f="$FILE" -v h="$ENTRY" -v c="$((COUNT + 1))" 'BEGIN { OFS = "\t" } $1 == f && $2 == h { $3 = c } { print }' \
    "$TMP/baseline.tsv" > "$BASELINE"
  check "LintComments_HandGrownEntry_ExitsOne" 1 "$(gate --files "$FILE" --base HEAD)"
  expect_output "LintComments_HandGrownEntry_FailsAdmission" "grew from $COUNT to $((COUNT + 1))|only $COUNT existed at HEAD"
  cp "$TMP/baseline.tsv" "$BASELINE"
else
  echo "  skip: LintComments_HandGrownEntry (HEAD has no baseline to compare with)"
fi

printf '/** The retry budget is three attempts. */\nexport const a = 1;\n' > "$FX"
check "LintComments_MissingConfig_ExitsTwo" 2 "$(gate --files "$FX" --no-admission --config eslint.MISSING.js)"
check "LintComments_PullRequestWithoutBase_ExitsTwo" 2 \
  "$(GITHUB_EVENT_NAME=pull_request GITHUB_BASE_REF='' node "$GATE" --files "$FX" --baseline "$TMP/empty.tsv" >"$TMP/out" 2>&1; echo $?)"
expect_output "LintComments_PullRequestWithoutBase_NamesTheCause" "GITHUB_BASE_REF is not set"

echo "lint-comments self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
