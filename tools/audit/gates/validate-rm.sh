#!/usr/bin/env bash
# Validates rm commands - blocks those targeting outside current directory
# Exit 0 = allow, Exit 2 = block with message to stderr

set -euo pipefail

# Read tool input from stdin
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# If not an rm command, allow it
if [[ ! "$COMMAND" =~ ^[[:space:]]*(rm|/bin/rm|/usr/bin/rm)[[:space:]] ]]; then
  exit 0
fi

# Extract the working directory
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
[[ -z "$CWD" ]] && CWD="$PWD"

# Function to check if a path is inside CWD
is_inside_cwd() {
  local target="$1"
  local resolved

  # Handle relative paths
  if [[ "$target" != /* ]]; then
    target="$CWD/$target"
  fi

  # Resolve to absolute path (handle .., symlinks, etc)
  # Use realpath if target exists, otherwise normalize manually
  if [[ -e "$target" ]]; then
    resolved=$(realpath "$target" 2>/dev/null) || resolved="$target"
  else
    # For non-existent paths, normalize parent + basename
    local parent=$(dirname "$target")
    local base=$(basename "$target")
    if [[ -d "$parent" ]]; then
      resolved="$(realpath "$parent")/$base"
    else
      resolved="$target"
    fi
  fi

  # Check if resolved path starts with CWD
  local resolved_cwd
  resolved_cwd=$(realpath "$CWD" 2>/dev/null) || resolved_cwd="$CWD"

  [[ "$resolved" == "$resolved_cwd" || "$resolved" == "$resolved_cwd"/* ]]
}

# Quick sanity check for obviously catastrophic commands
# The path resolution below handles the full check
NORMALIZED_CMD=$(echo "$COMMAND" | tr -s ' ')
if [[ "$NORMALIZED_CMD" =~ rm[[:space:]]+-[rRf]*[[:space:]]+/[[:space:]]*$ ]] || \
   [[ "$NORMALIZED_CMD" =~ rm[[:space:]]+-[rRf]*[[:space:]]+/\*[[:space:]]*$ ]]; then
  echo "BLOCKED: rm targeting filesystem root" >&2
  exit 2
fi

# Parse rm arguments to find target paths
# Strip rm command and flags, get remaining arguments
TARGETS=$(echo "$COMMAND" | sed -E 's/^[[:space:]]*(rm|\/bin\/rm|\/usr\/bin\/rm)[[:space:]]+//' | \
  sed -E 's/-[rRfivI]+[[:space:]]*//g' | \
  sed -E 's/--[a-z-]+[[:space:]]*//g' | \
  xargs -n1 2>/dev/null || true)

# If no targets found, allow (rm with no args will fail anyway)
[[ -z "$TARGETS" ]] && exit 0

# Check each target
BLOCKED_PATHS=()
while IFS= read -r target; do
  [[ -z "$target" ]] && continue

  # Skip if target contains unexpanded variables (could be dangerous)
  if [[ "$target" == *'$'* ]]; then
    BLOCKED_PATHS+=("$target (contains unexpanded variable)")
    continue
  fi

  if ! is_inside_cwd "$target"; then
    BLOCKED_PATHS+=("$target")
  fi
done <<< "$TARGETS"

if [[ -n "${BLOCKED_PATHS+x}" ]] && [[ ${#BLOCKED_PATHS[@]} -gt 0 ]]; then
  echo "BLOCKED: rm targets paths outside current directory ($CWD):" >&2
  printf "  - %s\n" "${BLOCKED_PATHS[@]}" >&2
  exit 2
fi

exit 0
