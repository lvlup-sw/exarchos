#!/usr/bin/env bash
# sync-marketplace.test.sh — assertions for scripts/sync-marketplace.sh (#1690, DR-24).
#
# The standalone path must populate the NEW version's plugin cache and update
# installed_plugins.json BEFORE pruning — never prune-then-silently-revert
# (the harness re-downloads the OLD version when installPath dangles).
#
# Hermetic by construction: the script under test hardcodes ${HOME}/.claude/plugins,
# so every run gets a throwaway HOME (mktemp) — the real plugin cache is never
# touched. The SUT is copied under a fake repo root so the version it reads from
# package.json is pinned, and `npm` is shimmed on PATH — no network.
# Run directly: `bash scripts/sync-marketplace.test.sh`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_SUT="$SCRIPT_DIR/sync-marketplace.sh"
OLD_VERSION="9.9.8"
NEW_VERSION="9.9.9"
PASS=0
FAIL=0

# Never let ambient git config (gpgsign, templates, …) leak into the sandbox.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

SANDBOX=""
cleanup() { [[ -n "$SANDBOX" && -d "$SANDBOX" ]] && rm -rf "$SANDBOX"; }
trap cleanup EXIT

# Build a fresh sandbox: fake HOME (marketplace clone as a real git repo,
# old-version cache dir with a version marker, installed_plugins.json pointing
# at it), fake repo root pinning package.json to $NEW_VERSION, fake `npm`.
setup_sandbox() {
  cleanup
  SANDBOX="$(mktemp -d)"
  FAKE_HOME="$SANDBOX/home"
  FAKE_BIN="$SANDBOX/bin"
  SUT="$SANDBOX/repo/scripts/sync-marketplace.sh"
  MKT_DIR="$FAKE_HOME/.claude/plugins/marketplaces/lvlup-sw"
  CACHE="$FAKE_HOME/.claude/plugins/cache/lvlup-sw/exarchos"
  INSTALLED="$FAKE_HOME/.claude/plugins/installed_plugins.json"

  if [[ -z "$FAKE_HOME" || "$FAKE_HOME" == "$HOME" ]]; then
    echo "FATAL: sandbox HOME setup failed (would touch real HOME)" >&2
    exit 1
  fi

  # SUT copy under a fake repo root — the script derives REPO_ROOT from its
  # own location and reads the version from ${REPO_ROOT}/package.json.
  mkdir -p "$SANDBOX/repo/scripts"
  cp "$REAL_SUT" "$SUT"
  printf '{"name":"@lvlup-sw/exarchos","version":"%s"}\n' "$NEW_VERSION" \
    > "$SANDBOX/repo/package.json"

  # Marketplace clone must be a real git repo — the SUT commits into it.
  mkdir -p "$MKT_DIR/.claude-plugin"
  printf '{"plugins":[{"name":"exarchos","version":"%s","source":{"source":"npm","package":"@lvlup-sw/exarchos","version":"%s"}}]}\n' \
    "$OLD_VERSION" "$OLD_VERSION" > "$MKT_DIR/.claude-plugin/marketplace.json"
  git -C "$MKT_DIR" init -q
  git -C "$MKT_DIR" config user.email "selftest@example.invalid"
  git -C "$MKT_DIR" config user.name "sync-marketplace self-test"
  git -C "$MKT_DIR" config commit.gpgsign false
  git -C "$MKT_DIR" add -A
  git -C "$MKT_DIR" commit -qm "seed marketplace at v${OLD_VERSION}"

  # Old-version cache entry with a version marker.
  mkdir -p "$CACHE/$OLD_VERSION/.claude-plugin"
  printf '{"name":"exarchos","version":"%s"}\n' "$OLD_VERSION" \
    > "$CACHE/$OLD_VERSION/.claude-plugin/plugin.json"

  # installed_plugins.json pointing at the old version (harness schema).
  printf '{"version":2,"plugins":{"exarchos@lvlup-sw":[{"scope":"user","installPath":"%s","version":"%s","installedAt":"2026-01-01T00:00:00.000Z","lastUpdated":"2026-01-01T00:00:00.000Z"}]}}\n' \
    "$CACHE/$OLD_VERSION" "$OLD_VERSION" > "$INSTALLED"

  # Fake `npm` — only `pack <spec>`; emits a tarball shaped like the real one
  # (contents under `package/`, filename echoed to stdout). FAKE_NPM_FAIL=1
  # simulates an unpublished version / offline registry.
  mkdir -p "$FAKE_BIN"
  cat > "$FAKE_BIN/npm" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FAKE_NPM_FAIL:-}" == "1" ]]; then
  echo "npm ERR! 404 Not Found - @lvlup-sw/exarchos" >&2
  exit 1
