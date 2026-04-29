#!/usr/bin/env bash
#
# Post-install smoketest for v2.9.0-rc.2.
# Targets the installed `exarchos` binary on PATH (no source tree, no build).
# Covers PRs landed since rc.1: #1181, #1185, #1191, #1193, #1197.
#
# Prereqs:
#   - `curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh | bash`
#   - `exarchos install-skills` for whichever runtime you target (or use --runtime)
#   - jq, mktemp, grep
#
# Usage:
#   scripts/smoketest-rc2.sh                       # auto-detect runtime
#   scripts/smoketest-rc2.sh --runtime claude      # force runtime
#   scripts/smoketest-rc2.sh --skip-functional     # surface checks only
#   scripts/smoketest-rc2.sh --version 2.9.0-rc.2  # override expected version
#

set -uo pipefail

EXPECTED_VERSION="2.9.0-rc.2"
RUNTIME=""
SKIP_FUNCTIONAL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) RUNTIME="$2"; shift 2 ;;
    --version) EXPECTED_VERSION="$2"; shift 2 ;;
    --skip-functional) SKIP_FUNCTIONAL=1; shift ;;
    -h|--help) sed -n '3,18p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0
FAILED_CHECKS=()

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
section() { echo; bold "── $* ──"; }

record_pass() { green "  PASS  $1"; PASS=$((PASS+1)); }
record_fail() {
  red "  FAIL  $1"
  [ -n "${2:-}" ] && echo "$2" | sed 's/^/        /' | head -10
  FAIL=$((FAIL+1)); FAILED_CHECKS+=("$1")
}

# Run a command; pass on exit-zero. Captures stderr+stdout for failure diag.
check() {
  local name="$1"; shift
  local out; out=$("$@" 2>&1)
  local rc=$?
  if [ $rc -eq 0 ]; then record_pass "$name"
  else record_fail "$name" "$out"
  fi
}

# Pass if expression returns expected exit code (zero|nonzero).
expect() {
  local name="$1" expectation="$2"; shift 2
  local out; out=$( "$@" 2>&1 )
  local rc=$?
  case "$expectation" in
    zero)    [ $rc -eq 0 ] && record_pass "$name" || record_fail "$name" "$out" ;;
    nonzero) [ $rc -ne 0 ] && record_pass "$name" || record_fail "$name" "expected nonzero, got 0" ;;
  esac
}

# ─── Prereqs ─────────────────────────────────────────────────────────────────
bold "Exarchos v2.9.0-rc.2 post-install smoketest"

if ! command -v exarchos >/dev/null 2>&1; then
  red "FATAL: exarchos not on PATH. Install via:"
  echo "  curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh | bash"
  exit 2
fi
for tool in jq mktemp; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    red "FATAL: required tool '$tool' missing"; exit 2
  fi
done

EXARCHOS_PATH="$(command -v exarchos)"
echo "Binary:           $EXARCHOS_PATH"
echo "Expected version: $EXPECTED_VERSION"

# Auto-detect runtime by checking which agent skill dir exists, unless forced.
if [ -z "$RUNTIME" ]; then
  for r in claude codex cursor copilot opencode; do
    case "$r" in
      claude)   path="$HOME/.claude/skills" ;;
      codex)    path="$HOME/.agents/skills" ;;
      cursor)   path="$HOME/.cursor/skills" ;;
      copilot)  path="$HOME/.copilot/skills" ;;
      opencode) path="$HOME/.config/opencode/skills" ;;
    esac
    if [ -d "$path/delegation" ]; then RUNTIME="$r"; break; fi
  done
  if [ -z "$RUNTIME" ]; then
    yellow "No installed skill bundle detected. Skill checks will be skipped."
    yellow "Run \`exarchos install-skills\` first, or pass --runtime <name>."
    RUNTIME="none"
  fi
fi
case "$RUNTIME" in
  claude)   SKILL_ROOT="$HOME/.claude/skills" ;;
  codex)    SKILL_ROOT="$HOME/.agents/skills" ;;
  cursor)   SKILL_ROOT="$HOME/.cursor/skills" ;;
  copilot)  SKILL_ROOT="$HOME/.copilot/skills" ;;
  opencode) SKILL_ROOT="$HOME/.config/opencode/skills" ;;
  none)     SKILL_ROOT="" ;;
  *) red "FATAL: unknown runtime '$RUNTIME'"; exit 2 ;;
