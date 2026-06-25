# Upgrade legacy workflow state

Exarchos v2.11 requires the SQLite event store. If your state directory was created by a JSONL-only release and was never opened by a SQLite-capable v2.9.x runtime, v2.11 refuses to start instead of guessing how to import old events.

This affects older installs with workflow state files such as:

```text
<state-dir>/<featureId>.events.jsonl
<state-dir>/<featureId>.state.json
```

and no SQLite database (`exarchos.db` or `events.db`) in the same directory.

## Symptom

The MCP server or `exarchos doctor` fails with a message like:

```text
Legacy v2.10 JSONL state directory detected
```

or an error that says the directory contains `*.events.jsonl` files without an event-store database.

Do not wipe the directory if you want to keep old workflows. Use the bridge path below.

## Before you start

1. Close Claude Code, Codex, opencode, and any other agent session using Exarchos.
2. Identify the state directory. If you set `WORKFLOW_STATE_DIR`, use that value. Claude Code plugin installs commonly use `~/.claude/workflow-state`; standalone and other harnesses may use `~/.exarchos/state`.
3. Work on a copy. Keep the original JSONL directory unchanged until you have verified the migrated copy.

## Bridge through v2.9.0

Install a temporary v2.9.0 binary into a scratch directory. This does not replace your current `exarchos` on PATH.

```bash
set -euo pipefail

OLD_STATE="${WORKFLOW_STATE_DIR:-$HOME/.claude/workflow-state}"
NEW_STATE="${OLD_STATE}-v211"
BRIDGE_BIN_DIR="$(mktemp -d)"

test ! -e "$NEW_STATE" || {
  echo "$NEW_STATE already exists; choose a new NEW_STATE path" >&2
  exit 1
}

cp -a "$OLD_STATE" "$NEW_STATE"

curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh \
  -o "$BRIDGE_BIN_DIR/get-exarchos.sh"

EXARCHOS_INSTALL_DIR="$BRIDGE_BIN_DIR" \
  bash "$BRIDGE_BIN_DIR/get-exarchos.sh" --version v2.9.0

WORKFLOW_STATE_DIR="$NEW_STATE" "$BRIDGE_BIN_DIR/exarchos" doctor
```

The v2.9.0 doctor run opens the copied state directory with the last runtime that still knows how to hydrate JSONL workflow events into SQLite. After it finishes, the copied directory should contain `exarchos.db`.

If the temporary install fails because the `v2.9.0` tag is unavailable in your environment, use the newest available v2.9.x tag and run the same `doctor` command against the copied state directory.

## Verify with v2.11

Install or update to v2.11, then run `doctor` against the migrated copy:

```bash
curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh | bash -s -- --version v2.11.0-preview.4

WORKFLOW_STATE_DIR="$NEW_STATE" exarchos doctor
```

Then verify one known workflow:

```bash
WORKFLOW_STATE_DIR="$NEW_STATE" exarchos workflow get --feature-id <feature-id>
```

Inside Claude Code, restart the session and run:

```text
/exarchos:rehydrate
```

If the workflow appears in the pipeline view and `rehydrate` can load it, the migration copy is ready.

## Switch agents to the migrated copy

Update the MCP server configuration or plugin environment so `WORKFLOW_STATE_DIR` points at the migrated copy:

```bash
export WORKFLOW_STATE_DIR="$HOME/.claude/workflow-state-v211"
```

For Claude Code plugin users, restart Claude Code after updating the plugin or environment. For Codex, Cursor, opencode, or another MCP client, update the client config that launches `exarchos mcp` and restart the client.

Keep the original JSONL directory until you have completed at least one successful rehydrate and one normal workflow operation on v2.11.

## Troubleshooting

If v2.11 still reports a legacy JSONL directory, the bridge ran against the wrong path or did not create `exarchos.db`. Re-check `WORKFLOW_STATE_DIR` and rerun the v2.9.0 `doctor` command against the copied directory.

If `doctor` reports SQLite lock or busy errors, another agent process still has the state directory open. Close all agents and rerun the command.

If a workflow is missing after migration, confirm the copied directory contains the matching `<featureId>.events.jsonl` file before the bridge run. The bridge can only import workflow events that were present in the copied state directory.
