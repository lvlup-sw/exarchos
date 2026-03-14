# Installation

## From the Claude Code marketplace

This is the recommended path. Two commands, nothing to configure.

```bash
# Add the lvlup-sw marketplace
/plugin marketplace add lvlup-sw/.github

# Install Exarchos
/plugin install exarchos@lvlup-sw
```

The lvlup-sw marketplace is hosted in the [lvlup-sw/.github](https://github.com/lvlup-sw/.github) org repo. All LevelUp Software plugins are listed there.

### Other plugins from lvlup-sw

```bash
# Backend code quality skills
/plugin install axiom@lvlup-sw
```

### What gets installed

Exarchos installs:

- The Exarchos MCP server (workflow state, event log, team coordination)
- All workflow commands (`/exarchos:ideate`, `/exarchos:debug`, `/exarchos:refactor`, etc.)
- Lifecycle hooks (session start, pre-compact, convergence gates)
- Validation scripts (deterministic bash checks, not prose checklists)

No additional configuration required. The plugin handles MCP server registration and command setup automatically.

## Migrating from an earlier install

If you previously added the marketplace with `/plugin marketplace add lvlup-sw/exarchos`, it pointed at a `marketplace.json` that no longer exists in the exarchos repo. To migrate:

```bash
# Remove the old marketplace reference
/plugin marketplace remove lvlup-sw

# Add the new one from the org repo
/plugin marketplace add lvlup-sw/.github

# Update your installed plugins
/plugin marketplace update
```

Your installed plugins remain intact. Only the marketplace pointer changes.

## Dev companion (optional)

The dev companion adds three additional MCP servers for code analysis and documentation lookup:

```bash
npx @lvlup-sw/exarchos-dev
```

This installs:

- Serena: semantic code analysis. Symbol navigation, reference finding, cross-file understanding.
- Context7: up-to-date library documentation. Pulls current docs instead of relying on training data.
- Microsoft Learn: Azure and .NET documentation from the official Microsoft API.

These are optional. Exarchos works without them. They help when you need to navigate unfamiliar codebases or check library APIs during a workflow.

## Development setup

For contributing to Exarchos itself:

```bash
git clone https://github.com/lvlup-sw/exarchos.git && cd exarchos
npm install && npm run build
claude --plugin-dir .
```

The `--plugin-dir .` flag tells Claude Code to load the plugin from your local checkout instead of the marketplace version. Changes you make to commands, skills, or the MCP server take effect after a rebuild.

Requires Node.js >= 20.

## Verifying installation

After installing, start a new Claude Code session. Two things confirm a working install:

1. MCP server is connected. The `exarchos` MCP server should appear in your available tools. You can check by asking Claude to list its MCP tools.

2. Commands are available. Plugin commands are namespaced as `/exarchos:<command>`. Try running:

```bash
/exarchos:ideate
```

If it starts a design exploration session (asking what you want to build), the install is working.

You can also verify the lifecycle hooks are active by checking that Claude mentions discovering active workflows at session start. This happens automatically via the session-start hook.

## Next step

With Exarchos installed, walk through your first workflow: [First Workflow](/guide/first-workflow).
