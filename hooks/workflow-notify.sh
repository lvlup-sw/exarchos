#!/bin/bash
# workflow-notify.sh
# Called by workflow-state.sh when workflow state changes
# Sends events to the Workflow Gateway for mobile/PWA notifications
#
# Usage: workflow-notify.sh <state-file> <event>
#
# Events:
#   phase-change      - Workflow moved to new phase
#   task-update       - Task status changed
#   approval-needed   - Human checkpoint reached
#   workflow-complete - Workflow finished
#
# Configuration:
#   WORKFLOW_GATEWAY_URL   - Gateway API URL (default: https://gateway.home.arpa)
#   WORKFLOW_GATEWAY_TOKEN - JWT token for authentication
#
# Or create ~/.config/workflow-gateway/config with these variables

set -euo pipefail

STATE_FILE="${1:-}"
EVENT="${2:-}"

if [[ -z "$STATE_FILE" ]] || [[ -z "$EVENT" ]]; then
    echo "Usage: workflow-notify.sh <state-file> <event>" >&2
    exit 1
fi

# Configuration
GATEWAY_URL="${WORKFLOW_GATEWAY_URL:-https://gateway.home.arpa}"
GATEWAY_TOKEN="${WORKFLOW_GATEWAY_TOKEN:-}"

# Try loading from config file if token not set
if [[ -z "$GATEWAY_TOKEN" ]]; then
    CONFIG_FILE="${HOME}/.config/workflow-gateway/config"
    if [[ -f "$CONFIG_FILE" ]]; then
        # shellcheck source=/dev/null
        source "$CONFIG_FILE"
    fi
fi

# Exit silently if no token configured (mobile integration not set up)
if [[ -z "$GATEWAY_TOKEN" ]]; then
    exit 0
fi

# Verify state file exists
if [[ ! -f "$STATE_FILE" ]]; then
    echo "Warning: State file does not exist: $STATE_FILE" >&2
    exit 0
fi

# Extract workflow info from state file
WORKFLOW_ID=$(jq -r '.id // empty' "$STATE_FILE" 2>/dev/null || echo "")
PHASE=$(jq -r '.phase // empty' "$STATE_FILE" 2>/dev/null || echo "")
FEATURE=$(jq -r '.feature // .id // "unknown"' "$STATE_FILE" 2>/dev/null || echo "unknown")

if [[ -z "$WORKFLOW_ID" ]]; then
    echo "Warning: Could not extract workflow ID from state file" >&2
    exit 0
fi

# Build event payload
PAYLOAD=$(jq -n \
    --arg workflowId "$WORKFLOW_ID" \
    --arg event "$EVENT" \
    --arg phase "$PHASE" \
    --arg feature "$FEATURE" \
    --arg stateFile "$STATE_FILE" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
        workflowId: $workflowId,
        event: $event,
        phase: $phase,
        feature: $feature,
        stateFile: $stateFile,
        timestamp: $timestamp
    }')

# Send event to Gateway (async, don't block workflow)
curl -s -X POST "${GATEWAY_URL}/api/v1/events" \
    -H "Authorization: Bearer ${GATEWAY_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    --connect-timeout 5 \
    --max-time 10 \
    >/dev/null 2>&1 || {
        # Log failure but don't exit with error (non-blocking)
        echo "Warning: Failed to send event to Gateway at ${GATEWAY_URL}" >&2
    }
