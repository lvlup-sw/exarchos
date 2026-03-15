# Deprecation: @lvlup-sw/exarchos-dev

**Deprecated:** 2026-03-14
**Replaced by:** `npx create-exarchos`

## Release checklist

1. Publish final `@lvlup-sw/exarchos-dev` version with:
   - Deprecation notice printed to stderr
   - Passthrough to `npx create-exarchos`
2. Run: `npm deprecate @lvlup-sw/exarchos-dev "Use npx create-exarchos instead"`
3. Update any documentation referencing `npx @lvlup-sw/exarchos-dev`

## What changed

The `@lvlup-sw/exarchos-dev` package installed Serena, Context7, and Microsoft Learn as companion tools. This functionality is now part of `create-exarchos`, which also:

- Detects the user's environment (Claude Code, Cursor, other MCP clients, CLI)
- Offers all companions interactively (axiom, impeccable, serena, context7, microsoft-learn)
- Supports non-interactive mode for CI/scripting
- Installs Exarchos itself (not just companions)

## Content overlay assessment

The companion package provided two content overlay files that were symlinked into the main Exarchos content directories:

### `companion/rules/mcp-tool-guidance.md`

This rule guided agents to prefer MCP tools over CLI equivalents. The content is still relevant but was companion-specific (referencing Serena, Context7, GitHub MCP, Microsoft Learn). Since these companions are now installed via `create-exarchos`, the rule content should be managed per-companion rather than as a monolithic overlay. No action needed -- the rule was only present in `companion/rules/` and did not exist in the core `rules/` directory.

### `companion/skills/workflow-state/references/companion-mcp-reference.md`

This reference documented detailed tool mappings for all companion MCP servers. The content remains valuable as reference documentation but is now better served by per-companion skill references installed by `create-exarchos`. The core `skills/workflow-state/references/mcp-tool-reference.md` covers Exarchos MCP tools; companion-specific references are the responsibility of each companion's skill package.

## Migration

Users should run `npx create-exarchos` instead of `npx @lvlup-sw/exarchos-dev`.
