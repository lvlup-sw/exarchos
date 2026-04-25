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
