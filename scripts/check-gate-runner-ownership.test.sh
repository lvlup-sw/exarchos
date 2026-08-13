#!/usr/bin/env bash
# Deterministic self-test for the v2.12 gate-runner ownership census.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE="$SCRIPT_DIR/check-gate-runner-ownership.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
check_rejected() { # name, source, diagnostic
  local name="$1" source="$2" diagnostic="$3"
  local root="$TMP/$name"
  mkdir -p "$root/src/orchestrate"
  printf '%s\n' "$source" > "$root/src/orchestrate/probe.ts"
  set +e
  node "$GATE" --repo-root "$root" >"$root/out" 2>"$root/err"
  local status=$?
  set -e
  if [[ "$status" == "1" ]] &&
     grep -q "src/orchestrate/probe.ts:1" "$root/err" &&
     grep -q "$diagnostic" "$root/err"; then
    echo "  ok: $name"
    pass=$((pass + 1))
  else
    echo "  FAIL: $name (exit $status)"
    cat "$root/out" "$root/err"
    fail=$((fail + 1))
  fi
}

check_rejected \
  "GateRunnerCensus_DirectEmitter_IsRejected" \
  "emitGateEvent(store, featureId, 'rogue', 'review', true);" \
  "Route enforceable gate production through"

check_rejected \
  "GateRunnerCensus_UnownedProvider_IsRejected" \
  "const ROGUE_GATE_PROVIDERS = { security: { actionName: 'scan' } };" \
  "Unowned GateClass/provider registration"

check_rejected \
  "GateRunnerCensus_UnownedGateClass_IsRejected" \
  "export type RogueGateClass = 'rogue';" \
  "Unowned GateClass/provider registration"

check_rejected \
  "GateRunnerCensus_LegacyShellGuard_IsRejected" \
  "const guardRegistry = new Map(); executeGuard({ command: 'echo bypass' });" \
  "Unowned legacy custom-shell transition guard"

if node "$GATE" --repo-root "$REPO_ROOT" >/dev/null; then
  echo "  ok: GateRunnerCensus_RealTree_HasTypedOwners"
  pass=$((pass + 1))
else
  echo "  FAIL: GateRunnerCensus_RealTree_HasTypedOwners"
  node "$GATE" --repo-root "$REPO_ROOT" || true
  fail=$((fail + 1))
fi

echo "check-gate-runner-ownership self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
