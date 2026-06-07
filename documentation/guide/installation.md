# Install Exarchos

Exarchos installs in two layers. The **CLI** is a self-contained binary that bundles the MCP server, the workflow state machine, and the convergence-gate runner. The **Claude Code plugin** is content (commands, skills, hooks, rules) that wires the binary into your editor session via the marketplace. End users install both; library/CI consumers can stop after the CLI.

> The bootstrap installers fetch from the [GitHub Releases](https://github.com/lvlup-sw/exarchos/releases) page. The CLI has no Node, npm, or Bun runtime requirement on the target machine. The plugin runs inside Claude Code; no extra prerequisites beyond Claude Code itself.

## Install the CLI

::: code-group

```bash [macOS / Linux]
curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh | bash
```

```powershell [Windows]
irm https://lvlup-sw.github.io/exarchos/get-exarchos.ps1 | iex
```

:::

The installer drops a single ~98 MB binary at `~/.local/bin/exarchos` (Unix) or `%LOCALAPPDATA%\Microsoft\WindowsApps\exarchos.exe` (Windows), verifies a SHA-512 checksum against the release sidecar, and idempotently appends the install directory to your shell's PATH.

To target a specific tag — including a release candidate — pass `--version`:

```bash
curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh | bash -s -- --version v2.9.0-rc.1
```

Other modes: `--dry-run` prints the install plan without downloading, `--github-actions` writes the install dir to `$GITHUB_PATH` instead of mutating shell rc files, and `--tier <release|staging|dev>` selects a quality channel (default `release`; staging/dev are reserved for future use).

## Two-step installation

If `curl | bash` makes you nervous, download the script first and inspect it before running.

::: code-group

```bash [macOS / Linux]
# 1. Download
curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh -o get-exarchos.sh

# 2. Inspect
less get-exarchos.sh

# 3. Run
bash get-exarchos.sh
```

```powershell [Windows]
# 1. Download
irm https://lvlup-sw.github.io/exarchos/get-exarchos.ps1 -OutFile get-exarchos.ps1

# 2. Inspect
notepad get-exarchos.ps1

# 3. Run
.\get-exarchos.ps1
```

:::

Sample output from a successful Unix install:

```
[exarchos] downloading exarchos-linux-x64 v2.9.0-rc.1
[exarchos] sha512 checksum verified
[exarchos] installed to /home/you/.local/bin/exarchos
[exarchos] updated shell rc files (.bashrc, .zshrc, fish config) — open a new shell or source them
[exarchos] done — run 'exarchos --version' in a new shell to verify
```

Open a new terminal so the PATH update takes effect.

## Install the Claude Code plugin

The plugin layer is what makes `/exarchos:ideate`, `/exarchos:plan`, and the eight lifecycle hooks available inside Claude Code. It expects the CLI binary on PATH (the previous step).

```
/plugin marketplace add lvlup-sw/.github
/plugin install exarchos@lvlup-sw
```

The lvlup-sw marketplace is hosted at [lvlup-sw/.github](https://github.com/lvlup-sw/.github). Other plugins from the same marketplace:

```
/plugin install axiom@lvlup-sw
```

> **No SSH key configured for GitHub?** Use the explicit HTTPS URL: `/plugin marketplace add https://github.com/lvlup-sw/.github.git`

Restart Claude Code after the install so the new MCP server registration takes effect.

## Other harnesses (opencode, Codex, Cursor, Copilot, generic)

Exarchos is **additive to your harness choice** — the CLI binary is the same everywhere; only the skill/command wiring differs. Install the CLI (above), register the MCP server in your harness's config, then run `exarchos onboard` to detect runtimes + VCS, write/reconcile agent config, and install the skills. To target a specific runtime without detection, pass `exarchos onboard --runtime <runtime>`.

The MCP server always speaks **stdio** (`exarchos mcp`) — there is no port to configure on any runtime. Outside Claude Code the MCP tools surface under the bare prefix `mcp__exarchos__` (Claude Code wraps them in its plugin namespace, `mcp__plugin_exarchos_exarchos__`).

| Runtime | MCP transport | Onboard command | Skills destination | Canonical command names | Restart? |
|---|---|---|---|---|---|
| **Claude Code** | stdio (plugin) | (plugin, see above) | `~/.claude/skills` | native — `/exarchos:ideate`, `/exarchos:plan`, … | yes |
| **opencode** | stdio | `exarchos onboard --runtime opencode` | `~/.config/opencode/skills` | ✅ `/ideate`, `/plan`, … (installed to `~/.config/opencode/commands`) | yes |
| **Codex** | stdio | `exarchos onboard --runtime codex` | `$HOME/.agents/skills` | ⚠️ not emitted (see below) | yes (new session) |
| **Cursor** | stdio | `exarchos onboard --runtime cursor` | `~/.cursor/skills` | — (no custom slash commands) | yes |
| **Copilot CLI** | stdio | `exarchos onboard --runtime copilot` | `~/.copilot/skills` | ❌ not supported yet (see below) | yes |
| **generic** | stdio | `exarchos onboard --runtime generic` | `~/.agents/skills` | — (no custom slash commands) | n/a |

`onboard` prints the reconcile plan, the skills/commands destinations, and a restart hint when it finishes — so you don't have to memorize the paths above. It is idempotent; re-running reconciles drift only. If a step fails (e.g. an offline skills/deps install), `onboard` exits non-zero with a **forward-only** advisory: already-applied steps are kept (reconcile never rolls back), so fix the cause and **re-run** — it resumes from the residual diff. Use `exarchos doctor` to re-check without writing, or `exarchos doctor --fix` to re-apply just the remediable diff.

> **Renamed in v2.10.2:** the old `init`, `install-skills`, and `new-project` verbs were consolidated into `onboard` (use `onboard --new <name>` for greenfield). They survive one release as error stubs that print `renamed → use 'exarchos onboard'` and are removed at v3.0.

### Canonical workflow names across harnesses

Inside Claude Code the workflow is driven by canonical command names — `/exarchos:ideate`, `/exarchos:plan`, `/exarchos:delegate`, `/exarchos:review`, `/exarchos:synthesize`, `/exarchos:cleanup`, and so on. The underlying skills carry *descriptive* names (`brainstorming`, `implementation-planning`, `delegation`, …), so on harnesses that only see the skills, the names would otherwise differ.

To keep the names stable, Exarchos generates a thin **canonical-name command-alias layer** for harnesses whose command system can autoload it. Coverage today:

- **opencode** ✅ — `onboard --runtime opencode` writes `/ideate`, `/plan`, `/delegate`, … to `~/.config/opencode/commands/`, each delegating to the matching skill. So `/ideate` works the same way it does in Claude Code. (opencode autoloads markdown commands from that directory.)
- **Codex** ⚠️ — Codex's custom-prompt mechanism (`~/.codex/prompts/*.md`) is [deprecated in favor of skills](https://developers.openai.com/codex/custom-prompts) and invokes prompts namespaced as `/prompts:<name>`, not the bare `/ideate`. Exarchos therefore does **not** emit aliases for Codex; invoke the descriptive skill directly (e.g. the `brainstorming` skill for ideate).
- **Copilot CLI** ❌ — Copilot CLI does not yet autoload custom slash commands from a prompts directory (tracked upstream: [github/copilot-cli#618](https://github.com/github/copilot-cli/issues/618), [#1113](https://github.com/github/copilot-cli/issues/1113)). Aliases will be emitted once that lands.
- **Cursor / generic** — no custom-slash-command surface; the skill's descriptive name is the entry point.

On runtimes without the alias layer, note the **chaining caveat**: skill prose that says "invoke the `exarchos:plan` skill" refers to the canonical name; map it to the descriptive skill (`implementation-planning`) until aliases are available for that runtime.

### Harness binding (SessionStart orientation)

Exarchos soft-binds your harness to route SDLC through the `exarchos_*` tools via an
**observe-only orientation directive** (never enforcement; fail-open). The binding has
two vehicles — a **universal** always-loaded instructions block (works on every
harness) and, where the runtime supports context injection, an **active** SessionStart
hook that reinforces it and emits `session.started` telemetry:

| Runtime | Universal binding surface | Active lifecycle artifact |
|---|---|---|
| **Claude Code** | `CLAUDE.md` block | `SessionStart` + `SessionEnd` hooks (`hooks/hooks.json`) |
| **Codex** | `AGENTS.md` block | `SessionStart` hook (`additionalContext`); session-end deferred (`Stop` ≠ clean end) |
| **opencode** | `AGENTS.md` block | TS plugin (`session.created` telemetry); plugins cannot inject context, so binding is AGENTS.md-only |
| **Cursor** | `AGENTS.md` block | active `sessionStart` hook renderer — deferred (modeled) |
| **Copilot CLI** | `AGENTS.md` block | `sessionStart` cannot inject context — binding is AGENTS.md-only |
| **generic** | `AGENTS.md` block | none (no hook system) |

The generated blocks live under `binding/<runtime>/` (marker-fenced
`<!-- exarchos:binding:start/end -->`). **Installing this block into your project's
`AGENTS.md`/`CLAUDE.md` is wired into the `onboard` verb (v2.10.2)** — until then,
copy the block from `binding/<runtime>/` manually if you want the orientation directive
in a non-Claude project.

### Example: opencode

Register the MCP server in `~/.config/opencode/config.json` (stdio, no port):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "exarchos": {
      "type": "local",
      "enabled": true,
      "command": ["exarchos", "mcp"],
      "env": {
        "WORKFLOW_STATE_DIR": "/home/USER/.claude/workflow-state"
      }
    }
  }
}
```

Then onboard the project — this writes the skills (and the canonical aliases):

```bash
exarchos onboard --runtime opencode
```

Skills land in `~/.config/opencode/skills/`, aliases in `~/.config/opencode/commands/`. **Restart opencode** (or reload) afterward to pick them up. Do not copy Claude-only env such as `EXARCHOS_PLUGIN_ROOT` into the opencode config — it is meaningless outside the Claude plugin and only clutters the environment.

## Validation

```bash
exarchos --version
# 2.9.0-rc.1

exarchos doctor
# checks:
#   category: runtime          status: Pass    Node.js v24.x detected
#   category: storage          status: Pass    State dir present and writable
#   category: storage          status: Pass    sqlite integrity_check reports ok
```

If `exarchos --version` reports `command not found`, your shell hasn't picked up the PATH update — open a fresh terminal session, or `source ~/.bashrc` (or `~/.zshrc`) by hand.

Inside Claude Code, run any namespaced command to confirm the plugin layer is wired:

```
/exarchos:ideate
```

If a design exploration session starts, the plugin and MCP server are both attached.

## Migrate from v2.8

If you're already running the v2.8.x plugin, the v2.9 model is different in two ways: the runtime is a self-contained binary instead of a Node bundle, and the plugin invokes that binary from PATH instead of shelling into a vendored `dist/exarchos.js`. Migration is three commands plus a restart.

```bash
# 1. (Optional) Drop a v2.8 npm-global if you ever installed one. Harmless to skip if you didn't.
npm uninstall -g @lvlup-sw/exarchos

# 2. Install the v2.9 binary on PATH.
curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh | bash

# 3. Open a new shell so PATH refreshes; verify.
exarchos --version       # 2.9.0-rc.1
exarchos doctor
```

Then inside Claude Code:

```
/plugin marketplace update
/plugin update exarchos@lvlup-sw
```

Restart Claude Code so the new plugin manifest (which expects bare `exarchos` on PATH) takes effect. Run `/exarchos:ideate` to confirm the MCP server attached and commands resolve.

Workflow state at `~/.exarchos/state/` is forward-compatible — the v2.9 binary reads existing event-log JSONL untouched, and the rehydration projection materializes from those events on first read. No data migration needed.

If the plugin update lands before the binary install, MCP server registration and the eight lifecycle hooks fail with `exarchos: command not found` until you complete step 2 and restart. Order matters here.

## Update

The bootstrap installers are idempotent — re-run the same one-liner and the new binary atomically replaces the old one. SHA-512 verification guards against partial writes.

```bash
curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh | bash
```

For the plugin layer, Claude Code's marketplace handles updates:

```
/plugin marketplace update
/plugin update exarchos@lvlup-sw
```

To roll back to a specific older release, pass `--version` with the older tag:

```bash
curl -fsSL https://lvlup-sw.github.io/exarchos/get-exarchos.sh | bash -s -- --version v2.8.3
```

## Uninstall

```bash
# Unix
rm ~/.local/bin/exarchos

# Windows (PowerShell)
Remove-Item "$env:LOCALAPPDATA\Microsoft\WindowsApps\exarchos.exe"
```

The bootstrap script appended a marker block to your shell rc files (`# Added by get-exarchos.sh — do not edit this block manually`). You can remove that block by hand if you want a fully clean uninstall; nothing else lingers.

For the plugin:

```
/plugin uninstall exarchos@lvlup-sw
```

Workflow state at `~/.exarchos/state/` (event log, snapshots, sqlite) is left untouched on uninstall — `rm -rf ~/.exarchos` removes it explicitly.

## Development setup

For contributing to Exarchos itself:

```bash
git clone https://github.com/lvlup-sw/exarchos.git && cd exarchos
npm install && npm run build
claude --plugin-dir .
```

`--plugin-dir .` tells Claude Code to load the plugin from your local checkout instead of the marketplace version. The build step produces five cross-compiled binaries under `dist/bin/`; the plugin manifest expects bare `exarchos` on PATH, so you'll want to symlink one of them:

```bash
ln -sf "$PWD/dist/bin/exarchos-linux-x64" ~/.local/bin/exarchos
```

Requires Node.js >= 20.

## See also

- [First workflow](/guide/first-workflow) — start an `/ideate` session and walk through the full lifecycle.
- [Core concepts](/learn/core-concepts) — durable state, phase enforcement, agent teams.
- [Configuration](/reference/configuration) — environment variables, state directory layout, MCP server tuning.
- [GitHub Releases](https://github.com/lvlup-sw/exarchos/releases) — full changelog, binary assets, SHA-512 checksums.
