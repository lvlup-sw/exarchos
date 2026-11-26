#!/usr/bin/env bash
# Self-test for check-wlm-wiring.mjs.
#   - Each fixture exercises one rule: rule 1 (retry-adapter coverage) or rule 2
#     (no content line names a retired merge action). It overrides only the
#     root flag of that rule, so the other rule runs on the real tree.
#   - The real repo must pass (exit 0).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../tools/audit/gates" && pwd)"
GATE="$SCRIPT_DIR/check-wlm-wiring.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
check() { # <description> <expected-exit> <actual-exit>
  if [[ "$2" == "$3" ]]; then echo "  ok: $1"; pass=$((pass + 1));
  else echo "  FAIL: $1 (expected exit $2, got $3)"; fail=$((fail + 1)); fi
}

# ── WiringGate_NakedWorktreeMutation_Fails ──────────────────────────────────
# A file under orchestrate/ that is not a wired file holds a naked
# worktree-mutating git spawn. The gate must fail.
mkdir -p "$TMP/naked/orchestrate"
cat > "$TMP/naked/orchestrate/reap-worktree.ts" <<'EOF'
import { execFileSync } from 'node:child_process';
export function reapWorktree(repoRoot: string, worktreePath: string) {
  return execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
}
EOF
set +e
node "$GATE" --src-root "$TMP/naked" >/tmp/wlm-naked.out 2>&1
naked_exit=$?
set -e
check "WiringGate_NakedWorktreeMutation_Fails" 1 "$naked_exit"
grep -q "rule1-naked-worktree-mutation" /tmp/wlm-naked.out || { echo "  FAIL: missing rule1-naked-worktree-mutation tag"; fail=$((fail + 1)); }

# ── WiringGate_LedgerOnlyTree_Pass ──────────────────────────────────────────
# The fixture holds a ledger-only compensation module and a worktree verb
# that only reads. Neither holds a worktree mutation, so the gate must pass.
mkdir -p "$TMP/wrapped/verbs/worktree" "$TMP/wrapped/workflow"
cat > "$TMP/wrapped/verbs/worktree/list.ts" <<'EOF'
export const LIST_ARGS = ['worktree', 'list', '--porcelain'] as const;
EOF
cat > "$TMP/wrapped/workflow/compensation.ts" <<'EOF'
export function recordWorktree(worktreePath: string) {
  return { kind: 'worktree', ref: worktreePath, status: 'outstanding' };
}
EOF
set +e
node "$GATE" --src-root "$TMP/wrapped" >/tmp/wlm-wrapped.out 2>&1
wrapped_exit=$?
set -e
check "WiringGate_LedgerOnlyTree_Pass" 0 "$wrapped_exit"
[[ "$wrapped_exit" == "0" ]] || cat /tmp/wlm-wrapped.out

# ── WiringGate_CompensationWorktreeMutation_Fails ───────────────────────────
# The cancel compensation is ledger-only and is not a wired file. A worktree
# removal in it must fail.
mkdir -p "$TMP/compensation/workflow"
cat > "$TMP/compensation/workflow/compensation.ts" <<'EOF'
async function runCommand(cmd: string, args: readonly string[]) { return { status: 0 }; }
export async function cleanupWorktree(worktreePath: string) {
  return runCommand('git', ['worktree', 'remove', worktreePath, '--force']);
}
EOF
set +e
node "$GATE" --src-root "$TMP/compensation" >/tmp/wlm-compensation.out 2>&1
compensation_exit=$?
set -e
check "WiringGate_CompensationWorktreeMutation_Fails" 1 "$compensation_exit"
grep -q "workflow/compensation.ts:.*rule1-naked-worktree-mutation" /tmp/wlm-compensation.out || { echo "  FAIL: compensation.ts site not reported"; fail=$((fail + 1)); }