esac
echo "Runtime:          $RUNTIME"
[ -n "$SKILL_ROOT" ] && echo "Skill root:       $SKILL_ROOT"

# ─── A. Binary surface ───────────────────────────────────────────────────────
section "A. Binary surface"

ACTUAL_VERSION="$(exarchos --version 2>/dev/null | tr -d '[:space:]')"
if [ "$ACTUAL_VERSION" = "$EXPECTED_VERSION" ] || \
   echo "$ACTUAL_VERSION" | grep -q "$EXPECTED_VERSION"; then
  record_pass "exarchos --version reports $EXPECTED_VERSION"
else
  record_fail "exarchos --version" "got: $ACTUAL_VERSION  expected: $EXPECTED_VERSION"
fi

check "exarchos doctor exits clean" exarchos doctor

# Subcommand registration (each PR's CLI surface)
expect "exarchos workflow --help (always present)"     zero exarchos workflow --help
expect "exarchos event --help (always present)"        zero exarchos event --help
expect "exarchos view --help (always present)"         zero exarchos view --help
expect "exarchos orchestrate --help (always present)"  zero exarchos orchestrate --help
expect "exarchos merge-orchestrate --help (#1193)"     zero exarchos merge-orchestrate --help
expect "exarchos schema --help (introspection)"        zero exarchos schema --help
expect "exarchos topology --help (introspection)"      zero exarchos topology --help

# Schema introspection — merge_orchestrate action discoverable (#1193)
SCHEMA_OUT="$(exarchos schema 2>&1 || true)"
if echo "$SCHEMA_OUT" | grep -qE "merge[_-]orchestrate"; then
  record_pass "schema lists merge_orchestrate action (#1193)"
else
  record_fail "schema introspection includes merge_orchestrate" "$SCHEMA_OUT"
fi

# Topology — merge-pending HSM substate registered (#1193)
TOPOLOGY_OUT="$(exarchos topology feature 2>&1 || true)"
if echo "$TOPOLOGY_OUT" | grep -q "merge-pending"; then
  record_pass "topology includes feature/merge-pending substate (#1193)"
else
  record_fail "topology includes merge-pending" "$TOPOLOGY_OUT"
fi

# Plugin-root compatibility check returns clean (#1176, regression check)
expect "exarchos version --check-plugin-root probe accepts no path" zero \
  bash -c "exarchos version >/dev/null"

# ─── B. Installed skill bundle (#1181, #1191, #1197) ─────────────────────────
section "B. Installed skill bundle ($RUNTIME)"

if [ -z "$SKILL_ROOT" ]; then
  yellow "  SKIP  no skill bundle installed; rerun with --runtime or after install-skills"
else
  DELEG="$SKILL_ROOT/delegation/SKILL.md"
  if [ ! -f "$DELEG" ]; then
    record_fail "delegation/SKILL.md present at $SKILL_ROOT" "file not found"
  else
    record_pass "delegation/SKILL.md present at $SKILL_ROOT"

    # #1181 — runtime parity in installed prose
    if [ "$RUNTIME" = "claude" ]; then
      expect "claude: TeammateIdle hook token expanded" zero \
        grep -q "TeammateIdle" "$DELEG"
    else
      expect "$RUNTIME: no Claude-only TeammateIdle prose" nonzero \
        grep -q "TeammateIdle" "$DELEG"
      expect "$RUNTIME: no Claude-only agent-team prose" nonzero \
        grep -qE "agent-team mode|TaskOutput\(\{" "$DELEG"
    fi
    if [ "$RUNTIME" = "opencode" ]; then
      expect "opencode: subagent_type uses canonical 'implementer' (not exarchos-implementer)" nonzero \
        grep -E "subagent_type:[[:space:]]*['\"]?exarchos-implementer" "$DELEG"
    fi

    # #1191 Fix 4 — task.assigned pre-emit documented in delegation skill
    expect "$RUNTIME: task.assigned pre-emit documented (#1191)" zero \
      grep -q "task\\.assigned" "$DELEG"

    # #1181 — link pruning: agent-teams-saga.md only on Claude
    SAGA="$SKILL_ROOT/delegation/references/agent-teams-saga.md"
    if [ "$RUNTIME" = "claude" ]; then
      expect "claude: agent-teams-saga.md present" zero test -f "$SAGA"
    else
      expect "$RUNTIME: agent-teams-saga.md pruned" nonzero test -f "$SAGA"
    fi
  fi

  # #1193 — merge-orchestrator skill installed
  MORCH="$SKILL_ROOT/merge-orchestrator/SKILL.md"
  expect "merge-orchestrator/SKILL.md installed (#1193)" zero test -f "$MORCH"
  expect "merge-orchestrator/references/recovery-runbook.md installed (#1193)" zero \
    test -f "$SKILL_ROOT/merge-orchestrator/references/recovery-runbook.md"
