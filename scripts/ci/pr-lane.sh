#!/usr/bin/env bash
#
# Runs one suite of the Buildkite pull request lane on the tested merge.
#
# Usage: scripts/ci/pr-lane.sh <static|tests>
#
# The script checks that the image matches the toolchain pins. It selects the
# lane mode from the diff against the first parent of the tested merge. It
# installs from the lockfile with no package scripts, then runs
# `npm run ci:pr:<suite>` offline. tools/ci/pr-lane.mjs owns what each suite runs.
#
# The private packages in scripts/ci/npm-pins.json come from a directory in
# EXARCHOS_STAGED_NPM, or else from the npm/ artifacts of the admission build
# that triggered this build. This build holds no registry credential.
set -euo pipefail

suite="${1:-}"
case "$suite" in
  static | tests) ;;
  *)
    echo "usage: scripts/ci/pr-lane.sh <static|tests>" >&2
    exit 2
    ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

pins=scripts/ci/npm-pins.json
node_major=22
private_registry=https://npm.pkg.github.com/
npm_route='^https://npm\.pkg\.github\.com/download/@lvlup-sw/(strategos-contracts)/([0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?)/[0-9a-f]{40}$'
integrity_shape='^sha512-[A-Za-z0-9+/]{86}==$'

fail() {
  echo "pr-lane: $*" >&2
  exit 1
}

phase() {
  echo "--- :npm: $*"
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

phase "Checking the candidate"
shopt -s nullglob
local_env=(.env*)
shopt -u nullglob
if ((${#local_env[@]} > 0)); then
  fail "the candidate contains a local environment file: ${local_env[*]}"
fi

if [[ -L .bun-version || ! -f .bun-version ]] || (($(wc -c <.bun-version) > 64)); then
  fail ".bun-version is unavailable"
fi
bun_pin="$(tr -d '[:space:]' <.bun-version)"
if [[ ! "$bun_pin" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || "$(bun --version)" != "$bun_pin" ]]; then
  fail ".bun-version differs from the Bun in the CI image. Publish a new image and bump it in .buildkite/pipeline.yml first"
fi
if [[ ! "$(node --version)" =~ ^v${node_major}\.[0-9]+\.[0-9]+$ ]]; then
  fail "the Node major of the CI image is not ${node_major}"
fi
node_prefix="$(dirname "$(dirname "$(realpath "$(command -v node)")")")"
if [[ ! -f "$node_prefix/include/node/node.h" ]]; then
  fail "the CI image has no Node headers for the native rebuild"
fi

phase "Selecting the lane mode"
parents="$(git --no-replace-objects cat-file -p HEAD | sed -n '1,/^$/s/^parent //p')"
base="${parents%%$'\n'*}"
if [[ ! "$base" =~ ^[0-9a-f]{40}$ ]]; then
  fail "the tested merge has no parent commit"
fi
if [[ "$suite" == tests && "$(git rev-parse --is-shallow-repository)" == true ]]; then
  git fetch --quiet --unshallow --tags origin
fi
if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  git fetch --quiet --depth=1 origin "$base"
fi
git --no-replace-objects diff --name-only -z --no-renames "$base" HEAD >"$work/changed"
mode=selected
while IFS= read -r -d '' path; do
  case "$path" in
    package-lock.json | package.json | .npmrc | .bun-version | vitest.config.* | tsconfig*.json | */tsconfig*.json | tests/helpers/* | tools/ci/*)
      mode=full
      ;;
  esac
done <"$work/changed"
echo "base ${base}, mode ${mode}"

phase "Checking the private package pins"
jq -e 'type == "object" and length >= 1 and length <= 4' "$pins" >/dev/null || fail "$pins is not a catalog of one to four pins"
jq -r 'to_entries[] | [.key, .value] | @tsv' "$pins" >"$work/pins"
while IFS=$'\t' read -r url integrity; do
  [[ "$url" =~ $npm_route ]] || fail "pin ${url} is outside the enrolled package route"
  [[ "$integrity" =~ $integrity_shape ]] || fail "pin ${url} has no sha512 integrity"
done <"$work/pins"

if [[ -L package-lock.json || ! -f package-lock.json ]]; then
  fail "package-lock.json is unavailable"
fi
jq -r --arg registry "$private_registry" --slurpfile pins "$pins" '
  .packages | to_entries[] | .value | objects
  | select((.resolved | type) == "string" and (.resolved | startswith($registry)))
  | [.resolved, (.integrity // ""), ($pins[0][.resolved] // "")] | @tsv' package-lock.json >"$work/private"
while IFS=$'\t' read -r url integrity pinned; do
  if [[ -z "$pinned" || "$pinned" != "$integrity" ]]; then
    fail "lockfile entry ${url} differs from ${pins}. Merge its pin first, then the lockfile change"
  fi
  [[ "$url" =~ $npm_route ]]
  echo "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}.tgz $integrity"
done <"$work/private" | sort -u >"$work/used"

tarballs=()
if [[ -s "$work/used" ]]; then
  staged="${EXARCHOS_STAGED_NPM:-}"
  if [[ -z "$staged" ]]; then
    [[ -n "${BUILDKITE_TRIGGERED_FROM_BUILD_ID:-}" ]] || fail "set EXARCHOS_STAGED_NPM to a directory that holds the packages in ${pins}"
    mkdir "$work/staged"
    (cd "$work/staged" && buildkite-agent artifact download 'npm/*.tgz' . --build "$BUILDKITE_TRIGGERED_FROM_BUILD_ID")
    staged="$work/staged/npm"
  fi
  while read -r file integrity; do
    tarball="$staged/$file"
    [[ -f "$tarball" && ! -L "$tarball" ]] || fail "pinned private package ${file} was not staged"
    digest="$(node -e 'const fs = require("fs"); const crypto = require("crypto"); process.stdout.write("sha512-" + crypto.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"))' "$tarball")"
    [[ "$digest" == "$integrity" ]] || fail "staged private package ${file} differs from its pin"
    tarballs+=("$tarball")
  done <"$work/used"
fi

export CI=true DO_NOT_TRACK=1
export npm_config_cache="$work/npm-cache" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
if ((${#tarballs[@]} > 0)); then
  phase "Staging the private packages"
  npm cache add "${tarballs[@]}"
fi
phase "Installing"
npm ci --ignore-scripts
phase "Rebuilding better-sqlite3"
npm_config_build_from_source=true npm_config_nodedir="$node_prefix" npm rebuild better-sqlite3

phase "Running ci:pr:${suite} --mode ${mode}"
unset https_proxy HTTPS_PROXY http_proxy HTTP_PROXY no_proxy NO_PROXY npm_config_proxy npm_config_https_proxy
export npm_config_offline=true
status=0
npm run "ci:pr:${suite}" -- --base "$base" --mode "$mode" --summary "$work/exarchos-summary.json" || status=$?
if [[ -f "$work/exarchos-summary.json" ]] && command -v buildkite-agent >/dev/null; then
  (cd "$work" && buildkite-agent artifact upload exarchos-summary.json)
fi
exit "$status"
