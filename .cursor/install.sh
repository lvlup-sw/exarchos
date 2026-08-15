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

echo "==> Exarchos install: node $(node --version), npm $(npm --version)"

# 1. Bun — required by the build/codegen/binary scripts (bun build --compile,
#    scripts/codegen-runtimes.ts). Install only when missing or version-drifted.
if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version 2>/dev/null)" != "$BUN_VERSION" ]; then
  echo "==> Installing Bun ${BUN_VERSION}"
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
fi
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
# Expose bun on the global PATH so every later phase / agent shell sees it even
# when it does not source ~/.bashrc. Symlink is safe to recreate.
sudo ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun
echo "==> bun $(bun --version) on PATH at $(command -v bun)"

# 2. Dependencies — root workspace + the MCP server workspace. `npm ci` is
#    deterministic/idempotent (it wipes and rebuilds node_modules from the
#    lockfile). The retry wrapper survives transient registry/CDN stalls, and
#    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD avoids the eval-only chromium download.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
echo "==> Installing root dependencies"
bash scripts/npm-ci-retry.sh
echo "==> Installing servers/exarchos-mcp dependencies"
( cd servers/exarchos-mcp && bash "$REPO_ROOT/scripts/npm-ci-retry.sh" )

# 3. Compile the host CLI + MCP server into a single binary and expose it on
#    PATH. This makes `exarchos` usable immediately and lets the process-fidelity
#    suite (`npm run test:process`) resolve the binary. The output is a durable
#    file, appropriate for the install phase.
echo "==> Building host binary (linux-x64)"
bun run scripts/build-binary.ts --target linux-x64
sudo ln -sf "$REPO_ROOT/dist/bin/exarchos-linux-x64" /usr/local/bin/exarchos
echo "==> exarchos $(exarchos --version) on PATH at $(command -v exarchos)"

echo "==> Exarchos install complete"