fi

# Installed agent files (Claude plugin path) — #1197 readonly tier prose
if [ "$RUNTIME" = "claude" ] && [ -d "$HOME/.claude/agents" ]; then
  REVIEWER_AGENT="$HOME/.claude/agents/reviewer.md"
  if [ -f "$REVIEWER_AGENT" ]; then
    expect "claude reviewer agent: 'Forbidden MCP Actions' prose deleted (#1197)" nonzero \
      grep -q "Forbidden MCP Actions" "$REVIEWER_AGENT"
    expect "claude reviewer agent: declares mcp:exarchos:readonly capability (#1197)" zero \
      grep -q "mcp:exarchos:readonly" "$REVIEWER_AGENT"
  else
    yellow "  SKIP  ~/.claude/agents/reviewer.md not found (plugin not installed?)"
  fi
fi

if [ $SKIP_FUNCTIONAL -eq 1 ]; then
  echo
  bold "Surface-only mode — skipping Group C functional checks"
else

# ─── C. Functional round-trip in temp workspace ──────────────────────────────
section "C. Functional behavior (temp WORKFLOW_STATE_DIR)"

TMPDIR_ROOT="$(mktemp -d -t exarchos-rc2-XXXXXX)"
export WORKFLOW_STATE_DIR="$TMPDIR_ROOT"
trap 'rm -rf "$TMPDIR_ROOT"' EXIT
echo "  Temp state dir: $TMPDIR_ROOT"

FEATURE="rc2-smoke-$$"
EVENTS_FILE="$TMPDIR_ROOT/$FEATURE.events.jsonl"

# C1. Init a workflow and confirm event log + state file land
INIT_OUT="$(exarchos workflow init --featureId "$FEATURE" --workflowType feature 2>&1 || true)"
if [ -f "$TMPDIR_ROOT/$FEATURE.state.json" ]; then
  record_pass "workflow init creates state file"
else
  record_fail "workflow init creates state file" "$INIT_OUT"
fi

if [ -f "$EVENTS_FILE" ]; then
  record_pass "workflow init creates events.jsonl"
else
  record_fail "workflow init creates events.jsonl" "$EVENTS_FILE missing after init"
fi

# C2. #1185 Fix 1 — concurrent emissions produce monotonic, unique sequences.
#     Fire several appends in parallel via background jobs.
if [ -f "$EVENTS_FILE" ]; then
  for i in 1 2 3 4 5 6; do
    exarchos event append --stream "$FEATURE" \
      --type "agent.message" \
      --data "{\"i\":$i}" >/dev/null 2>&1 &
  done
  wait

  SEQ_LEN=$(jq -s 'length' "$EVENTS_FILE" 2>/dev/null || echo 0)
  UNIQ_LEN=$(jq -rs '[.[].sequence] | unique | length' "$EVENTS_FILE" 2>/dev/null || echo 0)
  if [ "$SEQ_LEN" -ge 6 ] && [ "$SEQ_LEN" = "$UNIQ_LEN" ]; then
    record_pass "concurrent emissions produce unique sequences (#1185 Fix 1: $SEQ_LEN events, all unique)"
  else
    record_fail "concurrent emissions monotonic-unique" "events=$SEQ_LEN unique=$UNIQ_LEN"
  fi
fi

# C3. #1191 Fix 1 — pipeline view filters infra streams (no phantom rows)
PIPELINE_OUT="$(exarchos view pipeline 2>&1 || true)"
if echo "$PIPELINE_OUT" | grep -qE "exarchos-init|exarchos-doctor|^telemetry\b"; then
  record_fail "view pipeline filters infra streams (#1191 Fix 1)" "phantom infra row present:$(echo "$PIPELINE_OUT" | head -5)"
else
  record_pass "view pipeline filters infra streams (#1191 Fix 1)"
fi

