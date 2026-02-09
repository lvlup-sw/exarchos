# AGENTS.md

## Project Overview
Exarchos provides SDLC workflow automation for Claude Code. It contains workflow automation skills, commands, rules, and MCP plugins for the lvlup-sw organization.

## Tech Stack
- Language: TypeScript, Bash, Markdown
- Runtime: Node.js, Bun
- Tools: Claude Code CLI

## Code Organization
- `skills/` - Workflow automation skills (brainstorming, delegation, integration, etc.)
- `hooks/` - Git and Claude Code hooks
- `rules/` - Global rules and coding standards
- `scripts/` - Utility scripts for workflow management

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