fi
cmd="${1:-}"; shift || true
if [[ "$cmd" != "pack" ]]; then
  echo "fake npm: unsupported command: $cmd $*" >&2
  exit 99
fi
spec=""
for a in "$@"; do
  case "$a" in --*) ;; *) spec="$a" ;; esac
done
ver="${spec##*@}"
work="$(mktemp -d)"
mkdir -p "$work/package/.claude-plugin"
printf '{"name":"exarchos","version":"%s"}\n' "$ver" > "$work/package/.claude-plugin/plugin.json"
printf 'payload for %s\n' "$ver" > "$work/package/marker.txt"
tarball="lvlup-sw-exarchos-${ver}.tgz"
tar -czf "$tarball" -C "$work" package
rm -rf "$work"
echo "$tarball"
FAKE
  chmod +x "$FAKE_BIN/npm"
}

# run_sut [args…] — run the SUT inside the sandbox. Sets OUT and RC.
run_sut() {
  OUT="$(HOME="$FAKE_HOME" XDG_CONFIG_HOME="$FAKE_HOME/.config" \
         PATH="$FAKE_BIN:$PATH" \
         bash "$SUT" "$@" 2>&1)"
  RC=$?
}

# ── StandaloneSync_NewCache_Populated ───────────────────────────────────────
# After a standalone sync the NEW version's cache dir exists with a version
# marker, the old dir is pruned, and --check comes back green (the defect's
# symptom was `BROKEN: … missing path` here, followed by the harness silently
# re-downloading the old version).
setup_sandbox
run_sut --no-push
marker_ver="$(jq -r '.version' "$CACHE/$NEW_VERSION/.claude-plugin/plugin.json" 2>/dev/null || echo missing)"
if [[ $RC -eq 0 && "$marker_ver" == "$NEW_VERSION" ]]; then
  pass "StandaloneSync_NewCache_Populated: new cache dir carries v${NEW_VERSION} marker"
else
  fail "StandaloneSync_NewCache_Populated" "rc=$RC marker=$marker_ver out=$OUT"
fi
if [[ ! -d "$CACHE/$OLD_VERSION" ]]; then
  pass "StandaloneSync_NewCache_Populated: stale v${OLD_VERSION} entry pruned"
else
  fail "StandaloneSync_NewCache_Populated (prune)" "old cache dir survived"
fi
run_sut --check
if [[ $RC -eq 0 ]] && printf '%s\n' "$OUT" | grep -q "Marketplace in sync"; then
  pass "StandaloneSync_NewCache_Populated: post-sync --check green (no dangling installPath to re-download over)"
else
  fail "StandaloneSync_NewCache_Populated (--check)" "rc=$RC out=$OUT"
fi

# ── StandaloneSync_InstalledPluginsJson_Updated ─────────────────────────────
# The script updates installed_plugins.json itself (version + installPath +
# lastUpdated) instead of warn-only, preserving the untouched fields.
setup_sandbox
run_sut --no-push
entry="$(jq -c '.plugins["exarchos@lvlup-sw"][0]' "$INSTALLED" 2>/dev/null || echo '{}')"
got_ver="$(jq -r '.version' <<<"$entry")"
got_path="$(jq -r '.installPath' <<<"$entry")"
got_installed_at="$(jq -r '.installedAt' <<<"$entry")"
got_updated="$(jq -r '.lastUpdated' <<<"$entry")"
got_scope="$(jq -r '.scope' <<<"$entry")"
if [[ $RC -eq 0 && "$got_ver" == "$NEW_VERSION" && "$got_path" == "$CACHE/$NEW_VERSION" ]]; then
  pass "StandaloneSync_InstalledPluginsJson_Updated: version + installPath point at v${NEW_VERSION}"