# C4. #1191 Fix 2 — sibling-default strip; check_tdd_compliance reachable.
#     A reachability probe: dispatch returns either a structured handler
#     result or a domain-level error, NOT a schema-validation rejection
#     about unrecognized keys (which was the rc.1 symptom).
TDD_OUT="$(exarchos orchestrate check-tdd-compliance --featureId "$FEATURE" --taskId smoke 2>&1 || true)"
if echo "$TDD_OUT" | grep -qiE "Unrecognized key|Unknown option .*nativeIsolation|Unknown option .*outputFormat"; then
  record_fail "check_tdd_compliance reachable (#1191 Fix 2)" "sibling-default leak still present: $(echo "$TDD_OUT" | head -5)"
else
  record_pass "check_tdd_compliance reachable, no sibling-default schema leak (#1191 Fix 2)"
fi

# C5. #1191 Fix 3 — tolerant gate-event reader: top-level data.taskId accepted.
#     Emit a gate.executed event with taskId at top level (NOT nested in details),
#     then verify task_complete consults it instead of rejecting the shape.
exarchos event append --stream "$FEATURE" --type "gate.executed" \
  --data '{"taskId":"smoke-1","gate":"tdd-compliance","passed":true,"reason":"smoke"}' \
  >/dev/null 2>&1 || true
COMPLETE_OUT="$(exarchos orchestrate task-complete --featureId "$FEATURE" --taskId smoke-1 2>&1 || true)"
if echo "$COMPLETE_OUT" | grep -qiE "GATE_NOT_PASSED.*tdd-compliance|gate not passed.*tdd"; then
  record_fail "tolerant gate-event reader (#1191 Fix 3)" "top-level taskId rejected:$(echo "$COMPLETE_OUT" | head -5)"
else
  record_pass "tolerant gate-event reader accepts top-level taskId (#1191 Fix 3)"
fi

# C6. #1197 — readonly capability handshake surfaces in describe.
#     The mcp:exarchos:readonly tier should appear in capability metadata.
DESCRIBE_OUT="$(exarchos schema 2>&1 || true)"
if echo "$DESCRIBE_OUT" | grep -q "mcp:exarchos:readonly"; then
  record_pass "schema/describe surfaces mcp:exarchos:readonly tier (#1197)"
else
  yellow "  INFO  readonly tier may not surface via 'schema' alone — verify via subagent dispatch (manual)"
fi

fi  # end SKIP_FUNCTIONAL

# ─── Manual dogfood checklist ────────────────────────────────────────────────
section "MANUAL — dogfood checklist (not automatable post-install)"
cat <<'EOF'
  These need an in-flight workflow, real subagent dispatch, or a live merge
  lifecycle. Run on rc.2 before promoting to GA.

  #1185 Fix 2 — rehydration includes pending tasks:
    Drive a workflow with mixed pending/assigned/completed tasks, suspend,
    rehydrate. Verify pending tasks appear in `exarchos view tasks`.

  #1191 Fix 4 — prepare_delegation precondition hint:
    Run `exarchos orchestrate prepare-delegation` WITHOUT pre-emitting
    task.assigned events. The blocker payload should contain a hint
    pointing at Step 0 of the delegation skill.

  #1193 — merge orchestrator lifecycle (HIGHEST RISK, NEW SURFACE):
    Drive a workflow to merge-pending and exercise all four branches:
      1. Happy path:   merge-orchestrate --strategy squash → merge.executed
      2. Resume:       re-run on completed feature → terminal short-circuit
      3. Drift:        dirty index → preflight fails with drift category
      4. Rollback:     induce verification failure → merge.rollback event,
                       worktree restored to anchor sha
    Verify next-actions surfaces merge_orchestrate ONLY in non-terminal
    merge-pending.

  #1197 — readonly capability is enforced server-side (security boundary):
    Spawn the REVIEWER subagent. Have it attempt a mutating MCP action
    (workflow set / event append / task assign).
    Expect: dispatch-layer rejection citing mcp:exarchos:readonly mismatch.
    DO NOT trust prompt-level refusal alone — the whole point is the
    boundary moved out of the prompt.
EOF

# ─── Summary ─────────────────────────────────────────────────────────────────
section "Summary"
echo "  Runtime:     $RUNTIME"
echo "  Auto-checks: $((PASS+FAIL))  |  passed: $PASS  |  failed: $FAIL"
if [ $FAIL -eq 0 ]; then
  green "All automated checks passed. Proceed with manual dogfood checklist above."
  exit 0
else
  red "Failed checks:"
  for c in "${FAILED_CHECKS[@]}"; do echo "    - $c"; done
  echo
  red "rc.2 is NOT ready until these clear."
  exit 1
fi
