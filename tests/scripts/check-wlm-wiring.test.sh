#!/usr/bin/env bash
# Self-test for check-wlm-wiring.mjs.
#   - Each fixture exercises one rule: rule 1 (retry-adapter coverage) or rule 2
#     (no raw merge_orchestrate integration directive). It overrides only the
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
# A file under orchestrate/ that is not one of the 5 wired files holds a naked
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

# ── WiringGate_WrappedIdioms_Pass ───────────────────────────────────────────
# The fixture holds the 5 wired files with their retry idioms, and the merge
# seam. The seam calls the wrapped executor and has no raw spawn. The gate must
# pass. The paths match the allowlist of the gate.
mkdir -p "$TMP/wrapped/verbs/vcs" "$TMP/wrapped/verbs/team" \
  "$TMP/wrapped/verbs/worktree" "$TMP/wrapped/verbs/merge" "$TMP/wrapped/workflow"
cat > "$TMP/wrapped/verbs/vcs/git-exec-default.ts" <<'EOF'
import { execFileSync } from 'node:child_process';
import { withIndexLockRetrySync } from '../worktree/git-retry.js';
function runGitOnce(repoRoot: string, args: readonly string[]) {
  return execFileSync('git', [...args], { cwd: repoRoot });
}
export function defaultGitExec(repoRoot: string, args: readonly string[]) {
  return withIndexLockRetrySync(() => runGitOnce(repoRoot, args));
}
EOF
cat > "$TMP/wrapped/verbs/team/setup-worktree.ts" <<'EOF'
import { execFileSync } from 'node:child_process';
import { burstStagger } from '../worktree/git-retry.js';
function gitExec(repoRoot: string, args: readonly string[]) {
  return execFileSync('git', ['-C', repoRoot, ...args]);
}
export async function handleSetupWorktree(repoRoot: string, worktreePath: string, branch: string) {
  await burstStagger({});
  gitExec(repoRoot, ['worktree', 'add', worktreePath, branch]);
}
EOF
cat > "$TMP/wrapped/verbs/worktree/git-retry.ts" <<'EOF'
export async function withIndexLockRetry(op: () => Promise<unknown>) { return op(); }
export function withIndexLockRetrySync<T>(op: () => T): T { return op(); }
export async function burstStagger(_opts: Record<string, unknown>) { return 0; }
EOF
cat > "$TMP/wrapped/verbs/worktree/manager.ts" <<'EOF'
import { withIndexLockRetry } from './git-retry.js';
export class WorktreeManager {
  constructor(private gitRunner: { run(args: readonly string[], cwd: string): { status: number } }) {}
  async removeWorktreeIfRegistered(repoRoot: string, worktreePath: string) {
    return withIndexLockRetry(() => this.gitRunner.run(['worktree', 'remove', '--force', worktreePath], repoRoot));
  }
}
EOF
cat > "$TMP/wrapped/verbs/merge/merge-orchestrate.ts" <<'EOF'
import { defaultGitExec } from '../vcs/git-exec-default.js';
export function handleMergeOrchestrate(repoRoot: string) {
  return defaultGitExec(repoRoot, ['worktree', 'list', '--porcelain']);
}
EOF
cat > "$TMP/wrapped/workflow/compensation.ts" <<'EOF'
import { withIndexLockRetry } from '../verbs/worktree/git-retry.js';
async function runCommand(cmd: string, args: readonly string[]) { return { status: 0 }; }
export async function cleanupWorktree(worktreePath: string) {
  return withIndexLockRetry(() => runCommand('git', ['worktree', 'remove', worktreePath, '--force']));
}
EOF
set +e
node "$GATE" --src-root "$TMP/wrapped" >/tmp/wlm-wrapped.out 2>&1
wrapped_exit=$?
set -e
check "WiringGate_WrappedIdioms_Pass" 0 "$wrapped_exit"
[[ "$wrapped_exit" == "0" ]] || cat /tmp/wlm-wrapped.out

# ── WiringGate_SkillRawMergeOrchestrate_Fails ───────────────────────────────
# A content fixture directs a raw `merge_orchestrate` at an integration merge,
# with no `serialize_merge` caveat on the same line. The gate must fail.
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
grep -q "rule2-raw-merge-orchestrate-integration-directive" /tmp/wlm-badskill.out || { echo "  FAIL: missing rule2 tag"; fail=$((fail + 1)); }

# A skill that names `merge_orchestrate` with the `serialize_merge` caveat must
# pass. Thus the rule reads the directive, not the mention of the name.
mkdir -p "$TMP/goodskill/some-skill"
cat > "$TMP/goodskill/some-skill/SKILL.md" <<'EOF'
---
name: some-skill
description: test fixture
---
# Some Skill
Route integration merges through `serialize_merge`; do not dispatch raw `merge_orchestrate` for them.
EOF
set +e
node "$GATE" --skills-root "$TMP/goodskill" >/tmp/wlm-goodskill.out 2>&1
goodskill_exit=$?
set -e
check "skills fixture with serialize_merge caveat passes" 0 "$goodskill_exit"
[[ "$goodskill_exit" == "0" ]] || cat /tmp/wlm-goodskill.out

# ── WiringGate_MergeSeamOutsideWorktreeDir_StillInScope ─────────────────────
# A naked worktree-mutating git spawn sits directly under orchestrate/, not
# under orchestrate/worktree/. The gate must walk the file and fail. The path
# orchestrate/merge-orchestrate.ts is not one of the 5 wired files, so no
# allowlist entry covers it.
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