else
  fail "StandaloneSync_InstalledPluginsJson_Updated" "rc=$RC version=$got_ver installPath=$got_path out=$OUT"
fi
if [[ -d "$got_path" ]]; then
  pass "StandaloneSync_InstalledPluginsJson_Updated: installPath resolves (no dangle → no silent re-download)"
else
  fail "StandaloneSync_InstalledPluginsJson_Updated (dangle)" "installPath missing: $got_path"
fi
if [[ "$got_installed_at" == "2026-01-01T00:00:00.000Z" && "$got_scope" == "user" && "$got_updated" != "2026-01-01T00:00:00.000Z" ]]; then
  pass "StandaloneSync_InstalledPluginsJson_Updated: lastUpdated bumped, installedAt/scope preserved"
else
  fail "StandaloneSync_InstalledPluginsJson_Updated (fields)" "installedAt=$got_installed_at scope=$got_scope lastUpdated=$got_updated"
fi

# ── StandaloneSync_NpmFetchFails_FailSafe ───────────────────────────────────
# If the new version cannot be fetched (unpublished / offline), the prune and
# the installed_plugins.json update must BOTH be skipped — the old install
# stays intact rather than being emptied out from under the harness.
setup_sandbox
FAKE_NPM_FAIL=1 run_sut --no-push
still_ver="$(jq -r '.plugins["exarchos@lvlup-sw"][0].version' "$INSTALLED" 2>/dev/null || echo missing)"
if [[ $RC -eq 0 && -d "$CACHE/$OLD_VERSION" && ! -d "$CACHE/$NEW_VERSION" && "$still_ver" == "$OLD_VERSION" ]]; then
  pass "StandaloneSync_NpmFetchFails_FailSafe: fetch failure → no prune, installed_plugins.json untouched"
else
  fail "StandaloneSync_NpmFetchFails_FailSafe" "rc=$RC old_dir=$([[ -d "$CACHE/$OLD_VERSION" ]] && echo kept || echo PRUNED) installed=$still_ver out=$OUT"
fi
if printf '%s\n' "$OUT" | grep -q "Local cache NOT synced"; then
  pass "StandaloneSync_NpmFetchFails_FailSafe: failure is loud, not silent"
else
  fail "StandaloneSync_NpmFetchFails_FailSafe (warning)" "expected 'Local cache NOT synced' in: $OUT"
fi

# ── StandaloneSync_InUseMarker_NotPruned ────────────────────────────────────
# A stale dir the live session has loaded (`.in_use` marker) survives the
# prune; unmarked stale dirs still go.
setup_sandbox
mkdir -p "$CACHE/9.9.7"
touch "$CACHE/9.9.7/.in_use"
run_sut --no-push
if [[ $RC -eq 0 && -d "$CACHE/9.9.7" && ! -d "$CACHE/$OLD_VERSION" ]]; then
  pass "StandaloneSync_InUseMarker_NotPruned: .in_use dir kept, unmarked stale dir pruned"
else
  fail "StandaloneSync_InUseMarker_NotPruned" "rc=$RC in_use=$([[ -d "$CACHE/9.9.7" ]] && echo kept || echo PRUNED) old=$([[ -d "$CACHE/$OLD_VERSION" ]] && echo kept || echo pruned) out=$OUT"
fi

# ── StandaloneSync_SecondRun_Idempotent ─────────────────────────────────────
# A re-run against an already-synced HOME succeeds without re-fetching.
run_sut --no-push
if [[ $RC -eq 0 ]] && printf '%s\n' "$OUT" | grep -q "Cache already populated"; then
  pass "StandaloneSync_SecondRun_Idempotent: re-run is a no-op fetch-wise and exits 0"
else
  fail "StandaloneSync_SecondRun_Idempotent" "rc=$RC out=$OUT"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Test Summary ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "Tests failed!"
  exit 1
fi
echo "All tests passed!"
exit 0
