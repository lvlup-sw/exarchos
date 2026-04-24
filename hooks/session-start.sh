#!/bin/sh
# SessionStart hook: guard against a missing exarchos binary.
#
# If `exarchos` is on PATH, exec the real subcommand (process replacement —
# Claude Code observes the hook's exit status from exarchos itself).
#
# If `exarchos` is missing, print a one-line install hint to stderr and exit
# 0 so Claude Code does not error-prompt the user. The hook is non-blocking:
# a fresh plugin install without the binary should boot cleanly, surfacing
# the install link once per session.
set -eu

INSTALL_URL="https://raw.githubusercontent.com/lvlup-sw/exarchos/main/scripts/get-exarchos.sh"

if ! command -v exarchos >/dev/null 2>&1; then
  printf 'exarchos binary not found on PATH. Install via:\n  curl -fsSL %s | bash\n' "$INSTALL_URL" >&2
  exit 0
fi

exec exarchos session-start --plugin-root "${CLAUDE_PLUGIN_ROOT:-}"
