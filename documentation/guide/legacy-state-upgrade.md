# Upgrade legacy workflow state

Exarchos v2.10.0 and later require SQLite-backed workflow state. If your state directory was created by a pre-v2.9.0 JSONL-only release and was never opened by a v2.9.x runtime, v2.10.0+ cannot safely import it on startup.

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

## Version boundaries

| Purpose | Version range |
|---------|---------------|
| Legacy JSONL-only state that needs this guide | Created before v2.9.0, or any state directory with `*.events.jsonl` files and no `exarchos.db` or `events.db` |
| Bridge runtime | v2.9.x only; the examples use v2.9.0 |
| Target runtime after the bridge | v2.10.0 or later |

Do not use v2.10.0 or later as the bridge runtime. Those versions expect SQLite state to already exist.

## Choose a path

Most users should let their local coding agent do the migration. The agent can inspect your actual state path, avoid overwriting an existing migrated copy, and report exactly what it changed.

If you would rather do it yourself, use the shorter terminal flow below the prompt. Both paths do the same thing: preserve the original JSONL state directory, bridge a copy through v2.9.x, then verify that the copy works with v2.10.0 or later.

## Option 1: Ask an agent

If you want a local coding agent to perform the migration for you, copy this prompt into that agent. Replace the paths or target version first if your setup differs.

```text
Migrate my legacy Exarchos workflow state safely.

Context:
- Exarchos v2.10.0 and later require SQLite-backed workflow state.
- My current/old state directory may be JSONL-only: it may contain *.events.jsonl files but no exarchos.db or events.db.
- Use v2.9.x as the bridge runtime. Do not use v2.10.0 or later as the bridge.
- Preserve the original state directory unchanged.

Please do this:
1. Confirm there are no running Claude Code, Codex, opencode, Cursor, or other Exarchos MCP sessions using the state directory. If you cannot confirm that, stop and tell me what to close.
2. Identify the current Exarchos state directory. Prefer WORKFLOW_STATE_DIR if it is set; otherwise check the common path ~/.claude/workflow-state. If the directory does not contain *.events.jsonl files, tell me what you found before continuing.
3. Create a migrated copy at ~/.claude/workflow-state-v211, or choose a timestamped sibling if that path already exists. Do not modify or delete the original directory.
4. Install a temporary v2.9.x Exarchos binary into ~/.local/exarchos-2.9.0 without replacing my current exarchos on PATH.
5. Run the temporary v2.9.x binary with WORKFLOW_STATE_DIR pointing at the copied state directory, using `doctor` to hydrate legacy JSONL workflow events into exarchos.db.
6. Verify the copied state directory now contains exarchos.db.
7. Install or use my target Exarchos v2.10.0+ runtime, then run `exarchos doctor` with WORKFLOW_STATE_DIR pointing at the migrated copy.
8. Verify at least one known workflow with `exarchos workflow get --feature-id <feature-id>` if a feature id is available; otherwise report how I should run /exarchos:rehydrate after restart.
9. Tell me the original state path, migrated state path, bridge binary path, target Exarchos version, and every command you ran. Do not switch my agent config to the migrated state path unless I explicitly approve that final step.
```

## Option 2: Run it yourself

Close Claude Code, Codex, opencode, Cursor, and any other agent session using Exarchos before you start.

The commands below use the common Claude Code state path. Run them in the same terminal so the path variables stay set. If your install uses a different state directory, change `STATE` before running the rest.

```bash
STATE=~/.claude/workflow-state
MIGRATED=~/.claude/workflow-state-v211
BRIDGE=~/.local/exarchos-2.9.0
```

Copy the old state directory. Do not run the bridge against your only copy.

```bash
cp -a "$STATE" "$MIGRATED"
```

Install the v2.9.0 bridge binary and run it once against the copied state. This does not replace your current `exarchos` on PATH.

```bash
mkdir -p "$BRIDGE"
curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh \
  | EXARCHOS_INSTALL_DIR="$BRIDGE" bash -s -- --version v2.9.0

WORKFLOW_STATE_DIR="$MIGRATED" "$BRIDGE/exarchos" doctor
ls "$MIGRATED/exarchos.db"
```

If the temporary install fails because the `v2.9.0` tag is unavailable in your environment, use the newest available v2.9.x tag and run the same `doctor` command against the copied state directory.

Install or use your target v2.10.0+ runtime, then verify the migrated copy. This example installs v2.11.0-preview.4:

```bash
curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh | bash -s -- --version v2.11.0-preview.4

WORKFLOW_STATE_DIR="$MIGRATED" exarchos doctor
```

If you know a workflow id, verify it directly:

```bash
WORKFLOW_STATE_DIR="$MIGRATED" exarchos workflow get --feature-id <feature-id>
```

Inside Claude Code, restart the session and run:

```text
/exarchos:rehydrate
```

If the workflow appears in the pipeline view and `rehydrate` can load it, the migration copy is ready.

## Switch agents to the migrated copy

After either path succeeds, update the MCP server configuration or plugin environment so `WORKFLOW_STATE_DIR` points at the migrated copy:

```bash
export WORKFLOW_STATE_DIR="$MIGRATED"
```

For Claude Code plugin users, restart Claude Code after updating the plugin or environment. For Codex, Cursor, opencode, or another MCP client, update the client config that launches `exarchos mcp` and restart the client.

Keep the original JSONL directory until you have completed at least one successful rehydrate and one normal workflow operation on your target v2.10.0+ release.

## Troubleshooting

If v2.10.0 or later still reports a legacy JSONL directory, the bridge ran against the wrong path or did not create `exarchos.db`. Re-check `WORKFLOW_STATE_DIR` and rerun the v2.9.0 `doctor` command against the copied directory.

If `doctor` reports SQLite lock or busy errors, another agent process still has the state directory open. Close all agents and rerun the command.

If a workflow is missing after migration, confirm the copied directory contains the matching `<featureId>.events.jsonl` file before the bridge run. The bridge can only import workflow events that were present in the copied state directory.
