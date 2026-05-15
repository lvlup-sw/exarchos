# Bug: `exarchos install-skills --agent copilot` installs the wrong skill bundle

**Version:** `exarchos` v2.10.0-preview.2 (Windows x64, installed via `get-exarchos.ps1`)
**Repo tag:** [v2.10.0-preview.2](https://github.com/lvlup-sw/exarchos/releases/tag/v2.10.0-preview.2) (commit `7a878e4`)
**Severity:** High — the documented install path silently produces an unusable Copilot installation.

## Summary

`exarchos install-skills --agent copilot` installs **1 skill** (`design-invariants`, sourced from `.claude/skills/`) instead of the **17 skills** under `skills/copilot/` that the repository ships for the GitHub Copilot CLI runtime.

The wrong skill is the only thing the user gets; none of the workflow skills (`brainstorming`, `debug`, `delegation`, `implementation-planning`, `workflow-state`, `quality-review`, `synthesis`, etc.) are installed, so all `/ideate`-style workflows and slash commands are non-functional after a fresh install. The command exits 0 with a "success" banner, so the failure is silent.

## Reproduction

Fresh Windows host, no prior exarchos install:

```powershell
# 1. Install the binary
irm https://lvlup-sw.github.io/exarchos/get-exarchos.ps1 | iex
exarchos --version          # 2.10.0-preview.2

# 2. Install the skill bundle for GitHub Copilot CLI
exarchos install-skills --agent copilot

# 3. Inspect what was installed
Get-ChildItem ~/.agents/skills -Directory | Select-Object Name
```

Expected: 17 directories (`brainstorming`, `cleanup`, `debug`, `delegation`, `discovery`, `dogfood`, `git-worktrees`, `implementation-planning`, `merge-orchestrator`, `oneshot-workflow`, `prune-workflows`, `quality-review`, `refactor`, `shepherd`, `spec-review`, `synthesis`, `workflow-state`).

Actual: 1 directory (`design-invariants`).

## Trimmed install output

```
Running: npx --yes skills add github:lvlup-sw/exarchos --skill * --agent github-copilot -y -g --copy
…
◇  Found 1 skill
●  Installing all 1 skills
…
◇  Installed 1 skill
│  ✓ design-invariants (copied)
│    → ~\.agents\skills\design-invariants
```

## Root cause

`exarchos install-skills --agent copilot` shells out to `npx skills add github:lvlup-sw/exarchos --skill * --agent github-copilot`. The third-party `skills` CLI:

1. Clones the repo,
2. Walks the tree looking for any `SKILL.md` file,
3. Filters by an `agents:` frontmatter field on each `SKILL.md`.

Two things go wrong:

1. **Wrong source tree.** It picks up `.claude/skills/design-invariants/SKILL.md` — an *internal* skill that is part of the exarchos project's own Claude Code workspace, not a user-facing bundle. Per-runtime bundles live under `skills/copilot/`, `skills/claude/`, etc., and the installer never points at the right subtree.
2. **Frontmatter mismatch.** The 17 skills under `skills/copilot/*/SKILL.md` declare `metadata: { author: exarchos, mcp-server: exarchos, … }` but **do not declare an `agents:` field**. The `skills add … --agent github-copilot` filter therefore excludes all of them. Only `design-invariants` (an internal skill that happens to satisfy the filter) survives.

Net result: the installer ships a bundle that doesn't intersect the runtime-targeted bundle the maintainers actually authored.

## Workaround

Until the installer is fixed, users can manually drop the right tree in place:

```powershell
$tmp = Join-Path $env:TEMP "exarchos-tag"
git clone --depth 1 --branch v2.10.0-preview.2 https://github.com/lvlup-sw/exarchos.git $tmp
$dst = "$env:USERPROFILE\.agents\skills"
Get-ChildItem (Join-Path $tmp 'skills\copilot') -Directory | ForEach-Object {
  $target = Join-Path $dst $_.Name
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  Copy-Item $_.FullName $target -Recurse
}
Remove-Item $tmp -Recurse -Force
```

This restores the 17-skill bundle byte-identically with what the repo ships.

## Suggested fixes

Pick whichever fits the project's direction:

1. **Stop delegating to `skills add` for runtimes that don't speak its frontmatter.** For `--agent copilot|generic|opencode`, do an in-process copy from `skills/<runtime>/` into `~/.agents/skills/`, mirroring what the repo already lays out on disk. The bundling logic is essentially `cp -r`.
2. **Teach `skills add` where the runtime tree lives.** Pass a path filter so it only walks `skills/copilot/` instead of the whole repo. This avoids picking up internal `.claude/skills/` content.
3. **Add the `agents:` frontmatter field to every `SKILL.md` under `skills/<runtime>/`**, declaring the matching runtime. Cheapest fix; keeps the `skills add` delegation but makes its filter actually match.
4. **Validate post-install.** After `install-skills` completes, compare the installed set against the expected runtime bundle in the repo and fail loudly (non-zero exit, summary diff) if they don't match. The current "Installed 1 skill" success banner hid the bug end-to-end.

## Side observations

- `--yes` / `-y` is documented in the upstream `skills` CLI help but is not accepted by `exarchos install-skills` (`error: unknown option '--yes'`). Either pass it through or document the difference.
- `exarchos install-skills --help` is silent about which directory it writes to. Mentioning `~/.agents/skills/` (and how it's chosen per runtime) would help users diagnose this kind of issue without strace-style debugging.
- Bonus repro: `--agent claude` and `--agent generic` likely have the same problem against the matching `skills/<runtime>/` subtrees, since the root cause is the discovery filter, not anything Copilot-specific. Worth verifying as part of the fix.

## Environment

- OS: Windows 11 24H2 (Windows_NT)
- Shell: PowerShell 7
- Node: v24.3.0
- exarchos: 2.10.0-preview.2 (Bun-bundled, `bin/exarchos.exe`)
- Install dir: `C:\Users\<user>\.exarchos\bin`
- Skills dir: `C:\Users\<user>\.agents\skills`
- `exarchos doctor`: 6 pass / 2 unrelated warnings / 0 fail
