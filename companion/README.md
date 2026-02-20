# @lvlup-sw/exarchos-dev

Developer convenience plugins for [Exarchos](https://github.com/lvlup-sw/exarchos) — the agent governance system for Claude Code.

## What It Does

Adds optional developer tooling to your Exarchos installation:

- **GitHub** plugin — PRs, issues, code search
- **Serena** plugin — Semantic code analysis
- **Context7** plugin — Up-to-date library documentation
- **Microsoft Learn** MCP — Official Azure/.NET docs

## Install

```bash
npx @lvlup-sw/exarchos-dev
```

Or with bun:

```bash
bunx @lvlup-sw/exarchos-dev
```

This enables the three Claude Code plugins in `~/.claude/settings.json` and registers the Microsoft Learn MCP server in `~/.claude.json`.

## Prerequisites

- [Exarchos](https://github.com/lvlup-sw/exarchos) installed (via marketplace or dev mode)
- Node.js >= 20

## License

Apache-2.0 — see [LICENSE](../LICENSE) for details.
