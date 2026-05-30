#!/usr/bin/env bash
#
# Retry `npm ci` with a per-attempt timeout to survive transient registry/CDN
# stalls on CI runners.
#
# Background: `servers/exarchos-mcp` pulls a heavy dependency tree (notably the
# eval-only `promptfoo`, plus native prebuilds like `better-sqlite3` whose
# binaries download from GitHub Releases — outside the npm cache). A single
# network hiccup made a plain `npm ci` hang silently until the job's 15-minute
# wall-clock timeout, killing the whole run with no retry. This wrapper kills a
# stalled attempt early and retries, so a transient stall costs ~one timeout
# window instead of the entire job. See RCA
# docs/rca/2026-05-30-state-source-integrity.md.
#
# Any arguments are forwarded verbatim to `npm ci` (e.g. `--omit=dev`).
# Tunable via env: NPM_CI_ATTEMPTS (default 3), NPM_CI_TIMEOUT_SECONDS (default 300).
set -uo pipefail

attempts="${NPM_CI_ATTEMPTS:-3}"
timeout_s="${NPM_CI_TIMEOUT_SECONDS:-300}"

for i in $(seq 1 "$attempts"); do
  echo "==> npm ci attempt ${i}/${attempts} (timeout ${timeout_s}s): npm ci $*"
  if timeout "${timeout_s}" npm ci "$@"; then
    exit 0
  fi
  echo "==> npm ci attempt ${i}/${attempts} stalled or failed; retrying in 5s..." >&2
  sleep 5
done

echo "==> npm ci failed after ${attempts} attempts" >&2
exit 1
