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

If you would rather do it yourself, use the shorter terminal flow below the prompt. Both paths do the same thing: preserve the original JSONL state directory as a backup, bridge a copy through v2.9.x, put the migrated copy back at the original state path, then verify that the default path works with v2.10.0 or later.

## Option 1: Ask an agent

If you want a local coding agent to perform the migration for you, copy this prompt into that agent. Replace the paths or target version first if your setup differs.

```text
Please migrate my legacy Exarchos workflow state safely.

Context:
- Exarchos v2.10.0 and later require SQLite-backed workflow state.
- A legacy state directory may contain `*.events.jsonl` files but no `exarchos.db` or `events.db`.
- Use v2.9.x as the bridge runtime. Do not use v2.10.0 or later as the bridge.
- Preserve the original state directory as a backup. Run the bridge only on a copied state directory, then put the migrated copy back at the original state path so no new WORKFLOW_STATE_DIR override is needed.

Steps:
1. Make sure Claude Code, Codex, opencode, Cursor, and any other Exarchos MCP clients are closed. If you cannot confirm that, stop and tell me what to close.
2. Find the current Exarchos state directory. Prefer `WORKFLOW_STATE_DIR` if it is set; otherwise check `~/.claude/workflow-state`.
3. Inspect the state directory. If it does not contain `*.events.jsonl`, or if it already contains `exarchos.db` or `events.db`, pause and tell me what you found before migrating anything.
4. Copy the state directory to `~/.claude/workflow-state-v211`. If that path already exists, create a timestamped sibling instead. Do not run the bridge against the original directory.
5. Install a temporary v2.9.x Exarchos binary into `~/.local/exarchos-2.9.0` without replacing the `exarchos` currently on PATH.
6. Run the temporary v2.9.x binary with `WORKFLOW_STATE_DIR` pointed at the copied state directory, using `doctor` to hydrate the legacy JSONL events into `exarchos.db`.
7. Verify the copied state directory now contains `exarchos.db`.
8. Move the original state directory to a timestamped backup path, then move the migrated copy back to the original state path. Do not leave my agent configured to a new migrated-only path.
9. Use the target Exarchos v2.10.0+ runtime, then run `exarchos doctor` normally, without a special `WORKFLOW_STATE_DIR` override.
10. If a workflow id is available, verify it with `exarchos workflow get --feature-id <feature-id>`. If no workflow id is available, tell me to restart my agent and run `/exarchos:rehydrate`.
11. Report the original state path, backup path, temporary migrated path, bridge binary path, target Exarchos version, and every command you ran.
```

## Option 2: Run it yourself

Close Claude Code, Codex, opencode, Cursor, and any other agent session using Exarchos before you start.

The commands below use the common Claude Code state path. Run them in the same terminal so the path variables stay set. If your install uses a different state directory, change `STATE` before running the rest.

```bash
STATE=~/.claude/workflow-state
MIGRATED=~/.claude/workflow-state-v211
BACKUP=~/.claude/workflow-state-jsonl-backup-$(date +%Y%m%d-%H%M%S)
BRIDGE=~/.local/exarchos-2.9.0
```

Copy the old state directory. Do not run the bridge against the original.

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

Put the migrated state back at the original path and keep the JSONL directory as a timestamped backup:

```bash
mv "$STATE" "$BACKUP"
mv "$MIGRATED" "$STATE"
```

Install or use your target v2.10.0+ runtime, then verify the default state path. This example installs v2.11.0-preview.4:

```bash
curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh | bash -s -- --version v2.11.0-preview.4

exarchos doctor
```

If you know a workflow id, verify it directly:

```bash
exarchos workflow get --feature-id <feature-id>
```

Inside Claude Code, restart the session and run:

```text
/exarchos:rehydrate
```

If the workflow appears in the pipeline view and `rehydrate` can load it, the default state path is ready.

## Restart agents

After either path succeeds, restart Claude Code, Codex, opencode, Cursor, or whichever MCP client launches `exarchos mcp`. Because the migrated state was moved back to the original state path, you should not need a new `WORKFLOW_STATE_DIR` override.

Keep the timestamped JSONL backup until you have completed at least one successful rehydrate and one normal workflow operation on your target v2.10.0+ release.

## Troubleshooting

If v2.10.0 or later still reports a legacy JSONL directory, the bridge ran against the wrong path or did not create `exarchos.db`. Re-check the migrated copy, rerun the v2.9.0 `doctor` command against it if needed, then move it back to the original state path again.

If `doctor` reports SQLite lock or busy errors, another agent process still has the state directory open. Close all agents and rerun the command.

If a workflow is missing after migration, confirm the copied directory contains the matching `<featureId>.events.jsonl` file before the bridge run. The bridge can only import workflow events that were present in the copied state directory.
