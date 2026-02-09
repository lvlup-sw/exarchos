# AGENTS.md

## Project Overview
Exarchos provides SDLC workflow automation for Claude Code. It contains workflow automation skills, commands, rules, and MCP plugins for the lvlup-sw organization.

## Tech Stack
- Language: TypeScript, Bash, Markdown
- Runtime: Node.js, Bun
- Tools: Claude Code CLI

## Code Organization
- `commands/` - Slash commands (`/ideate`, `/plan`, `/delegate`, etc.)
- `skills/` - Workflow automation skills (brainstorming, delegation, integration, etc.)
- `rules/` - Global rules and coding standards
- `scripts/` - Utility scripts for workflow management
- `plugins/exarchos/` - Unified MCP server (workflow state, events, CQRS views, team coordination)
- `plugins/jules/` - Optional Jules autonomous coding agent integration

## Security Considerations
- No secrets stored in repository
- Configuration templates use environment variables
- MCP server configurations may reference external services

## Known Tech Debt
- None acknowledged

## Scan Preferences
- Focus areas: Security vulnerabilities, code quality, outdated patterns
- Ignore patterns: `node_modules/`, `.git/`, `*.log`
- Severity threshold: Report Medium and above