# ── WiringGate_SkillRawMergeOrchestrate_Fails ───────────────────────────────
# A content fixture directs a raw `merge_orchestrate` at an integration merge.
# The action is retired, so the gate must fail.
mkdir -p "$TMP/badskill/some-skill"
cat > "$TMP/badskill/some-skill/SKILL.md" <<'EOF'
---
name: some-skill
description: test fixture
---
# Some Skill
Use `merge_orchestrate` directly to land the branch onto the integration branch.
EOF
set +e
node "$GATE" --skills-root "$TMP/badskill" >/tmp/wlm-badskill.out 2>&1
badskill_exit=$?
set -e
check "WiringGate_SkillRawMergeOrchestrate_Fails" 1 "$badskill_exit"
grep -q "rule2-retired-merge-action" /tmp/wlm-badskill.out || { echo "  FAIL: missing rule2 tag"; fail=$((fail + 1)); }

# ── WiringGate_SkillSerializeMergeCaveat_Fails ──────────────────────────────
# A skill line that routes integration merges through `serialize_merge` was the
# old legal pairing. Both actions are retired now, so the gate must fail.
mkdir -p "$TMP/caveatskill/some-skill"
cat > "$TMP/caveatskill/some-skill/SKILL.md" <<'EOF'
---
name: some-skill
description: test fixture
---
# Some Skill
Route integration merges through `serialize_merge`; do not dispatch raw `merge_orchestrate` for them.
EOF
set +e
node "$GATE" --skills-root "$TMP/caveatskill" >/tmp/wlm-caveatskill.out 2>&1
caveatskill_exit=$?
set -e
check "WiringGate_SkillSerializeMergeCaveat_Fails" 1 "$caveatskill_exit"
grep -q "serialize_merge" /tmp/wlm-caveatskill.out || { echo "  FAIL: serialize_merge not reported"; fail=$((fail + 1)); }

# A skill line that names the harness landing and no retired action must pass.
mkdir -p "$TMP/goodskill/some-skill"
cat > "$TMP/goodskill/some-skill/SKILL.md" <<'EOF'
---
name: some-skill
description: test fixture
---
# Some Skill
The harness lands each accepted task head onto the integration branch, and settle observes the landing.
EOF
set +e
node "$GATE" --skills-root "$TMP/goodskill" >/tmp/wlm-goodskill.out 2>&1
goodskill_exit=$?
set -e
check "skills fixture with no retired merge action passes" 0 "$goodskill_exit"
[[ "$goodskill_exit" == "0" ]] || cat /tmp/wlm-goodskill.out

# ── WiringGate_MergeSeamOutsideWorktreeDir_StillInScope ─────────────────────
# A naked worktree-mutating git spawn sits directly under orchestrate/, not
# under orchestrate/worktree/. The gate must walk the file and fail. The path
# orchestrate/merge-orchestrate.ts is not a wired file, so no allowlist entry
# covers it.
mkdir -p "$TMP/seam/orchestrate"
cat > "$TMP/seam/orchestrate/merge-orchestrate.ts" <<'EOF'
import { execFileSync } from 'node:child_process';
export function forceRemoveDuringMerge(repoRoot: string, worktreePath: string) {
  return execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
}
EOF
set +e
node "$GATE" --src-root "$TMP/seam" >/tmp/wlm-seam.out 2>&1
seam_exit=$?
set -e
check "WiringGate_MergeSeamOutsideWorktreeDir_StillInScope" 1 "$seam_exit"
grep -q "orchestrate/merge-orchestrate.ts" /tmp/wlm-seam.out || { echo "  FAIL: merge-orchestrate.ts site not reported"; fail=$((fail + 1)); }

# ── The real repo must be clean ─────────────────────────────────────────────
set +e
node "$GATE" >/tmp/wlm-repo.out 2>&1
repo_exit=$?
set -e
check "real repo is clean" 0 "$repo_exit"
[[ "$repo_exit" == "0" ]] || cat /tmp/wlm-repo.out

echo "check-wlm-wiring self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
