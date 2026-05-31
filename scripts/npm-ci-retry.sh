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
#
# Tunables (env):
#   NPM_CI_ATTEMPTS            attempts before giving up        (default 3)
#   NPM_CI_TIMEOUT_SECONDS     SIGTERM deadline per attempt     (default 300)
#   NPM_CI_KILL_AFTER_SECONDS  SIGKILL grace after SIGTERM      (default 30)
#   NPM_CI_RETRY_SLEEP_SECONDS pause between attempts           (default 5)
set -uo pipefail

attempts="${NPM_CI_ATTEMPTS:-3}"
timeout_s="${NPM_CI_TIMEOUT_SECONDS:-300}"
kill_after_s="${NPM_CI_KILL_AFTER_SECONDS:-30}"
retry_sleep_s="${NPM_CI_RETRY_SLEEP_SECONDS:-5}"

# Skip the Playwright browser download by default. `promptfoo` (an eval-only
# devDependency) pulls the optional `@playwright/browser-chromium`, whose
# postinstall fetches a ~150MB Chromium from the Playwright CDN — uncached, and
# the actual cause of the silent 300s `npm ci` wedge on cold CI runners (the
# hosted `ubuntu-24.04` image is "not officially supported" by Playwright, so it
# downloads an even slower fallback build). `npm_config_build_from_source` does
# NOT cover this — that only governs prebuild-install (better-sqlite3). No job
# that runs `npm ci` here drives a browser, so skip it. A job that genuinely
# needs browsers opts back in with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0`.
# See RCA docs/rca/2026-05-31-npm-ci-playwright-browser-wedge.md.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-1}"

for i in $(seq 1 "$attempts"); do
  echo "==> npm ci attempt ${i}/${attempts} (timeout ${timeout_s}s, kill-after ${kill_after_s}s): npm ci $*"
  # `-k`: `timeout` sends SIGTERM at ${timeout_s}; if `npm ci` — or a child it
  # spawned (node-gyp / prebuild-install) — ignores SIGTERM, escalate to
  # SIGKILL after a ${kill_after_s} grace so a wedged install can never outlive
  # the window (a plain `timeout` would itself block waiting on the ignorer).
  if timeout -k "${kill_after_s}s" "${timeout_s}" npm ci "$@"; then
    exit 0
  fi
  # Only pause+retry between attempts — never sleep after the final one.
  if [ "${i}" -lt "${attempts}" ]; then
    echo "==> npm ci attempt ${i}/${attempts} stalled or failed; retrying in ${retry_sleep_s}s..." >&2
    sleep "${retry_sleep_s}"
  fi
done

echo "==> npm ci failed after ${attempts} attempts" >&2
exit 1
