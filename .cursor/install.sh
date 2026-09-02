#!/usr/bin/env bash
#
# Cloud Agent install phase for Exarchos.
#
# Idempotent repository bootstrap: it may run repeatedly and against cached or
# partially-prepared state, so every step is safe to re-run. It installs the one
# toolchain the default base image lacks (Bun), refreshes both npm workspaces,
# and compiles the host CLI so `exarchos` is on PATH out of the box.
#
# Node (>= 20; the base image ships Node 22 via nvm) and the C/C++ toolchain
# that better-sqlite3 needs (gcc/g++/make/python3) already come from the base
# image, so they are asserted rather than installed here.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Pinned to match CI (.github/workflows/ci.yml: oven-sh/setup-bun bun-version).
BUN_VERSION="1.3.13"
# sha256 of bun-linux-x64.zip from that release's published SHASUMS256.txt.
#
# Pinned HERE rather than fetched next to the artifact. A checksum file pulled
# from the same origin as the download is signed by nothing this script trusts,
# so it would confirm that the bytes arrived intact, not that they are the bytes
# we meant to run. Bumping BUN_VERSION means bumping this line with it.
BUN_SHA256="79c0771fa8b92c33aae41e15a0e0d307ea99d0e2f00317c71c6c53237a78e25a"

echo "==> Exarchos install: node $(node --version), npm $(npm --version)"

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

# Verify, then execute — never the other way round. The upstream one-liner pipes
# a fetched script straight into a shell, which runs whatever the network hands
# back; here the release artifact is downloaded to disk, checked against the
# pinned digest, and only unpacked once it matches.
install_bun() {
  local arch
  arch="$(uname -m)"
  if [ "$arch" != "x86_64" ]; then
    echo "install.sh: the pinned Bun build is linux-x64; this host reports ${arch}." >&2
    echo "            Add that platform's artifact and digest before running here." >&2
    return 1
  fi
  for tool in curl unzip sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || {
      echo "install.sh: ${tool} is required to install Bun and is not on PATH." >&2
      return 1
    }
  done

  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now: the trap must not depend on
  # a variable a later step could reassign.
  trap "rm -rf '$tmp'" EXIT

  local url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
  echo "==> Downloading Bun ${BUN_VERSION}"
  curl -fsSL --retry 3 --retry-delay 2 -o "$tmp/bun.zip" "$url"

  # Fails closed: a mismatch aborts before a single downloaded byte is executed.
  if ! printf '%s  %s\n' "$BUN_SHA256" "$tmp/bun.zip" | sha256sum --check --status; then
    echo "install.sh: Bun ${BUN_VERSION} failed its pinned sha256 — refusing to install." >&2
    echo "            expected ${BUN_SHA256}" >&2
    echo "            actual   $(sha256sum "$tmp/bun.zip" | cut -d' ' -f1)" >&2
    return 1
  fi

  unzip -q -o "$tmp/bun.zip" -d "$tmp"
  mkdir -p "$BUN_INSTALL/bin"
  install -m 0755 "$tmp/bun-linux-x64/bun" "$BUN_INSTALL/bin/bun"
  rm -rf "$tmp"
  trap - EXIT
}

# 1. Bun — required by the build/codegen/binary scripts (bun build --compile,
#    tools/release/codegen-runtimes.ts). Install only when missing or drifted.
if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version 2>/dev/null)" != "$BUN_VERSION" ]; then
  echo "==> Installing Bun ${BUN_VERSION}"
  install_bun
fi

# Expose bun on the global PATH so every later phase / agent shell sees it even
# when it does not source ~/.bashrc. Resolve the binary that is actually on
# PATH rather than assuming it sits under BUN_INSTALL — the base image may
# already ship one elsewhere, and linking a path that does not exist would
# leave a dangling symlink that shadows the working one.
BUN_BIN="$(command -v bun)"
if [ "$BUN_BIN" != "/usr/local/bin/bun" ]; then
  sudo ln -sf "$BUN_BIN" /usr/local/bin/bun
fi
echo "==> bun $(bun --version) on PATH at $(command -v bun)"

# 2. Dependencies — root workspace + the MCP server workspace. `npm ci` is
#    deterministic/idempotent (it wipes and rebuilds node_modules from the
#    lockfile). The retry wrapper survives transient registry/CDN stalls, and
#    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD avoids the eval-only chromium download.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
echo "==> Installing root dependencies"
bash tools/release/npm-ci-retry.sh
echo "==> Installing servers/exarchos-mcp dependencies"
( cd servers/exarchos-mcp && bash "$REPO_ROOT/tools/release/npm-ci-retry.sh" )

# 3. Compile the host CLI + MCP server into a single binary and expose it on
#    PATH. This makes `exarchos` usable immediately and lets the process-fidelity
#    suite (`npm run test:process`) resolve the binary. The output is a durable
#    file, appropriate for the install phase.
echo "==> Building host binary (linux-x64)"
bun run tools/release/build-binary.ts --target linux-x64
sudo ln -sf "$REPO_ROOT/dist/bin/exarchos-linux-x64" /usr/local/bin/exarchos
echo "==> exarchos $(exarchos --version) on PATH at $(command -v exarchos)"

echo "==> Exarchos install complete"
